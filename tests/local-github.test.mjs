import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createGithubRefresher, RefreshError, parseRepositoryList, GRAPHQL_RESERVE } from '../scripts/local-github-refresh.mjs';
import { planningQuery } from '../scripts/github-planning-fetch.mjs';
import { createProgressServer } from '../server.mjs';
import { REFRESH_INTERVAL_MS, setLocalRepositories, createLocalGithubClient, applyRefreshedSnapshot, refreshTargets, isLocalRuntime } from '../dist/local-github.mjs';
import { buildSnapshot, repositoryKey, MAX_IMPORT_BYTES } from '../dist/github-snapshot.mjs';
import { STORAGE_KEY, BACKUP_KEY, createWorkspaceStore } from '../dist/workspace.mjs';
import { qaWorkspace, restFixture, mockGh, hierarchyFixture, QA_REPOSITORIES } from './local-github-fixture.mjs';

const repo = QA_REPOSITORIES[2], key = repositoryKey(repo);
const snapshot = (url = repo, at = new Date().toISOString(), version = 1) => buildSnapshot({ repositoryUrl: url, fetchedAt: at, ...restFixture(url, version) });
class Storage {
  values = new Map(); failKey = null;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (key === this.failKey) throw new Error('QuotaExceededError'); this.values.set(key, value); }
}
function savedWorkspace() {
  const storage = new Storage(); storage.setItem(STORAGE_KEY, JSON.stringify(qaWorkspace()));
  return { storage, store: createWorkspaceStore(storage) };
}

test('ローカルghは設定したrepositoryのREST GETとGraphQL queryだけ。shell・対話・別hostnameを使わない', async () => {
  const calls = [];
  const refresher = createGithubRefresher({ repositories: QA_REPOSITORIES, run: mockGh({ beforeRead: async (command, args, options) => {
    calls.push(args); assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
    if (args[3] === 'graphql') { assert.equal(args[4], '-f'); assert.match(args[5], /^query=query \{/); assert.ok(!args[5].includes('mutation')); }
    else { assert.deepEqual(args.slice(3, 5), ['--method', 'GET']); assert.match(args.at(-1), /^repos\/qa-local\/board\/(issues|pulls|milestones)\?state=all&per_page=100&sort=(updated&direction=desc|due_on&direction=asc)&page=1$/); }
    assert.equal(options.shell, false); assert.equal(options.env.GH_HOST, 'github.com'); assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    assert.equal(options.killSignal, 'SIGKILL'); assert.equal(options.timeout, 20000); assert.ok(options.signal);
  } }) });
  const result = await refresher.refresh(key);
  assert.equal(result.items.length, 2); assert.equal(result.repositoryUrl, repo); assert.equal(result.items[0].estimatePoints, null);
  assert.equal(calls.length, 4);
  for (const bad of ['evil/repo', `${key};echo secret`, `${key}/issues`, repo.replace('qa-local', 'QA-Local'), 'qa-local/board']) await assert.rejects(refresher.refresh(bad), { code: 'forbidden' });
  assert.equal(calls.length, 4);
});

test('100件のページを最後まで読む。欠落・重複・Issue/PR不一致・上限を拒否する', async () => {
  const calls = [], first = Array.from({ length: 100 }, (_, i) => ({ ...restFixture(repo).issuePages[0][0], number: i + 1, html_url: `${repo}/issues/${i + 1}` }));
  const run = async (_, args) => { const route = args.at(-1); calls.push(route); if (args[3] === 'graphql') return { stdout: JSON.stringify(hierarchyFixture(first)) }; return { stdout: JSON.stringify(route.includes('/issues?') && route.endsWith('page=1') ? first : []) }; };
  const result = await createGithubRefresher({ repositories: QA_REPOSITORIES, run }).refresh(key);
  assert.equal(result.items.length, 100); assert.equal(result.sources.issues.urls.length, 2); assert.equal(calls.length, 5);
  for (const data of [{}, [...first, first[0]], [first[0], first[0]], [{ number: 8, pull_request: {} }]]) {
    const invalid = createGithubRefresher({ repositories: QA_REPOSITORIES, run: async (_, args) => ({ stdout: JSON.stringify(args.at(-1).includes('/issues?') ? data : []) }) });
    await assert.rejects(invalid.refresh(key), { code: 'invalid_snapshot' });
  }
  let pages = 0;
  await assert.rejects(createGithubRefresher({ repositories: QA_REPOSITORIES, run: async () => { pages++; return { stdout: JSON.stringify(first) }; } }).refresh(key), { code: 'invalid_snapshot' });
  assert.equal(pages, 50);
});

test('同repoの同時要求を共有し15秒再利用。別repoはbusy。失敗後は取得を再開できる', async () => {
  let release, calls = 0, clock = Date.now(), fail = false;
  const gate = new Promise(resolve => { release = resolve; });
  const refresher = createGithubRefresher({ repositories: QA_REPOSITORIES, now: () => clock, run: mockGh({ beforeRead: async () => { calls++; await gate; if (fail) throw new Error('SECRET stderr'); } }) });
  const first = refresher.refresh(key), second = refresher.refresh(key);
  assert.equal(first, second);
  await assert.rejects(refresher.refresh(repositoryKey(QA_REPOSITORIES[0])), { code: 'busy' });
  release(); const value = await first;
  assert.equal(await refresher.refresh(key), value); assert.equal(calls, 4);
  clock += 15001; fail = true;
  await assert.rejects(refresher.refresh(key), error => error.code === 'gh_failed' && !error.message.includes('SECRET'));
  fail = false; assert.ok((await refresher.refresh(key)).fetchedAt > value.fetchedAt);
});

test('GraphQLは残りポイントを求め、入れ子の接続の上限を下げてコストを抑える', () => {
  const query = planningQuery(repo);
  assert.match(query, /^query \{ rateLimit \{ remaining resetAt \} repository\(/);
  // コストは入れ子の接続の親の件数の積で決まる。上限を戻すと、1回の取得が73ポイントに戻る。
  assert.ok(query.includes('blockedBy(first:20)')); assert.ok(query.includes('projectItems(first:10)'));
  assert.ok(!query.includes('mutation'));
});

test('残りポイントが下限を下回る間は、ghを呼ばず取得を止め、リセット後に再開する', async () => {
  let clock = Date.now(), calls = 0, remaining = GRAPHQL_RESERVE - 1;
  // snapshotの取得日時は実時刻より5分を超えて未来にできないため、模擬の時計は2分しか進めない。
  const resetAt = clock + 2 * 60 * 1000;
  const refresher = createGithubRefresher({ repositories: QA_REPOSITORIES, now: () => clock, run: mockGh({
    beforeRead: async () => { calls++; }, rateLimit: () => ({ remaining, resetAt: new Date(resetAt).toISOString() }),
  }) });
  const value = await refresher.refresh(key); assert.equal(calls, 4);
  assert.equal(await refresher.refresh(key), value); assert.equal(calls, 4);
  clock += 15001;
  for (const target of [key, repositoryKey(QA_REPOSITORIES[0])]) {
    await assert.rejects(refresher.refresh(target), error => error.code === 'rate_limited' && error.resetAt === resetAt);
  }
  assert.equal(calls, 4);
  clock = resetAt - 1; await assert.rejects(refresher.refresh(key), { code: 'rate_limited' }); assert.equal(calls, 4);
  clock = resetAt; remaining = 4000;
  assert.ok((await refresher.refresh(key)).fetchedAt > value.fetchedAt); assert.equal(calls, 8);
  clock += 15001; await refresher.refresh(key); assert.equal(calls, 12);
});

test('残りポイントが下限ちょうどなら取得し、下限未満の応答がなければ止めない', async () => {
  for (const rateLimit of [() => ({ remaining: GRAPHQL_RESERVE, resetAt: new Date(Date.now() + 3600 * 1000).toISOString() }), () => undefined, () => ({ remaining: 'many', resetAt: 'soon' })]) {
    let clock = Date.now(), calls = 0;
    const refresher = createGithubRefresher({ repositories: QA_REPOSITORIES, now: () => clock, run: mockGh({ beforeRead: async () => { calls++; }, rateLimit }) });
    await refresher.refresh(key); clock += 15001; await refresher.refresh(key); assert.equal(calls, 8);
  }
});

test('取得の途中で残りが下限を下回ったら、次のページを取得せず止める', async () => {
  let graphql = 0;
  const remainingAfter = [GRAPHQL_RESERVE + 50, GRAPHQL_RESERVE - 20];
  const run = async (_, args) => {
    if (args[3] === 'graphql') {
      graphql++;
      const cursor = args.at(-1).match(/after:"page(\d+)"/), page = cursor ? Number(cursor[1]) + 1 : 1;
      const data = hierarchyFixture(Array.from({ length: 100 }, (_, i) => ({ ...restFixture(repo).issuePages[0][0], number: (page - 1) * 100 + i + 1, html_url: `${repo}/issues/${(page - 1) * 100 + i + 1}` })),
        { remaining: remainingAfter[page - 1] ?? 0, resetAt: new Date(Date.now() + 3600 * 1000).toISOString() });
      data.data.repository.issues.totalCount = 300; data.data.repository.issues.pageInfo = { hasNextPage: page < 3, endCursor: 'page' + page };
      return { stdout: JSON.stringify(data) };
    }
    const url = new URL(`https://api.github.com/${args.at(-1)}`), page = Number(url.searchParams.get('page'));
    return { stdout: JSON.stringify(url.pathname.endsWith('/issues') && page <= 3 ? Array.from({ length: 100 }, (_, i) => ({ ...restFixture(repo).issuePages[0][0], number: (page - 1) * 100 + i + 1, html_url: `${repo}/issues/${(page - 1) * 100 + i + 1}` })) : []) };
  };
  await assert.rejects(createGithubRefresher({ repositories: QA_REPOSITORIES, run }).refresh(key), { code: 'rate_limited' });
  assert.equal(graphql, 2);
});

test('gh不在・コマンド失敗・総timeout・実subprocess timeoutを安全なエラーにする', async () => {
  for (const [error, code] of [[Object.assign(new Error('SECRET'), { code: 'ENOENT' }), 'gh_unavailable'], [new Error('SECRET'), 'gh_failed']]) {
    await assert.rejects(createGithubRefresher({ repositories: QA_REPOSITORIES, run: async () => { throw error; } }).refresh(key), { code });
  }
  const hanging = async (_, __, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('SECRET'), { name: 'AbortError' })), { once: true }));
  await assert.rejects(createGithubRefresher({ repositories: QA_REPOSITORIES, run: hanging, timeoutMs: 20 }).refresh(key), { code: 'timeout' });
  const runProcess = promisify(execFile);
  await assert.rejects(createGithubRefresher({ repositories: QA_REPOSITORIES, commandTimeoutMs: 30, run: (_, __, options) => runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options) }).refresh(key), { code: 'timeout' });
});

test('生REST応答20MiBと検証済みsnapshot 5MiBの上限を超えた結果を返さない', async () => {
  await assert.rejects(createGithubRefresher({ repositories: QA_REPOSITORIES, run: async () => ({ stdout: 'x'.repeat(20 * 1024 * 1024 + 1) }) }).refresh(key), { code: 'invalid_snapshot' });
  const run = async (_, args) => {
    if (args[3] === 'graphql') {
      const cursor = args.at(-1).match(/after:"page(\d+)"/), page = cursor ? Number(cursor[1]) + 1 : 1;
      const records = Array.from({ length: 100 }, (_, i) => { const number = (page - 1) * 100 + i + 1; return { ...restFixture(repo).issuePages[0][0], number, html_url: `${repo}/issues/${number}` }; });
      const data = hierarchyFixture(records); data.data.repository.issues.totalCount = 4800;
      data.data.repository.issues.pageInfo = { hasNextPage: page < 48, endCursor: 'page' + page };
      return { stdout: JSON.stringify(data) };
    }
    const url = new URL(`https://api.github.com/${args.at(-1)}`), page = Number(url.searchParams.get('page'));
    const items = url.pathname.endsWith('/issues') && page <= 48 ? Array.from({ length: 100 }, (_, i) => {
      const number = (page - 1) * 100 + i + 1;
      return { ...restFixture(repo).issuePages[0][0], number, html_url: `${repo}/issues/${number}`, title: 'Q'.repeat(1000) };
    }) : [];
    return { stdout: JSON.stringify(items) };
  };
  await assert.rejects(createGithubRefresher({ repositories: QA_REPOSITORIES, run }).refresh(key), { code: 'invalid_snapshot' });
});

test('起動portを整数範囲に限定し、外部host指定や不正値で待ち受けない', async () => {
  for (const port of ['0', '-1', '1.5', '', '65536', '4319;echo SECRET', '0.0.0.0:4319']) {
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env: { ...process.env, PORT: port }, encoding: 'utf8' }), error => error.code === 1 && error.stderr.includes('PORTは1〜65535') && !error.stdout);
  }
});

test('自動更新は手動計画・選択・他repoを保持し、Closedをdoneにせず再読込できる', () => {
  const { storage, store } = savedWorkspace(), before = store.snapshot(), value = snapshot();
  store.transact(workspace => assert.equal(applyRefreshedSnapshot(workspace, value, ['progress']), 1));
  const after = createWorkspaceStore(storage).snapshot();
  assert.equal(after.selectedProjectId, before.selectedProjectId);
  after.projects.forEach((project, index) => assert.deepEqual(project.data, before.projects[index].data));
  assert.equal(after.projects[0].githubSnapshot.projectId, 'progress'); assert.equal(after.projects[0].githubSnapshot.items.find(item => item.kind === 'issue').state, 'closed');
  assert.equal(after.projects[0].data.tasks[0].status, 'todo');
  assert.deepEqual(after.projects.slice(1), before.projects.slice(1));
  assert.equal(applyRefreshedSnapshot(after, value, ['progress']), 0);
  const reordered = Object.fromEntries(Object.entries(value).reverse()); assert.equal(applyRefreshedSnapshot(after, reordered, ['progress']), 0);
  const altered = structuredClone(value); altered.items[0].title = '違う内容';
  assert.throws(() => applyRefreshedSnapshot(after, altered, ['progress']), /取得日時/);
  assert.throws(() => applyRefreshedSnapshot(after, value, ['alpha']), /一致/);
  assert.throws(() => applyRefreshedSnapshot(after, value, ['progress', 'progress']), /取込先/);
  assert.throws(() => applyRefreshedSnapshot(after, { ...value, projectId: 'progress' }, ['progress']), /取込先/);
});

test('同repoの複数登録へprojectId別に保存し、一件の巻戻りでは全件を保全する', () => {
  const workspace = qaWorkspace(), duplicate = structuredClone(workspace.projects[0]);
  duplicate.id = 'duplicate'; for (const entities of Object.values(duplicate.data)) if (Array.isArray(entities)) for (const entity of entities) if (entity && typeof entity === 'object') entity.projectId = duplicate.id;
  workspace.projects.push(duplicate); const value = snapshot();
  const targets = refreshTargets(workspace, key); assert.deepEqual(targets, ['progress', 'duplicate']);
  assert.equal(applyRefreshedSnapshot(workspace, value, targets), 2);
  assert.equal(duplicate.githubSnapshot.projectId, 'duplicate');
  const old = snapshot(repo, new Date(Date.now() - 1000).toISOString());
  delete workspace.projects[0].githubSnapshot; const before = structuredClone(workspace);
  assert.throws(() => applyRefreshedSnapshot(workspace, old, targets), /取得日時/);
  assert.deepEqual(workspace, before);
});

test('保存容量・backup失敗・別タブ・破損で手動データと旧snapshotを上書きしない', () => {
  for (const failKey of [STORAGE_KEY, BACKUP_KEY]) {
    const { storage, store } = savedWorkspace(), before = store.snapshot(), raw = storage.getItem(STORAGE_KEY);
    storage.failKey = failKey;
    assert.throws(() => store.transact(workspace => applyRefreshedSnapshot(workspace, snapshot(), ['progress'])), /保存できません/);
    assert.deepEqual(store.snapshot(), before); assert.equal(storage.getItem(STORAGE_KEY), raw);
  }
  const { storage, store } = savedWorkspace(), newer = createWorkspaceStore(storage);
  newer.transact(workspace => { workspace.projects[0].data.tasks[0].evidence = '別タブの証拠'; });
  const raw = storage.getItem(STORAGE_KEY);
  assert.throws(() => store.transact(workspace => applyRefreshedSnapshot(workspace, snapshot(), ['progress'])), /別のタブ/);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  storage.setItem(STORAGE_KEY, '{'); const broken = createWorkspaceStore(storage);
  assert.equal(broken.status().readOnly, true);
  assert.throws(() => broken.transact(workspace => applyRefreshedSnapshot(workspace, snapshot(), ['progress'])));
  assert.equal(storage.getItem(STORAGE_KEY), '{');
});

function clientHarness(overrides = {}) {
  const { store, storage } = savedWorkspace(); let writable = true, clock = Date.now(); const calls = [];
  const client = createLocalGithubClient({
    now: () => clock, getWorkspace: () => store.snapshot(), canRefresh: () => writable,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json(url.endsWith('local-github') ? { schemaVersion: 1, repositories: QA_REPOSITORIES, csrfToken: 'a'.repeat(64) } : snapshot(QA_REPOSITORIES.find(url => repositoryKey(url) === JSON.parse(options.body).repository))); },
    saveSnapshot: async (snapshot, targets) => { let count; store.transact(workspace => { count = applyRefreshedSnapshot(workspace, snapshot, targets); }); return count; },
    ...overrides,
  });
  return { client, store, storage, calls, setWritable: value => { writable = value; }, advance: delta => { clock += delta; } };
}

test('clientは登録済み固定repoだけ自動更新し、5分・再取得・未登録・readonlyを扱う', async () => {
  const h = clientHarness(); assert.equal(await h.client.connect(), true);
  await h.client.refresh(); assert.equal(h.calls.length, 4); assert.equal(h.store.snapshot().projects[3].githubSnapshot, undefined);
  const serialized = h.storage.getItem(STORAGE_KEY); assert.ok(!serialized.includes('csrfToken')); assert.ok(!serialized.includes('aaaaaaaa'));
  await h.client.refresh(); assert.equal(h.calls.length, 4);
  h.advance(REFRESH_INTERVAL_MS); await h.client.refresh(); assert.equal(h.calls.length, 7);
  await h.client.refresh({ force: true }); assert.equal(h.calls.length, 10);
  h.setWritable(false); await h.client.refresh({ force: true }); assert.equal(h.calls.length, 10);
  assert.equal(isLocalRuntime({ protocol: 'https:', hostname: 'site.example' }), false);
  assert.equal(isLocalRuntime({ protocol: 'http:', hostname: '127.0.0.1' }), true);
});

test('clientは取得中の手動変更と未保存入力を妨げず、取得後のreadonlyでは保存しない', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = clientHarness({ fetchImpl: async (url, options) => {
    if (url.endsWith('local-github')) return Response.json({ schemaVersion: 1, repositories: QA_REPOSITORIES, csrfToken: 'a'.repeat(64) });
    await gate; return Response.json(snapshot(QA_REPOSITORIES.find(url => repositoryKey(url) === JSON.parse(options.body).repository)));
  } });
  await h.client.connect(); const running = h.client.refresh(); assert.equal(h.client.refresh(), running);
  h.store.transact(workspace => { workspace.projects[0].data.tasks[0].evidence = '取得中の手動変更'; });
  h.setWritable(false); release(); await running;
  assert.equal(h.store.snapshot().projects[0].githubSnapshot, undefined); assert.equal(h.store.snapshot().projects[0].data.tasks[0].evidence, '取得中の手動変更');
  assert.equal(h.client.state(key).phase, 'deferred');
});

test('clientは取得中に登録した別repoを、定期更新を待たず順に取得する', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), reading = new Promise(resolve => { started = resolve; });
  const reads = [];
  const h = clientHarness({ fetchImpl: async (url, options) => {
    if (url.endsWith('local-github')) return Response.json({ schemaVersion: 1, repositories: QA_REPOSITORIES, csrfToken: 'a'.repeat(64) });
    const requested = JSON.parse(options.body).repository; reads.push(requested);
    if (reads.length === 1) { started(); await gate; }
    return Response.json(snapshot(QA_REPOSITORIES.find(url => repositoryKey(url) === requested)));
  } });
  h.store.transact(workspace => { workspace.projects = workspace.projects.slice(0, 1); });
  await h.client.connect(); const running = h.client.refresh(); await reading;
  h.store.transact(workspace => { workspace.projects.push(qaWorkspace().projects[1]); });
  assert.equal(h.client.refresh(), running);
  release(); await running;
  assert.deepEqual(reads, [key, repositoryKey(QA_REPOSITORIES[0])]);
  assert.ok(h.store.snapshot().projects.every(project => project.githubSnapshot));
});

test('clientは取得中に増えた同repoのprojectIdへsnapshotを反映する', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), reading = new Promise(resolve => { started = resolve; });
  let reads = 0;
  const value = snapshot();
  const h = clientHarness({ fetchImpl: async url => {
    if (url.endsWith('local-github')) return Response.json({ schemaVersion: 1, repositories: QA_REPOSITORIES, csrfToken: 'a'.repeat(64) });
    reads++; if (reads === 1) { started(); await gate; }
    return Response.json(value);
  } });
  h.store.transact(workspace => { workspace.projects = workspace.projects.slice(0, 1); });
  await h.client.connect(); const running = h.client.refresh(); await reading;
  h.store.transact(workspace => {
    const duplicate = structuredClone(workspace.projects[0]); duplicate.id = 'duplicate';
    for (const entities of Object.values(duplicate.data)) if (Array.isArray(entities)) for (const entity of entities) if (entity && typeof entity === 'object') entity.projectId = duplicate.id;
    workspace.projects.push(duplicate);
  });
  h.client.refresh(); release(); await running;
  assert.equal(reads, 2);
  assert.deepEqual(h.store.snapshot().projects.map(project => project.githubSnapshot?.projectId), ['progress', 'duplicate']);
});

test('clientは取得中の明示的な再取得要求を一回にまとめ、完了前に処理する', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), reading = new Promise(resolve => { started = resolve; });
  let reads = 0;
  const value = snapshot();
  const h = clientHarness({ fetchImpl: async url => {
    if (url.endsWith('local-github')) return Response.json({ schemaVersion: 1, repositories: QA_REPOSITORIES, csrfToken: 'a'.repeat(64) });
    reads++; if (reads === 1) { started(); await gate; }
    return Response.json(value);
  } });
  h.store.transact(workspace => { workspace.projects = workspace.projects.slice(0, 1); });
  await h.client.connect(); const running = h.client.refresh(); await reading;
  assert.equal(h.client.refresh({ force: true }), running);
  assert.equal(h.client.refresh({ force: true }), running);
  assert.equal(h.client.refresh(), running);
  release(); await running;
  assert.equal(reads, 2);
  await h.client.refresh(); assert.equal(reads, 2);
});

test('clientは取得中の強制再取得で、要求後に取得を始めたrepoを取り直さない', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), reading = new Promise(resolve => { started = resolve; });
  const reads = [];
  const h = clientHarness({ fetchImpl: async (url, options) => {
    if (url.endsWith('local-github')) return Response.json({ schemaVersion: 1, repositories: QA_REPOSITORIES, csrfToken: 'a'.repeat(64) });
    const requested = JSON.parse(options.body).repository; reads.push(requested);
    if (reads.length === 1) { started(); await gate; }
    return Response.json(snapshot(QA_REPOSITORIES.find(url => repositoryKey(url) === requested)));
  } });
  await h.client.connect(); const running = h.client.refresh(); await reading;
  h.client.refresh({ force: true });
  release(); await running;
  assert.equal(reads.length, 4);
  assert.equal(new Set(reads.slice(0, 3)).size, 3);
  assert.equal(reads[3], reads[0]);
});

test('clientは最後の取得の直後に届いた登録後の要求を落とさない', async () => {
  const hop = (count, fn) => count ? queueMicrotask(() => hop(count - 1, fn)) : fn();
  for (let count = 0; count <= 8; count++) {
    let h, late = null;
    h = clientHarness({ saveSnapshot: async (value, targets) => {
      let saved; h.store.transact(workspace => { saved = applyRefreshedSnapshot(workspace, value, targets); });
      if (!late) hop(count, () => { h.store.transact(workspace => { workspace.projects.push(qaWorkspace().projects[1]); }); late = h.client.refresh(); });
      return saved;
    } });
    h.store.transact(workspace => { workspace.projects = workspace.projects.slice(0, 1); });
    await h.client.connect(); await h.client.refresh();
    while (!late) await null;
    await late;
    const refreshed = h.calls.filter(call => call.url.endsWith('/api/github/refresh')).map(call => JSON.parse(call.options.body).repository);
    assert.deepEqual(refreshed, [key, repositoryKey(QA_REPOSITORIES[0])], `microtask ${count}`);
  }
});

test('clientはHTTP失敗・異なるrepo・巨大応答・timeoutで既存計画を保持する', async () => {
  for (const response of [() => Response.json({ error: 'gh_failed' }, { status: 502 }), () => Response.json(snapshot('https://github.com/qa-fixture/other')), () => new Response('x'.repeat(MAX_IMPORT_BYTES + 1))]) {
    const h = clientHarness({ fetchImpl: async url => url.endsWith('local-github') ? Response.json({ schemaVersion: 1, repositories: QA_REPOSITORIES, csrfToken: 'a'.repeat(64) }) : response() });
    const before = h.storage.getItem(STORAGE_KEY); await h.client.connect(); await h.client.refresh();
    assert.equal(h.client.state(key).phase, 'error'); assert.equal(h.storage.getItem(STORAGE_KEY), before);
  }
  const h = clientHarness({ timeoutMs: 20, fetchImpl: async (url, options) => url.endsWith('local-github') ? Response.json({ schemaVersion: 1, repositories: QA_REPOSITORIES, csrfToken: 'a'.repeat(64) }) : new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort')))) });
  await h.client.connect(); await h.client.refresh(); assert.match(h.client.state(key).message, /時間内/);
});

test('clientは取得を止めている理由と再開の時刻を示し、既存計画を保持する', async () => {
  const resetAt = '2026-10-07T01:30:00.000Z', time = new Date(resetAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  for (const [body, expected] of [[{ error: 'rate_limited', resetAt }, `GitHubのAPIの残りが少ないため、${time}まで取得を止めています。`], [{ error: 'rate_limited' }, 'GitHubのAPIの残りが少ないため、取得を止めています。'], [{ error: 'rate_limited', resetAt: 'soon' }, 'GitHubのAPIの残りが少ないため、取得を止めています。']]) {
    const h = clientHarness({ fetchImpl: async url => url.endsWith('local-github') ? Response.json({ schemaVersion: 1, repositories: QA_REPOSITORIES, csrfToken: 'a'.repeat(64) }) : Response.json(body, { status: 429 }) });
    const before = h.storage.getItem(STORAGE_KEY); await h.client.connect(); await h.client.refresh();
    assert.equal(h.client.state(key).phase, 'error'); assert.ok(h.client.state(key).message.includes(expected), h.client.state(key).message);
    assert.equal(h.storage.getItem(STORAGE_KEY), before);
  }
  assert.match(time, /^\d{2}:\d{2}$/);
});

async function withServer(action, refresher = { refresh: async () => snapshot() }) {
  const server = createProgressServer({ repositories: QA_REPOSITORIES, refresher }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await action(origin, server); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test('HTTP APIはloopback Host、同origin、CSRF、JSON、固定repoを必須にする', async () => {
  let reads = 0;
  await withServer(async origin => {
    const configResponse = await fetch(`${origin}/api/local-github`, { headers: { 'X-Progress-Client': '1' } }), config = await configResponse.json();
    assert.equal(configResponse.headers.get('access-control-allow-origin'), null); assert.equal(configResponse.headers.get('cache-control'), 'no-store');
    const headers = { Origin: origin, 'X-Progress-CSRF': config.csrfToken, 'Content-Type': 'application/json' };
    const post = async (body, extra = {}, url = '/api/github/refresh', method = 'POST') => fetch(origin + url, { method, headers: { ...headers, ...extra }, ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    assert.equal((await post({ repository: key })).status, 200); assert.equal(reads, 1);
    for (const [body, extra, expected] of [
      [{ repository: key }, { Origin: 'https://attacker.example' }, 403], [{ repository: key }, { Origin: 'null' }, 403],
      [{ repository: key }, { Origin: '' }, 403], [{ repository: key }, { 'X-Progress-CSRF': 'b'.repeat(64) }, 403],
      [{ repository: key }, { 'Sec-Fetch-Site': 'cross-site' }, 403], [{ repository: key }, { 'Content-Type': 'text/plain' }, 415],
      [{ repository: 'evil/repo' }, {}, 400], [{ repository: key, command: 'echo secret' }, {}, 400],
      ['{', {}, 400], ['x'.repeat(257), {}, 413],
    ]) assert.equal((await post(body, extra)).status, expected);
    assert.equal((await post(null, {}, '/api/github/refresh', 'GET')).status, 405);
    assert.equal((await post(null, {}, '/api/github/refresh', 'OPTIONS')).status, 405);
    assert.equal((await post({ repository: key }, {}, '/api/github/refresh?repository=evil')).status, 403);
    assert.equal((await fetch(`${origin}/api/local-github`)).status, 403);
    assert.equal((await fetch(`${origin}/api/local-github`, { headers: { 'X-Progress-Client': '1', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal(reads, 1);
    const result = await new Promise(resolve => { http.get(origin, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); });
    assert.equal(result, 403);
    assert.equal((await fetch(`${origin}/`)).status, 200); assert.equal((await fetch(`${origin}/server.mjs`)).status, 404);
  }, { refresh: async () => { reads++; return snapshot(); } });
});

test('HTTP失敗はstderr・認証情報を出さず、再起動前のCSRFを拒否する', async () => {
  let oldToken;
  await withServer(async origin => { oldToken = (await (await fetch(`${origin}/api/local-github`, { headers: { 'X-Progress-Client': '1' } })).json()).csrfToken; });
  await withServer(async origin => {
    const token = (await (await fetch(`${origin}/api/local-github`, { headers: { 'X-Progress-Client': '1' } })).json()).csrfToken;
    assert.notEqual(token, oldToken);
    const post = csrf => fetch(`${origin}/api/github/refresh`, { method: 'POST', headers: { Origin: origin, 'X-Progress-CSRF': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: key }) });
    assert.equal((await post(oldToken)).status, 403); const response = await post(token);
    assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'gh_failed' });
  }, { refresh: async () => { const error = new RefreshError('gh_failed'); error.stderr = 'SECRET credential'; throw error; } });
});
test('HTTP APIは取得を止めているとき429と再開の時刻を返す', async () => {
  const resetAt = Date.parse('2026-10-07T01:30:00.000Z');
  await withServer(async origin => {
    const token = (await (await fetch(`${origin}/api/local-github`, { headers: { 'X-Progress-Client': '1' } })).json()).csrfToken;
    const response = await fetch(`${origin}/api/github/refresh`, { method: 'POST', headers: { Origin: origin, 'X-Progress-CSRF': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: key }) });
    assert.equal(response.status, 429); assert.deepEqual(await response.json(), { error: 'rate_limited', resetAt: '2026-10-07T01:30:00.000Z' });
  }, { refresh: async () => { throw new RefreshError('rate_limited', resetAt); } });
});

test('PROGRESS_GITHUB_REPOSは owner/repository とURLを受け付け、既定は空にする', () => {
  assert.deepEqual(parseRepositoryList(), []);
  assert.deepEqual(parseRepositoryList(' qa-local/alpha , https://github.com/qa-local/beta.git '), ['https://github.com/qa-local/alpha', 'https://github.com/qa-local/beta']);
  for (const bad of ['qa-local', 'https://example.com/a/b', 'qa-local/alpha,QA-LOCAL/alpha', 'a/b/c']) assert.throws(() => parseRepositoryList(bad));
});

test('許可される最大50件のrepository設定を、URLの上限でも接続できる', async () => {
  try {
    for (const length of [100, 500]) {
      const prefix = 'https://github.com/qa-limit/';
      const repositories = parseRepositoryList(Array.from({ length: 50 }, (_, i) => prefix + 'r'.repeat(length - prefix.length - 3) + '-' + String(i).padStart(2, '0')).join(','));
      const config = { schemaVersion: 1, repositories, csrfToken: 'a'.repeat(64) };
      assert.ok(Buffer.byteLength(JSON.stringify(config)) > 4096);
      const client = createLocalGithubClient({ fetchImpl: async () => Response.json(config), getWorkspace: () => ({ projects: [] }), canRefresh: () => true, saveSnapshot: () => 0 });
      assert.equal(await client.connect(), true);
      assert.equal(client.state(repositoryKey(repositories[49])).available, true);
    }
    assert.throws(() => parseRepositoryList(Array.from({ length: 51 }, (_, i) => 'qa-limit/repo-' + i).join(',')), /50件/);
  } finally { setLocalRepositories(QA_REPOSITORIES); }
});
