import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateSnapshot, parseSnapshotImport, attachSnapshot, snapshotIdentity, snapshotAge, githubStateLabel, buildSnapshot, MAX_IMPORT_BYTES, approvalQueue, approvalState, isApprovalLimit, projectApprovalLimit, APPROVAL_LIMIT } from '../dist/github-snapshot.mjs';
import { emptyWorkspace, registerProject, addGoal, addTask, importSnapshots, createWorkspaceStore, validateWorkspace, STORAGE_KEY, BACKUP_KEY } from '../dist/workspace.mjs';
import { collectPages, main } from '../scripts/fetch-github-snapshot.mjs';
const at = '2026-10-02T12:00:00Z';
const repositoryUrl = 'https://github.com/qa-fixture/alpha';
import { fixture } from './snapshot-fixture.mjs';

class Storage {
  values = new Map(); failKey = null; writes = [];
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (key === this.failKey) throw new Error('QuotaExceededError'); this.values.set(key, value); this.writes.push(key); }
}
function manualWorkspace() {
  const workspace = emptyWorkspace();
  for (const [id, repo] of [['alpha', repositoryUrl], ['beta', 'https://github.com/qa-fixture/beta']]) {
    const project = registerProject(workspace, { name: id, repositoryUrl: repo }, () => id);
    addGoal(project.data, id, { title: '手動の目標' }, () => 'goal');
    addTask(project.data, id, { title: '手動の作業', goalId: 'goal', issueNumber: 7, status: 'todo', criteria: ['受入確認'] }, () => 'task');
    project.data.tasks[0].evidence = `${id}の手動根拠`;
  }
  return workspace;
}
test('既存v1データを変更せず、GitHub factsだけを別領域へ保存・再読込する', () => {
  const storage = new Storage(), store = createWorkspaceStore(storage), original = manualWorkspace();
  store.transact(workspace => Object.assign(workspace, original));
  const before = store.snapshot();
  store.transact(workspace => importSnapshots(workspace, [fixture()], [{ projectId: 'alpha' }]));
  const restored = createWorkspaceStore(storage).snapshot();
  assert.deepEqual(restored.projects[0].data, before.projects[0].data);
  assert.deepEqual(restored.projects[1], before.projects[1]);
  assert.equal(restored.selectedProjectId, before.selectedProjectId);
  assert.equal(restored.projects[0].githubSnapshot.projectId, 'alpha');
  assert.equal(restored.projects[0].data.tasks[0].status, 'todo');
  assert.equal(githubStateLabel(restored.projects[0].githubSnapshot.items[1]), 'Merged');
  assert.ok(restored.projects[0].githubSnapshot.items.every(item => item.estimatePoints === null && item.deadline === null));
});
test('新しいrepositoryは実snapshotと空の手動計画で登録し、同番号を混同しない', () => {
  const workspace = emptyWorkspace(); let counter = 0;
  const snapshots = [fixture(), fixture('https://github.com/qa-fixture/beta')];
  importSnapshots(workspace, snapshots, [{ projectId: null, name: 'Alpha' }, { projectId: null, name: 'Beta' }], () => `project-${counter++}`);
  validateWorkspace(workspace);
  assert.equal(workspace.selectedProjectId, null);
  assert.ok(workspace.projects.every(project => project.data.tasks.length === 0 && project.data.goals.length === 0));
  assert.notEqual(snapshotIdentity(snapshots[0], snapshots[0].items[0]), snapshotIdentity(snapshots[1], snapshots[1].items[0]));
});
test('別repository・別projectId・危険な出典URL・番号不一致を拒否する', () => {
  const changes = [s => { s.items[0].url = 'https://github.com/qa-fixture/beta/issues/7'; },
    s => { s.items[0].url = `${repositoryUrl}/issues/8`; }, s => { s.items[0].url = 'javascript:alert(1)'; },
    s => { s.sources.issues.urls[0] = 'https://token@api.github.com/repos/qa-fixture/alpha/issues'; },
    s => { s.sources.issues.urls[0] = s.sources.issues.urls[0].replace('/alpha/', '/beta/'); },
    s => { s.sources.issues.urls[0] += '&token=secret'; }, s => { s.repositoryUrl += '?token=secret'; },
    s => { s.items[0].number = 0; }, s => { s.items[0].number = 1.5; }];
  for (const change of changes) { const candidate = fixture(); change(candidate); assert.throws(() => validateSnapshot(candidate)); }
  assert.throws(() => attachSnapshot(manualWorkspace().projects[1], fixture()), /別repository/);
  const workspace = manualWorkspace(); attachSnapshot(workspace.projects[0], fixture());
  workspace.projects[0].githubSnapshot.projectId = 'beta';
  assert.throws(() => validateWorkspace(workspace), /別プロジェクト/);
});
test('JSON・未知schema・重複repository・重複番号・部分取得・不明値の捏造を拒否する', () => {
  const changes = [s => { s.schemaVersion = 2; }, s => { s.source = 'manual'; },
    s => { s.items.push(structuredClone(s.items[0])); }, s => { s.items[0].estimatePoints = 3; },
    s => { s.items[0].deadline = '2026-11-01'; }, s => { s.items[0].status = 'done'; },
    s => { s.items[1].mergedAt = null; s.items[1].state = 'done'; }, s => { delete s.items[1].draft; },
    s => { s.items[1].number = 7; s.items[1].url = `${repositoryUrl}/pull/7`; },
    s => { s.sources.issues.complete = false; }, s => { s.sources.issues.urls[0] = s.sources.issues.urls[0].replace('page=1', 'page=2'); },
    s => { s.sources.issues.urls[0] = s.sources.issues.urls[0].replace('state=all', 'state=open'); }];
  for (const change of changes) { const candidate = fixture(); change(candidate); assert.throws(() => parseSnapshotImport(JSON.stringify(candidate))); }
  assert.throws(() => parseSnapshotImport('{'));
  assert.throws(() => parseSnapshotImport(' '.repeat(MAX_IMPORT_BYTES + 1)), /5MiB/);
  assert.throws(() => parseSnapshotImport(JSON.stringify({ type: 'github-snapshot-bundle', schemaVersion: 1, snapshots: [fixture(), fixture(repositoryUrl.toUpperCase().replace('HTTPS://GITHUB.COM', 'https://github.com'))] })), /重複/);
  assert.throws(() => parseSnapshotImport(JSON.stringify({ ...fixture(), projectId: 'alpha' })), /projectId/);
});
test('未来・実在しない日付・矛盾したGitHub日時を拒否する', () => {
  const changes = [s => { s.fetchedAt = '2999-01-01T00:00:00Z'; }, s => { s.fetchedAt = '2026-02-30T12:00:00Z'; },
    s => { s.fetchedAt = '2026-10-02'; }, s => { s.items[0].updatedAt = '2026-10-03T12:00:00Z'; },
    s => { s.items[0].closedAt = '2026-10-01T11:00:00Z'; }, s => { s.items[1].closedAt = null; },
    s => { s.items[1].mergedAt = '2026-10-02T12:00:00Z'; }];
  for (const change of changes) { const candidate = fixture(); change(candidate); assert.throws(() => validateSnapshot(candidate)); }
});
test('同じ取得日時・古いsnapshot・巻き戻ったIssue更新を拒否し以前のsnapshotを保持する', () => {
  const storage = new Storage(), store = createWorkspaceStore(storage);
  store.transact(workspace => Object.assign(workspace, manualWorkspace()));
  store.transact(workspace => importSnapshots(workspace, [fixture()], [{ projectId: 'alpha' }]));
  const before = store.snapshot(), raw = storage.getItem(STORAGE_KEY);
  const candidates = [fixture(), fixture(repositoryUrl, '2026-10-01T12:00:00Z'), fixture(repositoryUrl, '2026-10-02T13:00:00Z')];
  candidates[2].items[0].updatedAt = '2026-10-01T11:00:00Z';
  for (const snapshot of candidates) {
    assert.throws(() => store.transact(workspace => importSnapshots(workspace, [snapshot], [{ projectId: 'alpha' }])));
    assert.deepEqual(store.snapshot(), before); assert.equal(storage.getItem(STORAGE_KEY), raw);
  }
  const newer = fixture(repositoryUrl, '2026-10-02T13:00:00Z'); newer.items[0].title = '更新したIssue';
  store.transact(workspace => importSnapshots(workspace, [newer], [{ projectId: 'alpha' }]));
  assert.equal(store.snapshot().projects[0].githubSnapshot.items[0].title, '更新したIssue');
  assert.deepEqual(store.snapshot().projects[0].data, before.projects[0].data);
});
test('bundleの一件失敗・容量不足・別タブ更新では全件を反映しない', () => {
  for (const failKey of [null, BACKUP_KEY, STORAGE_KEY]) {
    const storage = new Storage(), store = createWorkspaceStore(storage);
    store.transact(workspace => Object.assign(workspace, manualWorkspace()));
    const before = store.snapshot(), raw = storage.getItem(STORAGE_KEY);
    storage.failKey = failKey;
    const snapshots = [fixture(), fixture('https://github.com/qa-fixture/beta')];
    const targets = [{ projectId: 'alpha' }, { projectId: failKey ? 'beta' : 'alpha' }];
    assert.throws(() => store.transact(workspace => importSnapshots(workspace, snapshots, targets)));
    assert.deepEqual(store.snapshot(), before); assert.equal(storage.getItem(STORAGE_KEY), raw);
  }
  const storage = new Storage(), current = createWorkspaceStore(storage), stale = createWorkspaceStore(storage);
  current.transact(workspace => Object.assign(workspace, manualWorkspace()));
  const raw = storage.getItem(STORAGE_KEY);
  assert.throws(() => stale.transact(workspace => importSnapshots(workspace, [fixture()], [{ projectId: null, name: 'Alpha' }])), /別のタブ/);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
});
test('snapshot破損を読み込みで検出し原本を保持、有効backupの手動データだけを閲覧する', () => {
  const storage = new Storage(), store = createWorkspaceStore(storage);
  store.transact(workspace => Object.assign(workspace, manualWorkspace()));
  store.transact(workspace => importSnapshots(workspace, [fixture()], [{ projectId: 'alpha' }]));
  const broken = store.snapshot(); broken.projects[0].githubSnapshot.items[0].url = 'https://github.com/other/repo/issues/7';
  const raw = JSON.stringify(broken); storage.values.set(STORAGE_KEY, raw);
  const reloaded = createWorkspaceStore(storage);
  assert.equal(reloaded.status().readOnly, true);
  assert.deepEqual(reloaded.snapshot(), manualWorkspace());
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.throws(() => reloaded.transact(workspace => importSnapshots(workspace, [fixture()], [{ projectId: 'alpha' }])));
});
test('snapshotの古さは24時間から表示し、GitHubの各状態だけを扱う', () => {
  const snapshot = fixture();
  assert.equal(snapshotAge(snapshot, Date.parse(at) + 23 * 3600000).stale, false);
  assert.equal(snapshotAge(snapshot, Date.parse(at) + 24 * 3600000).stale, true);
  assert.match(snapshotAge(snapshot, Date.parse(at) + 24 * 3600000).label, /古いsnapshot/);
  assert.equal(githubStateLabel(snapshot.items[0]), 'Open');
  assert.equal(githubStateLabel({ ...snapshot.items[1], mergedAt: null }), 'Closed');
  assert.equal(githubStateLabel({ ...snapshot.items[1], mergedAt: null, state: 'open', draft: true }), 'Draft / Open');
});
test('サンプルbundleの3repository、件数、出典、PR状態を検証する。計画や完了を捏造しない', async () => {
  const snapshots = parseSnapshotImport(await readFile(new URL('../dist/github-snapshot.json', import.meta.url), 'utf8'));
  assert.deepEqual(snapshots.map(snapshot => [snapshot.repositoryUrl, snapshot.items.filter(item => item.kind === 'issue').length, snapshot.items.filter(item => item.kind === 'pull_request').length]),
    [['https://github.com/example/recipe-app', 10, 8], ['https://github.com/example/booking-app', 12, 14], ['https://github.com/Wakua/github-progress-board', 0, 2]]);
  assert.ok(snapshots[2].items.every(item => githubStateLabel(item) === 'Merged'));
  const workspace = emptyWorkspace(); let counter = 0;
  importSnapshots(workspace, snapshots, snapshots.map(snapshot => ({ projectId: null, name: snapshot.repositoryUrl.split('/').at(-1) })), () => `actual-${counter++}`);
  validateWorkspace(workspace);
  assert.ok(workspace.projects.every(project => project.data.tasks.length === 0 && project.data.goals.length === 0));
});
test('取得helperは既存ghのGETだけを使い、全ページ取得・上限・途中失敗を扱う', () => {
  const calls = [];
  const pages = collectPages('qa-fixture/alpha', 'issues', route => { calls.push(route); return calls.length === 1 ? Array(100).fill({}) : []; });
  assert.equal(pages.length, 2); assert.match(calls[1], /page=2$/);
  assert.throws(() => collectPages('qa-fixture/alpha', 'issues', () => { throw new Error('Forbidden'); }), /Forbidden/);
  assert.throws(() => collectPages('qa-fixture/alpha', 'issues', () => Array(100).fill({})), /取得上限/);
});
test('REST adapterはページ欠落・別repositoryのPR・重複・Issue/PR不一致を拒否する', () => {
  const record = { number: 7, html_url: `${repositoryUrl}/issues/7`, title: 'QA', state: 'open', updated_at: at, closed_at: null };
  const input = { repositoryUrl, fetchedAt: at, issuePages: [[record]], pullPages: [[]] };
  assert.equal(buildSnapshot(input).items[0].number, 7);
  assert.throws(() => buildSnapshot({ ...input, issuePages: [Array(100).fill(record)] }), /次ページ/);
  assert.throws(() => buildSnapshot({ ...input, issuePages: [[record, record]] }), /重複/);
  assert.throws(() => buildSnapshot({ ...input, issuePages: [[{ ...record, pull_request: {} }]] }), /一致/);
  const pr = { ...record, html_url: `${repositoryUrl}/pull/7`, draft: false, merged_at: null, base: { repo: { html_url: 'https://github.com/qa-fixture/beta' } } };
  assert.throws(() => buildSnapshot({ ...input, issuePages: [[{ ...record, pull_request: {} }]], pullPages: [[pr]] }), /base repository/);
});
test('取得helperのoffline入力を検証し、失敗時も既存の出力ファイルを保持する', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'snapshot-helper-test-'));
  const input = path.join(dir, 'pages.json'), output = path.join(dir, 'snapshot.json');
  await writeFile(input, JSON.stringify({ repositoryUrl, fetchedAt: at, issuePages: [[]], pullPages: [[]] }));
  await main(['--repo', 'qa-fixture/alpha', '--output', output, '--from-pages', input]);
  const before = await readFile(output, 'utf8');
  await assert.rejects(main(['--repo', 'qa-fixture/alpha', '--output', output, '--from-pages', input]), /EEXIST/);
  assert.equal(await readFile(output, 'utf8'), before);
  await assert.rejects(main(['--repo', 'qa-fixture/beta', '--output', output, '--from-pages', input]), /repository/);
  assert.equal(await readFile(output, 'utf8'), before);
});

test('承認待ちのPRは開いているReadyのPRを番号順に数え、Draftは作業中として数えず、上限2件で止める', () => {
  assert.equal(APPROVAL_LIMIT, 2);
  assert.equal(approvalQueue(undefined), null);
  const snapshot = fixture();
  const pr = (number, extra = {}) => ({ kind: 'pull_request', number, url: `${repositoryUrl}/pull/${number}`, title: `PR ${number}`, state: 'open', updatedAt: at, closedAt: null, draft: false, mergedAt: null, estimatePoints: null, deadline: null, ...extra });
  const summary = () => { const queue = approvalQueue(snapshot); return [queue.items.map(item => item.number), queue.full, queue.remaining]; };
  assert.deepEqual(summary(), [[], false, 2], 'Merged・ClosedのPRとIssueは数えない');
  snapshot.items.push(pr(4, { draft: true }), pr(12));
  validateSnapshot(snapshot, { now: Date.parse(at) });
  assert.deepEqual(summary(), [[12], false, 1], 'Draftは作業中として数えない');
  snapshot.items.push(pr(10));
  assert.deepEqual(summary(), [[10, 12], true, 0]);
  snapshot.items.push(pr(15));
  assert.deepEqual(summary(), [[10, 12, 15], true, 0]);
});

test('承認待ちの上限を指定すると、上限に達しているかと残りの件数がその値で決まる', () => {
  const snapshot = fixture();
  for (const number of [10, 12]) snapshot.items.push({ kind: 'pull_request', number, url: `${repositoryUrl}/pull/${number}`, title: 'PR', state: 'open', updatedAt: at, closedAt: null, draft: false, mergedAt: null, estimatePoints: null, deadline: null });
  const summary = limit => { const queue = approvalQueue(snapshot, limit); return [queue.limit, queue.full, queue.remaining]; };
  assert.deepEqual(summary(1), [1, true, 0]);
  assert.deepEqual(summary(2), [2, true, 0], '件数が上限に等しければ上限に達している');
  assert.deepEqual(summary(5), [5, false, 3]);
  const fresh = Date.parse(at) + 3600000;
  assert.equal(approvalState(snapshot, fresh, 5).readyAllowed, true);
  assert.equal(approvalState(snapshot, fresh, 2).readyAllowed, false);
  assert.equal(approvalState(snapshot, Date.parse(at) + 25 * 3600000, 5).readyAllowed, null, '古いsnapshotは上限を変えても判断を保留する');
});

test('承認待ちの上限は1〜99の整数で、プロジェクトに設定がなければ既定の2件にする', () => {
  assert.deepEqual([1, 2, 99].map(isApprovalLimit), [true, true, true]);
  assert.deepEqual([0, 100, 1.5, -1, NaN, '2', null, undefined].map(isApprovalLimit), Array(8).fill(false));
  assert.equal(projectApprovalLimit({}), APPROVAL_LIMIT);
  assert.equal(projectApprovalLimit({ approvalLimit: 7 }), 7);
});

test('古いsnapshotや未取得では、承認待ちの件数だけでReadyにできると判断しない', () => {
  assert.deepEqual(approvalState(undefined), { queue: null, stale: false, readyAllowed: null });
  const snapshot = fixture();
  const fresh = Date.parse(at) + 3600000, old = Date.parse(at) + 25 * 3600000;
  assert.deepEqual([approvalState(snapshot, fresh).stale, approvalState(snapshot, fresh).readyAllowed], [false, true]);
  assert.deepEqual([approvalState(snapshot, old).stale, approvalState(snapshot, old).readyAllowed], [true, null]);
  for (const number of [10, 12]) snapshot.items.push({ kind: 'pull_request', number, url: `${repositoryUrl}/pull/${number}`, title: 'PR', state: 'open', updatedAt: at, closedAt: null, draft: false, mergedAt: null, estimatePoints: null, deadline: null });
  assert.equal(approvalState(snapshot, fresh).readyAllowed, false);
  assert.deepEqual([approvalState(snapshot, old).queue.full, approvalState(snapshot, old).readyAllowed], [true, null], '古い場合は上限の事実だけを残し、判断は保留する');
});
