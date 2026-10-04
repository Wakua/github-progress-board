import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudWorkspaceStore, planWorkspaceMigration, readLocalMigration, readLocalBackup } from '../dist/cloud-workspace.mjs';
import { registerProject, updateProject, addDecision, STORAGE_KEY, BACKUP_KEY } from '../dist/workspace.mjs';
import { myWork, resolveDecision } from '../dist/engine.mjs';
import worker from '../server/worker.mjs';
import { fixtureWorkspace, sqliteD1, memoryStorage } from './cloud-fixtures.mjs';

const harness = t => {
  const DB = sqliteD1(); t.after(() => DB.close());
  let user = 'qa-owner', online = true, lostResponse = false, beforeResponse = null;
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(fixtureWorkspace('legacy')) });
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body });
    if (!online) throw new TypeError('Offline QA');
    const response = await worker.fetch(new Request('https://progress.test' + url, { ...options, headers: {
      ...options.headers, 'oai-authenticated-user-id': user, ...(options.method === 'PUT' ? { Origin: 'https://progress.test' } : {})
    } }), { DB });
    if (beforeResponse) await beforeResponse(options);
    if (lostResponse && options.method === 'PUT') throw new TypeError('Response lost after commit');
    return response;
  };
  return { DB, calls, storage, fetcher, store: () => createCloudWorkspaceStore(fetcher, { storage }),
    setOnline: value => online = value, changeUser: value => user = value, loseResponse: () => lostResponse = true, intercept: value => beforeResponse = value };
};

test('cloud initialization does not import or overwrite legacy browser progress', async t => {
  const { store, storage, calls } = harness(t), before = storage.getItem(STORAGE_KEY), cloud = store();
  assert.equal(cloud.status().readOnly, true); await cloud.initialize();
  assert.equal(cloud.status().loaded, true); assert.equal(cloud.status().version, 0); assert.deepEqual(cloud.snapshot().projects, []);
  assert.equal(storage.getItem(STORAGE_KEY), before); assert.equal(calls.filter(call => call.method === 'PUT').length, 0);
});
test('initial load failure disables all writes and does not present browser data as cloud data', async t => {
  const h = harness(t); h.setOnline(false); const cloud = h.store(); await cloud.initialize();
  assert.equal(cloud.status().loaded, false); assert.equal(cloud.status().readOnly, true); assert.deepEqual(cloud.snapshot().projects, []);
  await assert.rejects(cloud.transact(draft => registerProject(draft, { name: 'blocked' })), /編集を停止/);
  const raw = await cloud.raw(); assert.equal(raw.confirmed, null); assert.ok(raw.legacyBrowserData.primary.includes('project-legacy')); assert.ok(raw.backupError);
});
test('rejected authentication never falls back to local-only success', async () => {
  const cloud = createCloudWorkspaceStore(async () => Response.json({ error: 'Authentication required' }, { status: 401 }), { storage: memoryStorage({ [STORAGE_KEY]: JSON.stringify(fixtureWorkspace()) }) });
  await cloud.initialize(); assert.equal(cloud.status().loaded, false); assert.equal(cloud.status().readOnly, true); assert.deepEqual(cloud.snapshot().projects, []);
});
test('remote failure preserves last confirmed data and exportable unconfirmed candidate', async t => {
  const h = harness(t), cloud = h.store(); await cloud.initialize(); h.setOnline(false);
  await assert.rejects(cloud.transact(draft => registerProject(draft, { name: '保存できないQA' }, () => 'qa-failed')), /保存結果を確認/);
  assert.deepEqual(cloud.snapshot().projects, []); assert.equal(cloud.status().version, 0); assert.equal(cloud.status().readOnly, true);
  const raw = await cloud.raw(); assert.equal(raw.pending.workspace.projects[0].id, 'qa-failed'); assert.equal(raw.pending.baseVersion, 0); assert.ok(raw.backupError);
  assert.equal(cloud.status().hasPending, true);
  assert.equal(raw.confirmed.workspace.projects.length, 0);
});
test('lost acknowledgement can commit remotely but never claims local success or retries implicitly', async t => {
  const h = harness(t), cloud = h.store(); await cloud.initialize(); h.loseResponse();
  await assert.rejects(cloud.transact(draft => registerProject(draft, { name: '応答喪失QA' }, () => 'qa-accepted')));
  assert.deepEqual(cloud.snapshot().projects, []); assert.equal(h.calls.filter(call => call.method === 'PUT').length, 1);
  const reload = h.store(); await reload.initialize(); assert.equal(reload.snapshot().projects[0].id, 'qa-accepted'); assert.equal(reload.status().version, 1);
  const raw = await cloud.raw(); assert.ok(raw.pending); assert.equal(raw.serverBackup.head.version, 1);
});
test('two independent clients share durable progress after load and conflict instead of overwriting', async t => {
  const h = harness(t), pc = h.store(), phone = h.store(); await pc.initialize(); await phone.initialize();
  await pc.transact(draft => registerProject(draft, { name: 'PCのQA' }, () => 'pc-project'));
  await assert.rejects(phone.transact(draft => registerProject(draft, { name: '電話のQA' }, () => 'phone-project')), /別の端末/);
  assert.equal(phone.status().readOnly, true); assert.deepEqual(phone.snapshot().projects, []);
  const reload = h.store(); await reload.initialize(); assert.equal(reload.snapshot().projects[0].id, 'pc-project');
  assert.equal((await phone.raw()).pending.workspace.projects[0].id, 'phone-project');
});
test('cloud decision registration and resolution persist across independent reloads without changing other projects', async t => {
  for (const status of ['active', 'review']) {
    const h = harness(t), pc = h.store(), seed = fixtureWorkspace();
    seed.projects.push(fixtureWorkspace('other-project').projects[0]);
    Object.assign(seed.projects[0].data.tasks[0], { owner: 'Claude', status, estimatePoints: 1 });
    seed.projects[0].data.tasks[0].criteria[0].checked = status === 'review';
    await pc.initialize(); await pc.transact(draft => Object.assign(draft, seed));
    let next = 0; const ids = ['qa-decision-task', 'qa-decision'];
    await pc.transact(draft => updateProject(draft, 'project-one', data => addDecision(data, 'project-one', 'task-one', {
      title: 'QA共有判断', options: ['A', 'B'], evidence: 'QA判断材料', decider: 'Wakua', estimatePoints: 0.5
    }, () => ids[next++])));
    const phone = h.store(); await phone.initialize(); const saved = phone.snapshot();
    assert.equal(phone.status().version, 2); assert.deepEqual(saved.projects[1], seed.projects[1]);
    const data = saved.projects[0].data, original = data.tasks.find(task => task.id === 'task-one');
    assert.equal(original.status, 'todo'); assert.equal(original.estimatePoints, 1);
    assert.deepEqual(original.criteria, seed.projects[0].data.tasks[0].criteria);
    assert.deepEqual(original.deps, ['qa-decision-task']);
    const section = owner => myWork(data, owner, '2026-10-04').sections.map(item => [item.id, item.tasks.map(row => row.task.id)]);
    assert.deepEqual(section('Wakua'), [['action', ['qa-decision-task']]]);
    assert.deepEqual(section('Claude'), [['waiting', ['task-one']]]);
    await phone.transact(draft => updateProject(draft, 'project-one', data => resolveDecision(data, 'qa-decision', 'A', 'QA選択理由')));
    const reload = h.store(); await reload.initialize(); const resolved = reload.snapshot().projects[0].data;
    assert.equal(reload.status().version, 3); assert.equal(resolved.decisions[0].resolved, true);
    assert.equal(resolved.decisions[0].choice, 'A'); assert.equal(resolved.tasks.find(task => task.id === 'qa-decision-task').status, 'done');
    assert.deepEqual(myWork(resolved, 'Claude', '2026-10-04').sections.map(item => item.id), ['ready-later']);
    assert.deepEqual(reload.snapshot().projects[1], seed.projects[1]);
  }
});
test('failed cloud decision registration retains its linked candidate and blocks repeated application', async t => {
  const h = harness(t), cloud = h.store(); await cloud.initialize(); await cloud.transact(draft => Object.assign(draft, fixtureWorkspace()));
  const confirmed = cloud.snapshot(); h.setOnline(false); let next = 0; const ids = ['qa-failed-task', 'qa-failed-decision'];
  await assert.rejects(cloud.transact(draft => updateProject(draft, 'project-one', data => addDecision(data, 'project-one', 'task-one', {
    title: 'QA失敗した判断', options: ['A', 'B'], decider: 'Wakua'
  }, () => ids[next++]))), /保存結果を確認/);
  assert.deepEqual(cloud.snapshot(), confirmed); const pending = (await cloud.raw()).pending;
  assert.equal(pending.baseVersion, 1); assert.deepEqual(pending.workspace.projects[0].data.tasks[0].deps, ['qa-failed-task']);
  assert.equal(pending.workspace.projects[0].data.decisions[0].taskId, 'qa-failed-task');
  const calls = h.calls.length; await assert.rejects(cloud.transact(() => {}), /編集を停止/); assert.equal(h.calls.length, calls);
  h.setOnline(true); const reload = h.store(); await reload.initialize(); assert.deepEqual(reload.snapshot().projects, confirmed.projects);
  assert.equal(reload.status().version, 1); assert.deepEqual((await cloud.raw()).pending, pending);
});
test('login change after load cannot copy old-account document into a different account', async t => {
  const h = harness(t), cloud = h.store(); await cloud.initialize(); h.changeUser('qa-other');
  await assert.rejects(cloud.transact(draft => Object.assign(draft, fixtureWorkspace('private-owner'))), /アカウント/);
  const other = h.store(); await other.initialize(); assert.deepEqual(other.snapshot().projects, []);
  assert.ok((await cloud.raw()).backupError.includes('アカウント')); assert.equal((await cloud.raw()).serverBackup, undefined);
});
test('invalid mutation fails before network and can be corrected without freezing valid data', async t => {
  const h = harness(t), cloud = h.store(); await cloud.initialize(); const before = h.calls.length;
  await assert.rejects(cloud.transact(draft => { draft.schemaVersion = 55; }));
  assert.equal(h.calls.length, before); assert.equal(cloud.status().readOnly, false);
  await cloud.transact(draft => Object.assign(draft, fixtureWorkspace())); assert.equal(cloud.status().version, 1);
});
test('project selection is device-local, is not a cloud write, and never replaces legacy data', async t => {
  const h = harness(t), before = h.storage.getItem(STORAGE_KEY), cloud = h.store(); await cloud.initialize();
  await cloud.transact(draft => Object.assign(draft, fixtureWorkspace())); const puts = h.calls.filter(call => call.method === 'PUT').length;
  for (let i = 0; i < 9; i++) cloud.select(i % 2 ? 'project-one' : null);
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, puts); assert.equal(cloud.status().version, 1); assert.equal(h.storage.getItem(STORAGE_KEY), before);
  const reload = h.store(); await reload.initialize(); assert.equal(reload.snapshot().selectedProjectId, null);
});
test('unavailable local storage does not block successful authenticated cloud progress', async t => {
  const h = harness(t), storage = { getItem() { throw new Error('Unavailable'); }, setItem() { throw new Error('Unavailable'); } };
  const cloud = createCloudWorkspaceStore(h.fetcher, { storage }); await cloud.initialize();
  await cloud.transact(draft => Object.assign(draft, fixtureWorkspace())); assert.equal(cloud.status().version, 1); assert.equal(cloud.status().readOnly, false);
});
test('one client cannot replace its own pending write with a simultaneous mutation', async t => {
  const h = harness(t), cloud = h.store(); await cloud.initialize();
  let release; const gate = new Promise(resolve => release = resolve); h.intercept(options => options.method === 'PUT' ? gate : undefined);
  const first = cloud.transact(draft => registerProject(draft, { name: 'First' }, () => 'first'));
  await assert.rejects(cloud.transact(draft => registerProject(draft, { name: 'Second' }, () => 'second')), /保存中/);
  release(); await first; assert.deepEqual(cloud.snapshot().projects.map(project => project.id), ['first']);
});
test('a mismatched save response freezes the old document', async t => {
  for (const mismatch of ['account', 'version', 'workspace']) {
    const h = harness(t); const fetcher = async (url, options) => {
      const response = await h.fetcher(url, options);
      if (options.method !== 'PUT') return response;
      const body = await response.json();
      if (mismatch === 'account') body.userId = 'different-account';
      if (mismatch === 'version') body.version++;
      if (mismatch === 'workspace') body.workspace.projects = [];
      return Response.json(body);
    };
    const cloud = createCloudWorkspaceStore(fetcher); await cloud.initialize();
    await assert.rejects(cloud.transact(draft => Object.assign(draft, fixtureWorkspace())));
    assert.equal(cloud.status().readOnly, true); assert.deepEqual(cloud.snapshot().projects, []); assert.ok((await cloud.raw()).pending);
  }
});
test('fetch timeout is a recoverable unavailable state, not local success', async () => {
  const fetcher = (_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError'))));
  const cloud = createCloudWorkspaceStore(fetcher, { timeoutMs: 10 }); await cloud.initialize(); assert.equal(cloud.status().loaded, false); assert.equal(cloud.status().readOnly, true);
});
for (const committed of [false, true]) test(`save timeout ${committed ? 'after' : 'before'} server commit preserves the candidate and prevents duplicate application`, async t => {
  const h = harness(t); let stall = false, timedOut = 0, writes = 0;
  const fetcher = async (url, options = {}) => {
    if (options.method !== 'PUT') return h.fetcher(url, options);
    writes++;
    if (!stall) return h.fetcher(url, options);
    // The application timer must abort the request; no transport error is injected early.
    const timeout = new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
      timedOut++; reject(new DOMException('Timed out', 'AbortError'));
    }, { once: true }));
    if (committed) await h.fetcher(url, options);
    return timeout;
  };
  const cloud = createCloudWorkspaceStore(fetcher, { storage: h.storage, timeoutMs: 250 });
  await cloud.initialize(); await cloud.transact(draft => Object.assign(draft, fixtureWorkspace()));
  const confirmed = cloud.snapshot(), legacy = h.storage.getItem(STORAGE_KEY); stall = true;
  await assert.rejects(cloud.transact(draft => registerProject(draft, { name: 'QA timeout candidate' }, () => 'timeout-candidate')), /保存結果を確認/);
  assert.equal(timedOut, 1); assert.equal(writes, 2);
  assert.deepEqual(cloud.snapshot(), confirmed); assert.equal(cloud.status().version, 1);
  assert.equal(cloud.status().readOnly, true); assert.equal(cloud.status().hasPending, true);
  const exported = await cloud.raw(), pending = exported.pending;
  assert.equal(exported.confirmed.version, 1); assert.deepEqual(exported.confirmed.workspace, confirmed);
  assert.equal(pending.baseVersion, 1); assert.equal(pending.expectedUserId, 'qa-owner');
  assert.deepEqual(pending.workspace.projects.map(project => project.id), ['project-one', 'timeout-candidate']);
  assert.equal(exported.serverBackup.head.version, committed ? 2 : 1);
  await assert.rejects(cloud.transact(draft => registerProject(draft, { name: 'QA blocked retry' }, () => 'blocked-retry')), /編集を停止/);
  await assert.rejects(cloud.initialize(), /退避してから/);
  assert.equal(writes, 2); assert.deepEqual((await cloud.raw()).pending, pending);
  const beforeReplay = h.store(); await beforeReplay.initialize();
  assert.equal(beforeReplay.status().version, committed ? 2 : 1);
  assert.deepEqual(beforeReplay.snapshot().projects, committed ? pending.workspace.projects : confirmed.projects);

  // Exercise the exported request against the real Worker twice, never a UI auto-retry.
  const replay = () => h.fetcher('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Progress-Write': '1' }, body: JSON.stringify(pending) });
  assert.equal((await replay()).status, 200); assert.equal((await replay()).status, 200);
  const reload = h.store(); await reload.initialize();
  assert.equal(reload.status().version, 2); assert.deepEqual(reload.snapshot().projects, pending.workspace.projects);
  assert.equal(reload.status().hasPending, false); assert.equal(reload.status().readOnly, false);
  assert.equal(h.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM progress_workspace_versions').get().count, 2);
  assert.deepEqual((await cloud.raw()).pending, pending); assert.deepEqual(cloud.snapshot(), confirmed);
  assert.equal(h.storage.getItem(STORAGE_KEY), legacy);
});
test('migration adds whole projects without replacing existing IDs or conflating repositories', () => {
  const current = fixtureWorkspace('current'), incoming = fixtureWorkspace('incoming'); incoming.projects[0].repositoryUrl = current.projects[0].repositoryUrl;
  const before = structuredClone(current), plan = planWorkspaceMigration(current, incoming);
  assert.deepEqual(current, before); assert.deepEqual(plan.added, ['project-incoming']); assert.equal(plan.workspace.projects.length, 2);
  assert.notEqual(plan.workspace.projects[0].data.tasks[0].projectId, plan.workspace.projects[1].data.tasks[0].projectId);
});
test('identical migration is skipped, conflicting same ID is rejected without partial addition', () => {
  const current = fixtureWorkspace(), incoming = structuredClone(current);
  assert.deepEqual(planWorkspaceMigration(current, incoming).skipped, ['project-one']);
  incoming.projects.unshift(fixtureWorkspace('would-add').projects[0]); incoming.projects[1].data.tasks[0].evidence = 'changed';
  assert.throws(() => planWorkspaceMigration(current, incoming), /同じプロジェクトID/); assert.equal(current.projects.length, 1);
});
test('legacy migration keeps raw strings byte-for-byte and never heals corrupt primary automatically', () => {
  const primary = JSON.stringify(fixtureWorkspace(), null, 2), backup = JSON.stringify(fixtureWorkspace('backup'));
  const storage = memoryStorage({ [STORAGE_KEY]: primary, [BACKUP_KEY]: backup }); const entries = [...storage.values];
  assert.equal(readLocalMigration(storage).raw.primary, primary); assert.deepEqual([...storage.values], entries);
  storage.setItem(STORAGE_KEY, '{broken'); assert.throws(() => readLocalMigration(storage));
  assert.equal(readLocalBackup(storage).primary, '{broken'); assert.equal(readLocalBackup(storage).backup, backup);
});
test('unsafe migration JSON is refused while both current and raw original remain unchanged', () => {
  const current = fixtureWorkspace('current'), incoming = fixtureWorkspace('incoming');
  Object.defineProperty(incoming, '__proto__', { value: { injected: true }, enumerable: true });
  const primary = JSON.stringify(incoming), storage = memoryStorage({ [STORAGE_KEY]: primary }), before = structuredClone(current);
  assert.throws(() => readLocalMigration(storage), /未対応のキー/);
  assert.throws(() => planWorkspaceMigration(current, JSON.parse(primary)), /未対応のキー/);
  assert.deepEqual(current, before); assert.equal(readLocalBackup(storage).primary, primary); assert.equal({}.injected, undefined);
});
test('source-level migration then reload preserves task state, criteria, unknowns, IDs and legacy backup', async t => {
  const h = harness(t), original = h.storage.getItem(STORAGE_KEY), cloud = h.store(); await cloud.initialize();
  const source = cloud.localMigration();
  await cloud.transact(draft => Object.assign(draft, planWorkspaceMigration(draft, source.workspace).workspace));
  const reload = h.store(); await reload.initialize(); assert.deepEqual(reload.snapshot().projects, source.workspace.projects);
  assert.equal(h.storage.getItem(STORAGE_KEY), original); assert.equal(reload.snapshot().projects[0].data.tasks[0].estimatePoints, null);
});
