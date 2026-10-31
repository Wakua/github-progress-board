import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleFixture, scheduleSnapshot, repo, external, at, url, projectNode, connection } from './github-schedule-fixture.mjs';
import { githubScheduleInput } from '../dist/github-schedule-input.mjs';
import { calculateMilestoneSchedule } from '../dist/milestone-schedule.mjs';
import { validateSnapshot, attachSnapshot } from '../dist/github-snapshot.mjs';
import { createGithubRefresher } from '../scripts/local-github-refresh.mjs';
import { scheduleIssueQuery } from '../scripts/github-schedule-fetch.mjs';
import { buildPlanning } from '../scripts/github-planning-fetch.mjs';

const options = { baseDate: '2026-10-05', selectedProjectId: 'P1', sourceProjectIds: Object.fromEntries([1, 2, 3, 4, 5].map(n => [url(n, external), 'P2'])) };

test('外部集約の末端・祖先の前提を取得し、祖先の兄弟作業は取得しない', async () => {
  const data = scheduleFixture(), snapshot = await scheduleSnapshot(data);
  assert.deepEqual(new Set(data.reads), new Set([1, 2, 3, 4, 5].map(n => url(n, external))));
  assert.equal(snapshot.planning.schedule.issues.length, 7);
  const issue = snapshot.planning.schedule.issues.find(i => i.key === url(1));
  assert.deepEqual(issue.projects[0].workProgressPercent, { value: 0, problem: null });
  assert.deepEqual(issue.projects[0].fieldSources.workProgressPercent, { id: 'P1-作業進捗率', name: '作業進捗率' });
  const input = githubScheduleInput(snapshot, options), result = calculateMilestoneSchedule(input);
  assert.equal(result.status, 'calculated');
  assert.equal(result.milestones[0].state, 'calculated');
  assert.equal(result.milestones[0].finish.coordinate, 3);
  assert.ok(result.tasks.some(t => t.key === url(2, external)));
  assert.ok(!result.tasks.some(t => t.key === url(6, external)));
});

test('外部Issueの出典を指定しなければ先頭Projectを選ばず未確定にする', async () => {
  const snapshot = await scheduleSnapshot();
  const input = githubScheduleInput(snapshot, { ...options, sourceProjectIds: {} });
  const issue = input.issues.find(i => i.key === url(2, external));
  assert.equal(issue.planning.sourceProblem, 'unselected');
  assert.equal(calculateMilestoneSchedule(input).milestones[0].state, 'incomplete');
});

test('取得済み空欄・不正な進捗率・100%の未完了を別々に計算へ渡す', async () => {
  for (const [progress, expected] of [[null, 'incomplete'], [-1, 'incomplete'], [101, 'incomplete'], [100, 'calculated'], [50, 'calculated']]) {
    const data = scheduleFixture();
    data.hierarchyPages[0].data.repository.issues.nodes[0].projectItems = connection([projectNode('P1', progress)]);
    const snapshot = await scheduleSnapshot(data), input = githubScheduleInput(snapshot, options), issue = input.issues.find(i => i.key === url(1));
    assert.deepEqual(issue.planning.workProgressPercent, { value: progress, problem: null });
    assert.equal(issue.completion.value, 'not-done');
    const result = calculateMilestoneSchedule(input);
    assert.equal(result.milestones[0].state, expected);
    if (progress === 100) assert.equal(result.tasks.find(t => t.key === url(1)).durationDays, 0);
  }
});

test('フィールド値一覧に進捗率がなければ空欄とし、旧snapshotの未取得と区別する', async () => {
  const data = scheduleFixture(), item = data.hierarchyPages[0].data.repository.issues.nodes[0].projectItems.nodes[0];
  item.fieldValues = connection(item.fieldValues.nodes.filter(v => v.field.name !== '作業進捗率'));
  const snapshot = await scheduleSnapshot(data);
  assert.deepEqual(githubScheduleInput(snapshot, options).issues.find(i => i.key === url(1)).planning.workProgressPercent, { value: null, problem: null });
  delete snapshot.planning.schedule;
  assert.deepEqual(githubScheduleInput(snapshot, options).issues.find(i => i.key === url(1)).planning.workProgressPercent, { value: null, problem: 'not-fetched' });
});

test('外部の取得権限・途中失敗・取得予算・接続の上限を区別する', async () => {
  for (const [overrides, code] of [
    [{ readIssue: async () => ({ errors: [{ type: 'FORBIDDEN' }] }) }, 'schedule_forbidden'],
    [{ readIssue: async () => ({ errors: [{ type: 'INTERNAL' }] }) }, 'schedule_failed'],
    [{ readIssue: async () => ({ data: { repository: null } }) }, 'schedule_failed'],
    [{ maxRequests: 1 }, 'schedule_limit'],
  ]) await assert.rejects(scheduleSnapshot(scheduleFixture(), overrides), { code });
  for (const field of ['subIssues', 'blockedBy', 'projectItems']) {
    const data = scheduleFixture(); data.externalNodes.get(url(1, external))[field].pageInfo.hasNextPage = true;
    await assert.rejects(scheduleSnapshot(data), { code: 'schedule_limit' });
  }
  const data = scheduleFixture();
  data.externalNodes.get(url(1, external)).projectItems.nodes[0].fieldValues.pageInfo.hasNextPage = true;
  await assert.rejects(scheduleSnapshot(data), { code: 'schedule_limit' });
});

test('snapshot validatorは外部キーの重複・親子矛盾・既存計画との不一致を拒否する', async () => {
  const original = await scheduleSnapshot();
  for (const mutate of [
    s => s.issues.push(structuredClone(s.issues[0])),
    s => { s.issues[0].key = 'https://evil.test/qa/issues/1'; },
    s => { s.issues.find(i => i.key === url(1)).projects[0].status.value = 'Done'; },
    s => { s.issues.find(i => i.key === url(1)).state.value = 'closed'; },
    s => { s.issues.find(i => i.key === url(2, external)).parent.value = null; },
    s => { s.issues[0].children.complete = true; s.issues[0].children.totalCount = 900; },
    s => { s.issues[0].projects[0].workProgressPercent = { value: 20, problem: 'forbidden' }; },
    s => { s.issues[0].projects[0].fieldSources.workProgressPercent.name = 'Estimate'; },
  ]) {
    const snapshot = structuredClone(original); mutate(snapshot.planning.schedule);
    assert.throws(() => validateSnapshot(snapshot));
  }
});

test('外部Projectの取得不足と不正な日付を手動取込でも診断へ渡す', async () => {
  const snapshot = await scheduleSnapshot(), issue = snapshot.planning.schedule.issues.find(i => i.key === url(2, external));
  issue.projects = []; issue.projectsComplete = false; issue.projectsProblem = 'forbidden';
  validateSnapshot(snapshot);
  const input = githubScheduleInput(snapshot, options), value = input.issues.find(i => i.key === issue.key);
  assert.equal(value.completion.value, 'unknown');
  assert.equal(value.planning.sourceProblem, 'unavailable');
  assert.deepEqual(value.planning.workProgressPercent, { value: null, problem: 'forbidden' });
  assert.equal(calculateMilestoneSchedule(input).milestones[0].state, 'incomplete');
  const data = scheduleFixture();
  const iteration = data.externalNodes.get(url(2, external)).projectItems.nodes[0].fieldValues.nodes.find(v => v.field.name === 'Iteration');
  iteration.startDate = '2026-02-30';
  const invalidDateInput = githubScheduleInput(await scheduleSnapshot(data), options);
  assert.equal(invalidDateInput.issues.find(i => i.key === issue.key).planning.iteration.value.startDate, '2026-02-30');
  assert.equal(calculateMilestoneSchedule(invalidDateInput).milestones[0].state, 'incomplete');
});

test('外部Issueの更新日時が古くなった再取得も保存済みデータを保持する', async () => {
  const snapshot = await scheduleSnapshot(), project = { id: 'qa', repositoryUrl: repo };
  attachSnapshot(project, snapshot); const before = structuredClone(project);
  const incoming = structuredClone(snapshot); incoming.fetchedAt = '2026-10-03T12:01:00Z';
  incoming.planning.schedule.issues.find(i => i.key === url(2, external)).updatedAt = '2026-10-01T12:00:00Z';
  assert.throws(() => attachSnapshot(project, incoming), /外部Issue/);
  assert.deepEqual(project, before);
});

function mockRun(data, failure, remaining = () => 5000) {
  return async (_, args) => {
    const query = args.at(-1);
    if (args[3] !== 'graphql') return { stdout: JSON.stringify(query.includes('/issues?') ? data.issuePages[0] : query.includes('/pulls?') ? [] : data.milestonePages[0]) };
    const number = query.match(/issue\(number:(\d+)\)/)?.[1];
    let response;
    if (number) response = failure() || await data.readIssue(url(Number(number), external));
    else response = structuredClone(data.hierarchyPages[0]);
    if (response.data) response.data.rateLimit = { remaining: remaining(), resetAt: '2026-10-03T13:00:00Z' };
    return { stdout: JSON.stringify(response) };
  };
}

test('再取得の途中で失敗したら保存済みsnapshotを保持し、再試行で新しい値を取得する', async () => {
  const data = scheduleFixture(); let clock = Date.parse(at), failed = false;
  const refresher = createGithubRefresher({ repositories: [repo], now: () => clock, run: mockRun(data, () => failed ? { errors: [{ type: 'FORBIDDEN' }] } : null) });
  const project = { id: 'qa', repositoryUrl: repo }, first = await refresher.refresh(repo);
  attachSnapshot(project, first); const before = structuredClone(project);
  failed = true; clock += 16000;
  await assert.rejects(refresher.refresh(repo), { code: 'schedule_forbidden' });
  assert.deepEqual(project, before);
  failed = false;
  const fresh = await refresher.refresh(repo); attachSnapshot(project, fresh);
  assert.notEqual(project.githubSnapshot.fetchedAt, before.githubSnapshot.fetchedAt);
});

test('外部取得もGraphQL予約枠を守り、足りなければ次のIssueを読まない', async () => {
  const data = scheduleFixture(); let count = 0;
  const refresher = createGithubRefresher({ repositories: [repo], now: () => Date.parse(at), run: mockRun(data, () => null, () => ++count === 1 ? 5000 : 999) });
  await assert.rejects(refresher.refresh(repo), { code: 'rate_limited' });
  assert.equal(data.reads.length, 1);
});

test('追加queryはGitHub Issue URLから固定の読取りqueryだけを組み立てる', () => {
  const query = scheduleIssueQuery(url(2, external));
  assert.match(query, /subIssues\(first:100\)/); assert.match(query, /blockedBy\(first:100\)/);
  assert.ok(!query.includes('mutation'));
  assert.throws(() => scheduleIssueQuery('https://evil.test/a/b/issues/2'));
});

test('旧planningの構造と集計値を拡張取得で変更しない', async () => {
  const data = scheduleFixture(), legacy = buildPlanning(data), snapshot = await scheduleSnapshot(data);
  const { schedule, ...actual } = snapshot.planning;
  assert.deepEqual(actual, legacy);
  assert.ok(schedule);
});
