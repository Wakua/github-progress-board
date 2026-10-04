import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import worker from '../server/worker.mjs';
import { cloudDatabase, splitPayload, digest, MAX_WORKSPACE_BYTES } from '../server/cloud-db.mjs';
import { fixtureWorkspace, sqliteD1 } from './cloud-fixtures.mjs';

const origin = 'https://progress.test';
const request = (url = '/api/workspace', { user = 'qa-owner', method = 'GET', body, headers = {} } = {}) => new Request(origin + url, {
  method, headers: { ...(user ? { 'oai-authenticated-user-id': user } : {}), ...(method === 'PUT' ? { Origin: origin, 'Content-Type': 'application/json', 'X-Progress-Write': '1' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
});
const writeBody = (workspace, baseVersion = 0, expectedUserId = 'qa-owner', operationId = crypto.randomUUID()) => ({ workspace, baseVersion, expectedUserId, operationId });
const harness = t => { const DB = sqliteD1(); t.after(() => DB.close()); return { DB, call: (url, options) => worker.fetch(request(url, options), { DB }) }; };
const tableCount = DB => DB.sqlite.prepare('SELECT COUNT(*) AS count FROM progress_workspaces').get().count;

test('anonymous API is rejected before storage, protected browser navigation uses dispatch sign-in', async () => {
  assert.equal((await worker.fetch(request(undefined, { user: null }), {})).status, 401);
  const browser = await worker.fetch(request('/', { user: null, headers: { Accept: 'text/html' } }), {});
  assert.equal(browser.status, 302); assert.equal(browser.headers.get('location'), origin + '/signin-with-chatgpt?return_to=%2F');
});
test('missing DB is unavailable, never a fresh local workspace', async () => {
  const response = await worker.fetch(request(), {}); assert.equal(response.status, 503); assert.equal((await response.json()).code, 'storage_unavailable');
});
test('first authenticated read is unpersisted empty version zero and no-store', async t => {
  const { DB, call } = harness(t); const response = await call(); const body = await response.json();
  assert.equal(body.version, 0); assert.deepEqual(body.workspace.projects, []); assert.equal(body.updatedAt, null); assert.equal(tableCount(DB), 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('validated save persists across database reopen, no selection shared', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'progress-cloud-db-')), file = path.join(dir, 'qa.sqlite');
  let DB = sqliteD1(file);
  try {
    const workspace = fixtureWorkspace();
    const response = await worker.fetch(request(undefined, { method: 'PUT', body: writeBody(workspace) }), { DB });
    assert.equal(response.status, 200); DB.close(); DB = sqliteD1(file, { migrate: false });
    const restored = await (await worker.fetch(request(), { DB })).json();
    assert.equal(restored.version, 1); assert.deepEqual(restored.workspace.projects, workspace.projects); assert.equal(restored.workspace.selectedProjectId, null);
  } finally { DB.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('separate authenticated users, including SQL metacharacters, never share records or backups', async t => {
  const { call } = harness(t); const owner = fixtureWorkspace('owner'), other = fixtureWorkspace('other');
  await call(undefined, { method: 'PUT', body: writeBody(owner) });
  const user = "qa' OR 1=1 --";
  await call(undefined, { user, method: 'PUT', body: writeBody(other, 0, user) });
  assert.deepEqual((await (await call()).json()).workspace.projects, owner.projects);
  assert.deepEqual((await (await call(undefined, { user })).json()).workspace.projects, other.projects);
  const backup = await (await call('/api/workspace/backup', { user })).json(); assert.ok(!JSON.stringify(backup).includes('project-owner'));
});
test('query/body user override and an account changed since load are rejected', async t => {
  const { DB, call } = harness(t);
  assert.equal((await call('/api/workspace?user=other')).status, 400);
  assert.equal((await call(undefined, { method: 'PUT', body: { ...writeBody(fixtureWorkspace()), user_id: 'other' } })).status, 400);
  assert.equal((await call(undefined, { user: 'qa-other', method: 'PUT', body: writeBody(fixtureWorkspace()) })).status, 401);
  assert.equal(tableCount(DB), 0);
});
test('same-origin non-simple writes are required; cross-site, same-site and missing Origin cannot save', async t => {
  const { DB, call } = harness(t);
  for (const headers of [{ Origin: 'https://hostile.test' }, { Origin: '' }, { 'X-Progress-Write': '' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    assert.equal((await call(undefined, { method: 'PUT', headers, body: writeBody(fixtureWorkspace()) })).status, 403);
  }
  assert.equal(tableCount(DB), 0);
});
test('two device writes to the same base version yield one winner and one conflict', async t => {
  const { call } = harness(t); await call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace()) });
  const one = fixtureWorkspace('first'), two = fixtureWorkspace('second');
  const results = await Promise.all([one, two].map(workspace => call(undefined, { method: 'PUT', body: writeBody(workspace, 1) })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const final = await (await call()).json(); assert.equal(final.version, 2);
  const backup = await (await call('/api/workspace/backup')).json(); assert.deepEqual(backup.versions.map(row => row.version), [2, 1]);
  assert.ok(backup.chunks.some(chunk => chunk.payload.includes('project-one')));
});
test('initial creation also protects an empty workspace loaded by two devices', async t => {
  const { call } = harness(t);
  const results = await Promise.all(['one', 'two'].map(suffix => call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace(suffix)) })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal((await (await call()).json()).version, 1);
});
test('serial and concurrent retry of the same operation is idempotent', async t => {
  const { call, DB } = harness(t); const body = writeBody(fixtureWorkspace());
  const responses = await Promise.all([call(undefined, { method: 'PUT', body }), call(undefined, { method: 'PUT', body })]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal((await call(undefined, { method: 'PUT', body })).status, 200);
  assert.equal((await (await call()).json()).version, 1);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM progress_workspace_versions').get().count, 1);
});
test('reuse of operation ID with different payload cannot overwrite accepted content', async t => {
  const { call } = harness(t); const body = writeBody(fixtureWorkspace()); await call(undefined, { method: 'PUT', body });
  assert.equal((await call(undefined, { method: 'PUT', body: { ...body, workspace: fixtureWorkspace('different') } })).status, 409);
  assert.equal((await (await call()).json()).workspace.projects[0].id, 'project-one');
});
function largerWorkspace() {
  const workspace = fixtureWorkspace();
  for (let i = 0; i < 50; i++) workspace.projects[0].data.goals.push({ ...workspace.projects[0].data.goals[0], id: 'retry-large-' + i, issueNumber: null, title: 'x'.repeat(10000) });
  return workspace;
}
test('rejected reuse with additional chunks leaves accepted head, chunks and raw backups unchanged', async t => {
  const { call } = harness(t), accepted = fixtureWorkspace(), body = writeBody(accepted);
  assert.equal((await call(undefined, { method: 'PUT', body })).status, 200);
  const before = await (await call('/api/workspace/backup')).json(); delete before.exportedAt;
  assert.equal((await call(undefined, { method: 'PUT', body: { ...body, workspace: largerWorkspace() } })).status, 409);
  const response = await call(); assert.equal(response.status, 200); assert.deepEqual((await response.json()).workspace.projects, accepted.projects);
  const after = await (await call('/api/workspace/backup')).json(); delete after.exportedAt; assert.deepEqual(after, before);
});
test('concurrent same-operation different-sized requests cannot append losing chunks', async t => {
  const { call, DB } = harness(t), workspaces = [fixtureWorkspace(), largerWorkspace()], operationId = crypto.randomUUID();
  const batch = DB.batch.bind(DB); let firstReads = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  DB.batch = async statements => {
    const result = await batch(statements);
    if (statements[0].sql.startsWith('SELECT * FROM progress_workspaces') && firstReads < 2) {
      firstReads++; if (firstReads === 2) release(); await barrier;
    }
    return result;
  };
  const responses = await Promise.all(workspaces.map(workspace => call(undefined, { method: 'PUT', body: writeBody(workspace, 0, 'qa-owner', operationId) })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const final = await call(); assert.equal(final.status, 200);
  const winner = workspaces[responses.findIndex(response => response.status === 200)]; assert.deepEqual((await final.json()).workspace.projects, winner.projects);
  const head = DB.sqlite.prepare('SELECT * FROM progress_workspaces').get();
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM progress_workspace_chunks').get().count, head.chunk_count);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM progress_workspace_versions').get().count, 1);
});
test('prototype-affecting JSON keys cannot enter cloud state through nested or root metadata', async t => {
  const { call, DB } = harness(t);
  for (const location of ['root', 'nested']) for (const key of ['__proto__', 'constructor', 'prototype']) {
    const workspace = fixtureWorkspace(), target = location === 'root' ? workspace : workspace.projects[0].data.tasks[0];
    Object.defineProperty(target, key, { value: { injected: true }, enumerable: true });
    assert.equal((await call(undefined, { method: 'PUT', body: writeBody(workspace) })).status, 422);
  }
  assert.equal(tableCount(DB), 0); assert.equal({}.injected, undefined);
});
test('pre-existing unsafe JSON is frozen and raw-exportable rather than healed by a new save', async t => {
  const { call, DB } = harness(t); await call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace()) });
  const unsafe = JSON.stringify({ ...fixtureWorkspace(), selectedProjectId: null }).replace('"schemaVersion":1', '"schemaVersion":1,"__proto__":{"injected":true}');
  DB.sqlite.prepare('UPDATE progress_workspace_chunks SET payload = ? WHERE user_id = ?').run(unsafe, 'qa-owner');
  DB.sqlite.prepare('UPDATE progress_workspaces SET digest = ? WHERE user_id = ?').run(await digest(unsafe), 'qa-owner');
  assert.equal((await call()).status, 409);
  assert.equal((await call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace('replacement'), 1) })).status, 409);
  assert.equal((await (await call('/api/workspace/backup')).json()).chunks[0].payload, unsafe);
});
test('whole document validation rejects unsupported versions and cross-project references atomically', async t => {
  const { DB, call } = harness(t);
  const workspace = fixtureWorkspace(); workspace.schemaVersion = 2;
  assert.equal((await call(undefined, { method: 'PUT', body: writeBody(workspace) })).status, 422);
  workspace.schemaVersion = 1; workspace.projects[0].data.tasks[0].projectId = 'other';
  assert.equal((await call(undefined, { method: 'PUT', body: writeBody(workspace) })).status, 422);
  workspace.projects[0].data.tasks[0].projectId = workspace.projects[0].id; workspace.projects[0].data.tasks[0].deps = ['task-other'];
  assert.equal((await call(undefined, { method: 'PUT', body: writeBody(workspace) })).status, 422); assert.equal(tableCount(DB), 0);
});
test('same Issue numbers in different projects remain independent', async t => {
  const { call } = harness(t); const workspace = fixtureWorkspace(); workspace.projects.push(fixtureWorkspace('two').projects[0]);
  assert.equal((await call(undefined, { method: 'PUT', body: writeBody(workspace) })).status, 200);
  const saved = (await (await call()).json()).workspace; assert.equal(saved.projects[0].data.tasks[0].issueNumber, saved.projects[1].data.tasks[0].issueNumber);
  assert.notEqual(saved.projects[0].data.tasks[0].id, saved.projects[1].data.tasks[0].id);
});
test('failed chunk batch rolls back version, data and backups together', async t => {
  const { DB, call } = harness(t); await call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace()) });
  const before = await (await call('/api/workspace/backup')).json(); DB.failOnce(sql => sql.startsWith('INSERT INTO progress_workspace_chunks'));
  assert.equal((await call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace('failed'), 1) })).status, 503);
  const after = await (await call('/api/workspace/backup')).json(); delete before.exportedAt; delete after.exportedAt;
  assert.deepEqual(after, before); assert.equal((await (await call()).json()).version, 1);
});
test('corrupt stored data disables reads and writes while raw backup remains exportable', async t => {
  const { DB, call } = harness(t); await call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace()) });
  await call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace('two'), 1) });
  DB.sqlite.prepare('UPDATE progress_workspace_chunks SET payload = ? WHERE user_id = ? AND version = 2').run('{broken', 'qa-owner');
  assert.equal((await call()).status, 409);
  assert.equal((await call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace('replacement'), 2) })).status, 409);
  const backup = await (await call('/api/workspace/backup')).json(); assert.equal(backup.head.version, 2);
  assert.ok(backup.chunks.some(chunk => chunk.payload === '{broken')); assert.ok(backup.chunks.some(chunk => chunk.payload.includes('project-one')));
});
test('missing head with surviving history cannot be overwritten as empty', async t => {
  const { DB, call } = harness(t); await call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace()) });
  DB.sqlite.prepare('DELETE FROM progress_workspaces WHERE user_id = ?').run('qa-owner');
  assert.equal((await call()).status, 409);
  assert.equal((await call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace('replacement')) })).status, 409);
});
test('latest five predecessors are kept, raw export is bounded to current and previous versions', async t => {
  const { DB, call } = harness(t);
  for (let version = 0; version < 9; version++) assert.equal((await call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace('v' + version), version) })).status, 200);
  assert.deepEqual(DB.sqlite.prepare('SELECT version FROM progress_workspace_versions ORDER BY version').all().map(row => row.version), [4, 5, 6, 7, 8, 9]);
  const backup = await (await call('/api/workspace/backup')).json(); assert.deepEqual(backup.versions.map(row => row.version), [9, 8]);
  assert.ok(backup.chunks.every(chunk => chunk.version >= 8));
});
test('payload over a D1 row limit uses bounded chunks and restores exact Unicode', async t => {
  const { call, DB } = harness(t); const workspace = fixtureWorkspace();
  for (let i = 0; i < 250; i++) workspace.projects[0].data.goals.push({ ...workspace.projects[0].data.goals[0], id: 'large-' + i, issueNumber: null, title: '検証'.repeat(1500) + '😀' });
  assert.ok(new TextEncoder().encode(JSON.stringify(workspace)).byteLength > 2000000);
  assert.equal((await call(undefined, { method: 'PUT', body: writeBody(workspace) })).status, 200);
  assert.deepEqual((await (await call()).json()).workspace.projects, workspace.projects);
  const rows = DB.sqlite.prepare('SELECT payload FROM progress_workspace_chunks').all(); assert.ok(rows.length > 1);
  assert.ok(rows.every(row => new TextEncoder().encode(row.payload).byteLength < 2000000));
  const boundary = 'x'.repeat(256 * 1024 - 1) + '😀more'; assert.equal(splitPayload(boundary).join(''), boundary); assert.ok(!/[\uD800-\uDBFF]$/.test(splitPayload(boundary)[0]));
});
test('malformed, unsupported content type, unbounded body and unsafe version are rejected before writes', async t => {
  const { DB, call } = harness(t);
  assert.equal((await call(undefined, { method: 'PUT', body: '{broken' })).status, 400);
  assert.equal((await call(undefined, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await call(undefined, { method: 'PUT', body: 'x'.repeat(MAX_WORKSPACE_BYTES + 4097) })).status, 413);
  assert.equal((await call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace(), Number.MAX_SAFE_INTEGER) })).status, 400);
  assert.equal(tableCount(DB), 0);
});
test('invalid checksum metadata and missing chunk are safe corruption, not reset', async t => {
  const { DB, call } = harness(t); await call(undefined, { method: 'PUT', body: writeBody(fixtureWorkspace()) });
  DB.sqlite.prepare('DELETE FROM progress_workspace_chunks WHERE user_id = ?').run('qa-owner'); assert.equal((await call()).status, 409);
  DB.sqlite.prepare('UPDATE progress_workspaces SET chunk_count = 0 WHERE user_id = ?').run('qa-owner'); assert.equal((await call()).status, 409);
  assert.equal(DB.sqlite.prepare('SELECT version FROM progress_workspaces').get().version, 1);
});
