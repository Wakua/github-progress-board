import test from 'node:test';
import assert from 'node:assert/strict';
import { setupProgress, updateProgress, numberField } from '../scripts/github-progress-update.mjs';
import { createProgressClient } from '../scripts/github-progress-client.mjs';
import { main } from '../scripts/update-github-progress.mjs';
import { calculateMilestoneSchedule } from '../dist/milestone-schedule.mjs';
import { attachSnapshot } from '../dist/github-snapshot.mjs';
import { githubScheduleInput } from '../dist/github-schedule-input.mjs';
import { scheduleFixture, scheduleSnapshot, repo, external, url } from './github-schedule-fixture.mjs';

const request = overrides => ({ issue: 7, actor: 'Codex', operation: 'task7-validation', progress: 60,
  expectedProgress: null, expectedEstimate: 5, reason: '実装3ptを確認した。\n検証2ptが残る。\nhttps://github.com/example/demo/pull/8', ...overrides });
function fixture() {
  const state = {
    project: { id: 'PVT_demo', url: 'https://github.com/users/example/projects/1', fields: [
      { id: 'progress', name: '作業進捗率', dataType: 'NUMBER' }, { id: 'estimate', name: 'Estimate', dataType: 'NUMBER' },
    ] },
    item: { id: 'item7', issueId: 'issue7', number: 7, url: 'https://github.com/example/demo/issues/7',
      state: 'OPEN', children: 0, archived: false, actor: 'Codex', values: { estimate: 5, status: 'In Progress', iteration: 'it5' } },
    comments: [], writes: [],
  };
  const client = {
    project: async () => structuredClone(state.project), item: async () => structuredClone(state.item),
    comments: async () => structuredClone(state.comments),
    comment: async (id, body) => { state.writes.push({ comment: body }); state.comments.push({ id: String(state.comments.length), body }); },
    setNumber: async (project, item, field, value) => { state.writes.push({ field, value }); state.item.values[field] = value; },
    createField: async () => { state.writes.push({ create: true }); state.project.fields.push({ id: 'new-progress', name: '作業進捗率', dataType: 'NUMBER' }); },
  };
  return { state, client };
}

test('preview does not mutate; explicit update records evidence and only changes progress', async () => {
  const { client, state } = fixture();
  const original = structuredClone(state.item);
  assert.equal((await updateProgress(client, request())).mode, 'preview');
  assert.deepEqual(state.writes, []);
  assert.equal((await updateProgress(client, request(), { apply: true })).mode, 'applied');
  assert.deepEqual(state.item, { ...original, values: { ...original.values, progress: 60 } });
  assert.match(state.writes[0].comment, /更新予定/);
  assert.deepEqual(state.writes[1], { field: 'progress', value: 60 });
  assert.match(state.writes[2].comment, /再取得で確認/);
  const count = state.writes.length;
  assert.equal((await updateProgress(client, request(), { apply: true })).mode, 'unchanged');
  assert.equal(state.writes.length, count);
});

test('setup previews, creates once, verifies and refuses wrong types/duplicates', async () => {
  const { client, state } = fixture();
  state.project.fields.shift();
  assert.equal((await setupProgress(client)).mode, 'preview');
  assert.equal(state.writes.length, 0);
  assert.equal((await setupProgress(client, { apply: true })).mode, 'created');
  assert.equal((await setupProgress(client, { apply: true })).mode, 'unchanged');
  assert.equal(state.writes.length, 1);
  assert.throws(() => numberField([{ name: '作業進捗率', dataType: 'TEXT' }], '作業進捗率'));
  state.project.fields.push(state.project.fields[1]);
  await assert.rejects(setupProgress(client, { apply: true }), /一意/);
});

test('invalid requests and unconfirmed initial zero cause no writes', async () => {
  for (const override of [ { progress: -1 }, { progress: 101 }, { progress: 0.5 }, { progress: '50' },
    { expectedProgress: undefined }, { expectedEstimate: undefined }, { estimate: 0 }, { estimate: NaN },
    { reason: '根拠なし' }, { operation: '' }, { progress: 0 }, { expectedEstimate: null },
  ]) {
    const { client, state } = fixture();
    await assert.rejects(updateProgress(client, request(override), { apply: true }));
    assert.equal(state.writes.length, 0);
  }
  const { client, state } = fixture();
  await updateProgress(client, request({ progress: 0, confirmUnstarted: true }), { apply: true });
  assert.equal(state.item.values.progress, 0);
});

test('wrong assignee, parent, closed, archived, stale estimates and stale progress stop', async () => {
  for (const override of [{ actor: 'Claude' }, { children: 1 }, { children: undefined }, { state: 'CLOSED' },
    { archived: true }, { number: 8 }, { values: { estimate: 6 } }, { values: { estimate: 5, progress: 20 } }]) {
    const { client, state } = fixture();
    Object.assign(state.item, override);
    await assert.rejects(updateProgress(client, request(), { apply: true }));
    assert.equal(state.writes.length, 0);
  }
});

test('failure at each mutation, including lost responses, resumes without duplicate writes/comments', async () => {
  for (const lostResponse of [false, true]) {
    for (let failAt = 1; failAt <= 4; failAt++) {
      const { client, state } = fixture();
      const originalComment = client.comment;
      const originalSet = client.setNumber;
      let calls = 0;
      const wrap = original => async (...args) => {
        calls++;
        if (calls === failAt && !lostResponse) throw new Error('通信失敗');
        await original(...args);
        if (calls === failAt) throw new Error('応答喪失');
      };
      client.comment = wrap(originalComment);
      client.setNumber = wrap(originalSet);
      const req = request({ estimate: 4 });
      await assert.rejects(updateProgress(client, req, { apply: true }), /停止/);
      client.comment = originalComment;
      client.setNumber = originalSet;
      await updateProgress(client, req, { apply: true });
      assert.equal(state.item.values.progress, 60);
      assert.equal(state.item.values.estimate, 4);
      assert.equal(state.comments.length, 2);
      assert.equal(state.writes.filter(write => write.field).length, 2);
    }
  }
});

test('retry refuses another operation payload and never restores later changes', async () => {
  const { client, state } = fixture();
  await updateProgress(client, request(), { apply: true });
  await assert.rejects(updateProgress(client, request({ progress: 70 }), { apply: true }), /別の変更/);
  state.item.values.progress = 80;
  await assert.rejects(updateProgress(client, request(), { apply: true }), /想定/);
  assert.equal(state.item.values.progress, 80);
});

test('changes between preview and mutation stop; unsuccessful readback is not success', async () => {
  const { client, state } = fixture();
  const comment = client.comment;
  client.comment = async (...args) => { await comment(...args); state.item.values.estimate = 9; };
  await assert.rejects(updateProgress(client, request(), { apply: true }), /想定/);
  assert.equal(state.writes.filter(write => write.field).length, 0);
  const other = fixture();
  other.client.setNumber = async () => {};
  await assert.rejects(updateProgress(other.client, request(), { apply: true }), /想定/);
  assert.equal(other.state.comments.length, 1);
});

test('setup tolerates lost response by reusing field on retry', async () => {
  const { client, state } = fixture();
  state.project.fields.shift();
  const create = client.createField;
  client.createField = async (...args) => { await create(...args); throw new Error('timeout'); };
  await assert.rejects(setupProgress(client, { apply: true }));
  assert.equal((await setupProgress(client, { apply: true })).mode, 'unchanged');
  assert.equal(state.writes.length, 1);
});

const connection = nodes => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false } });
test('client binds selected project, rejects incomplete reads and writes only narrow GraphQL inputs', async () => {
  const calls = [];
  const client = createProgressClient({ projectId: 'PVT_demo', repository: 'example/demo' }, async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('updateProjectV2ItemFieldValue')) return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.input.itemId } } };
    if (query.includes('addComment')) return { addComment: { commentEdge: { node: { id: 'comment' } } } };
    return { node: { id: 'PVT_demo', url: 'https://github.com/users/example/projects/1', fields: { ...connection([]), pageInfo: { hasNextPage: true } } } };
  });
  await assert.rejects(client.project(), /全件/);
  await client.setNumber('PVT_demo', 'item', 'field', 30);
  assert.deepEqual(calls.at(-1).variables.input, { projectId: 'PVT_demo', itemId: 'item', fieldId: 'field', value: { number: 30 } });
  await client.comment('issue', 'evidence');
  assert.deepEqual(calls.at(-1).variables.input, { subjectId: 'issue', body: 'evidence' });
});

test('incomplete mutation responses are failures, and 100 percent never closes the Issue', async () => {
  const client = createProgressClient({ projectId: 'PVT_demo', repository: 'example/demo' }, async () => ({}));
  await assert.rejects(client.createField('PVT_demo', '作業進捗率'), /応答/);
  await assert.rejects(client.comment('issue', 'evidence'), /応答/);
  await assert.rejects(client.setNumber('PVT_demo', 'item', 'field', 10), /応答/);
  const f = fixture();
  await updateProgress(f.client, request({ progress: 100 }), { apply: true });
  assert.equal(f.state.item.state, 'OPEN');
  assert.equal(f.state.item.values.status, 'In Progress');
});

test('client paginates all comments and refuses inconsistent counts', async () => {
  const client = createProgressClient({ projectId: 'PVT_demo', repository: 'example/demo' }, async (query, variables) => ({
    repository: { issue: { comments: { totalCount: 2, nodes: [{ id: variables.cursor ? '2' : '1', body: 'text' }],
      pageInfo: { hasNextPage: !variables.cursor, endCursor: 'next' } } } },
  }));
  assert.equal((await client.comments(7)).length, 2);
  const bad = createProgressClient({ projectId: 'PVT_demo', repository: 'example/demo' }, async () => ({
    repository: { issue: { comments: { ...connection([]), totalCount: 1 } } },
  }));
  await assert.rejects(bad.comments(7), /件数/);
});

test('client selects matching project and reads zero separately from unset', async () => {
  const item = { id: 'item', isArchived: false, project: { id: 'PVT_demo' }, fieldValues: connection([
    { number: 0, field: { id: 'progress', name: '作業進捗率' } },
    { name: 'Codex', field: { id: 'actor', name: '担当' } },
  ]) };
  const client = createProgressClient({ projectId: 'PVT_demo', repository: 'example/demo' }, async () => ({ repository: { issue: {
    id: 'issue7', number: 7, url: 'https://github.com/example/demo/issues/7', state: 'OPEN', subIssuesSummary: { total: 0 },
    projectItems: connection([{ ...item, project: { id: 'PVT_other' } }, item]),
  } } }));
  const result = await client.item(7);
  assert.equal(result.values.progress, 0);
  assert.equal(result.values.estimate, undefined);
  assert.equal(result.actor, 'Codex');
  item.fieldValues.pageInfo.hasNextPage = true;
  await assert.rejects(client.item(7), /全件/);
});

test('CLI rejects unknown options and mixed setup/update before any network operation', async () => {
  await assert.rejects(main(['--all']));
  await assert.rejects(main(['--project-id', 'PVT_demo', '--repo', 'example/demo', '--setup', '--issue', '7']), /別々/);
});

test('進捗更新後の取得snapshotを再取込して日程を変え、空欄の再取込では日程を確定しない', async () => {
  const { client, state } = fixture();
  const data = scheduleFixture();
  const rawFields = data.hierarchyPages[0].data.repository.issues.nodes[0].projectItems.nodes[0].fieldValues;
  rawFields.nodes.find(value => value.field.name === 'Estimate').number = 5;
  state.project.id = 'P1';
  state.project.fields.forEach(field => { field.id = `P1-${field.name}`; });
  Object.assign(state.item, { number: 1, url: url(1), values: { 'P1-Estimate': 5, 'P1-作業進捗率': 0 } });
  const setNumber = client.setNumber;
  client.setNumber = async (projectId, itemId, fieldId, value) => {
    await setNumber(projectId, itemId, fieldId, value);
    rawFields.nodes.find(entry => entry.field.id === fieldId).number = value;
  };
  const project = { id: 'qa', repositoryUrl: repo };
  const options = { baseDate: '2026-10-05', selectedProjectId: 'P1',
    sourceProjectIds: Object.fromEntries([1, 2, 3, 4, 5].map(n => [url(n, external), 'P2'])) };
  const reimport = async () => {
    // Use #125's collector, snapshot builder/validator and importer, not a hand-built ScheduleInput.
    attachSnapshot(project, await scheduleSnapshot(data));
    const input = githubScheduleInput(project.githubSnapshot, options);
    return { input, result: calculateMilestoneSchedule(input) };
  };
  const first = await reimport();
  assert.equal(first.result.tasks.find(task => task.key === url(1)).durationDays, 5);
  assert.equal(first.result.milestones[0].finish.coordinate, 7);
  assert.equal(state.writes.length, 0);

  await updateProgress(client, request({ issue: 1, expectedProgress: 0 }), { apply: true });
  const writes = state.writes.length;
  data.fetchedAt = '2026-10-03T12:01:00Z';
  const updated = await reimport();
  assert.equal(updated.input.fetchedAt, data.fetchedAt);
  assert.deepEqual(updated.input.issues.find(issue => issue.key === url(1)).planning.workProgressPercent, { value: 60, problem: null });
  assert.equal(updated.result.tasks.find(task => task.key === url(1)).durationDays, 2);
  assert.equal(updated.result.milestones[0].finish.coordinate, 4);

  // A later read can return an empty field. It must replace the old 60%, without becoming zero.
  rawFields.nodes = rawFields.nodes.filter(entry => entry.field.name !== '作業進捗率');
  rawFields.totalCount = rawFields.nodes.length;
  data.fetchedAt = '2026-10-03T12:02:00Z';
  const missing = await reimport();
  assert.deepEqual(missing.input.issues.find(issue => issue.key === url(1)).planning.workProgressPercent, { value: null, problem: null });
  assert.equal(missing.result.milestones[0].state, 'incomplete');
  assert.equal(missing.result.milestones[0].finish, null);
  assert.ok(missing.result.diagnostics.some(diagnostic => diagnostic.field === 'workProgressPercent'));
  assert.equal(state.writes.length, writes);
});
