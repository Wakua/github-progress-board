import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../dist/github-snapshot.mjs';
import { buildPlanning } from '../scripts/github-planning-fetch.mjs';
import { hierarchyFixture } from './local-github-fixture.mjs';
import { githubScheduleInput, scheduleCompletion } from '../dist/github-schedule-input.mjs';
import { calculateMilestoneSchedule } from '../dist/milestone-schedule.mjs';

const repo = 'https://github.com/qa-local/board';
const issueKey = n => `${repo}/issues/${n}`;
const read = value => ({ value, problem: null });
const missing = { value: null, problem: 'not-fetched' };
const options = { baseDate: '2026-10-05', selectedProjectId: 'P1' };
function fixture() {
  const issuePages = [[1, 2].map(number => ({ number, html_url: issueKey(number), title: `QA ${number}`, state: 'open',
    updated_at: '2026-10-02T12:00:00Z', closed_at: null, milestone: { number: 1 } }))];
  const data = { repositoryUrl: repo, fetchedAt: '2026-10-03T12:00:00Z', issuePages, pullPages: [[]],
    hierarchyPages: [hierarchyFixture(issuePages[0])], milestonePages: [[{
      number: 1, html_url: `${repo}/milestone/1`, title: 'QA release', description: null, state: 'open',
      due_on: '2026-10-18T00:00:00Z', updated_at: '2026-10-02T12:00:00Z', closed_at: null,
    }]] };
  return buildSnapshot({ ...data, planning: buildPlanning(data) });
}
const project = (id, status) => ({ id, title: id, url: `https://github.com/users/qa/projects/${id === 'P1' ? 1 : 2}`,
  owner: 'Codex', status, priority: null, estimatePoints: 2,
  iteration: { id: 'I1', title: 'It1', startDate: '2026-10-05', duration: 7 } });

test('旧snapshotを変更せず変換し、未取得の進捗率を0にしない', () => {
  const snapshot = fixture();
  snapshot.planning.issues[0].projects = [project('P1', 'Todo')];
  const before = structuredClone(snapshot), input = githubScheduleInput(snapshot, options);
  assert.deepEqual(input.issues[0].planning.workProgressPercent, missing);
  assert.deepEqual(input.issues[0].planning.iteration, read({ startDate: '2026-10-05', endDate: '2026-10-11' }));
  assert.equal(input.milestones[0].dueDate, '2026-10-18');
  assert.deepEqual(snapshot, before);
  const result = calculateMilestoneSchedule(input);
  assert.equal(result.status, 'calculated');
  assert.equal(result.milestones[0].state, 'incomplete');
  assert.ok(result.diagnostics.some(d => d.field === 'workProgressPercent'));
});

test('出典ProjectがDoneでも、別ProjectのTodoを失わず未完了にする', () => {
  const snapshot = fixture();
  snapshot.planning.issues[0].projects = [project('P1', 'Done'), project('P2', 'Todo')];
  const input = githubScheduleInput(snapshot, options), issue = input.issues[0];
  assert.equal(issue.planning.status.value, 'Done');
  assert.equal(issue.completion.value, 'not-done');
  assert.ok(issue.completion.reasons.includes('状態が未確認：ProjectごとにStatusが異なる'));
  assert.equal(issue.planning.sourceProjectId, 'P1');
});

test('Closedは出典不明でも完了とし、未取得の進捗率で後続を止めない', () => {
  const snapshot = fixture();
  for (const item of snapshot.items) { item.state = 'closed'; item.closedAt = item.updatedAt; }
  const input = githubScheduleInput(snapshot, options);
  assert.equal(input.issues[0].completion.value, 'done');
  assert.equal(input.issues[0].planning.sourceProblem, 'not-member');
  assert.equal(calculateMilestoneSchedule(input).milestones[0].state, 'completed');
});

test('planningのない旧snapshotとblockedBy追加前の旧形式を区別する', () => {
  const snapshot = fixture();
  for (const m of snapshot.planning.issues) { delete m.blockedBy; delete m.pullRequests; delete m.spec; }
  const old = githubScheduleInput(snapshot, options);
  assert.equal(old.issues[0].completion.value, 'not-done');
  assert.equal(old.issues[0].blockedBy.problem, 'not-fetched');
  delete snapshot.planning;
  const bare = githubScheduleInput(snapshot, options);
  assert.equal(bare.issues[0].completion.value, 'unknown');
  assert.equal(bare.issues[0].children.complete, false);
  assert.equal(bare.issues[0].parent.problem, 'not-fetched');
  assert.deepEqual(bare.milestones, []);
});

test('repository込みで前提を保ち、親のblocked byも計算側へ渡す', () => {
  const snapshot = fixture(), [parent, child] = snapshot.planning.issues;
  parent.childCount = 1;
  child.parent = { number: 1, url: issueKey(1) };
  parent.blockedBy = [{ number: 2, url: 'https://github.com/qa-external/other/issues/2', title: 'QA external', state: 'open', spec: false }];
  const input = githubScheduleInput(snapshot, options);
  assert.deepEqual(input.milestones[0].tasks.keys, [issueKey(2)]);
  assert.deepEqual(input.issues[0].children.keys, [issueKey(2)]);
  assert.deepEqual(input.issues[0].blockedBy.keys, ['https://github.com/qa-external/other/issues/2']);
  assert.equal(calculateMilestoneSchedule(input).milestones[0].state, 'incomplete');
});

test('外部の子を未取得なら件数不足を残し、末端と推測しない', () => {
  const snapshot = fixture();
  snapshot.planning.issues[0].childCount = 1;
  const input = githubScheduleInput(snapshot, options);
  assert.deepEqual(input.issues[0].children, { keys: [], totalCount: 1, complete: false, problem: null });
  assert.equal(input.milestones[0].tasks.keys.includes(issueKey(1)), false);
});

test('明示した出典だけを使い、先頭Projectを自動選択しない', () => {
  const snapshot = fixture();
  snapshot.planning.issues[0].projects = [project('P1', 'Todo'), project('P2', 'In Progress')];
  const input = githubScheduleInput(snapshot, { ...options, sourceProjectIds: { [issueKey(1).toUpperCase()]: 'P2' } });
  assert.equal(input.issues[0].planning.status.value, 'In Progress');
  const unselected = githubScheduleInput(snapshot, { ...options, sourceProjectIds: { [issueKey(1)]: null } });
  assert.equal(unselected.issues[0].planning.sourceProblem, 'unselected');
  assert.deepEqual(unselected.issues[0].planning.estimatePoints, missing);
});

test('不足情報があっても、既知の値だけで確定する完了判定は維持する', () => {
  const done = { status: read('Done') }, todo = { status: read('Todo') }, unknown = { status: missing };
  assert.equal(scheduleCompletion(read('closed'), [], false).value, 'done');
  assert.equal(scheduleCompletion(read('open'), [done, unknown], true).value, 'unknown');
  assert.equal(scheduleCompletion(read('open'), [done], false).value, 'unknown');
  assert.equal(scheduleCompletion(read('open'), [todo, unknown], false).value, 'not-done');
  assert.equal(scheduleCompletion(missing, [todo], true).value, 'unknown');
  assert.equal(scheduleCompletion(missing, [done], true).value, 'done');
});
