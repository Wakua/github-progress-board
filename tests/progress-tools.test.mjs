import test from 'node:test';
import assert from 'node:assert/strict';
import { registerProgressTools } from '../dist/progress-tools.mjs';
import { createWorkspaceStore, STORAGE_KEY, addTask } from '../dist/workspace.mjs';
import { fixtureWorkspace, memoryStorage } from './cloud-fixtures.mjs';
test('read_progress uses the same stored state, labels provenance, validates IDs and does not write', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(fixtureWorkspace()) }), before = [...storage.values], store = createWorkspaceStore(storage);
  let tool, signal; const dispose = registerProgressTools({ registerTool(value, options) { tool = value; signal = options.signal; } }, store);
  assert.equal(tool.name, 'read_progress'); assert.deepEqual(tool.annotations, { readOnlyHint: true, untrustedContentHint: true });
  assert.equal(tool.execute({}).projects[0].next.title, store.snapshot().projects[0].data.tasks[0].title);
  assert.equal(tool.execute({ projectId: 'project-one' }).storage, 'browser');
  assert.throws(() => tool.execute({ projectId: 'unknown' })); assert.throws(() => tool.execute({ extra: true }));
  assert.deepEqual([...storage.values], before); dispose(); assert.equal(signal.aborted, true);
});
test('unsupported/failed WebMCP registration never blocks app initialization', () => {
  assert.doesNotThrow(() => registerProgressTools(undefined, {}));
  assert.doesNotThrow(() => registerProgressTools({ registerTool() { throw new Error('Not supported'); } }, {}));
});
test('read_progress distinguishes action from an unfinished prerequisite and preserves manual data', () => {
  const workspace = fixtureWorkspace(), project = workspace.projects[0], task = project.data.tasks[0];
  task.waitReason = '仕様を確認する';
  const waiting = addTask(project.data, project.id, { title: '前提を待つ作業', goalId: task.goalId, status: 'todo' }, () => 'task-waiting');
  waiting.deps = [task.id];
  const raw = JSON.stringify(workspace), storage = memoryStorage({ [STORAGE_KEY]: raw }), store = createWorkspaceStore(storage);
  let tool;
  registerProgressTools({ registerTool(value) { tool = value; } }, store);
  const result = tool.execute({}).projects[0];
  assert.equal(result.next, null);
  assert.deepEqual(result.action, [{ id: task.id, title: task.title, reasons: ['待ち：仕様を確認する'] }]);
  assert.deepEqual(result.review, []);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(store.snapshot(), workspace);
});
