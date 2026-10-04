import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, validateSnapshot, attachSnapshot } from '../dist/github-snapshot.mjs';
import { githubPlan, githubProgress, githubModules } from '../dist/github-planning.mjs';
import { renderGithubWork, renderGithubPeriods, githubItemPlanning, githubProgressMarkup } from '../dist/github-planning-view.mjs';
import { buildPlanning } from '../scripts/github-planning-fetch.mjs';
import { createGithubRefresher } from '../scripts/local-github-refresh.mjs';
import { hierarchyFixture, qaWorkspace } from './local-github-fixture.mjs';

const repo = 'https://github.com/qa-local/board';
const at = '2026-10-03T12:00:00Z';
const connection = nodes => ({ totalCount: nodes.length, pageInfo: { hasNextPage: false }, nodes });
const single = (field, name) => ({ __typename: 'ProjectV2ItemFieldSingleSelectValue', name, field: { name: field } });
const project = (id, owner, status, points = 2, iteration = 'it1') => ({
  project: { id, title: id, url: 'https://github.com/users/Wakua/projects/' + (id === 'P1' ? 3 : 4) },
  fieldValues: connection([single('担当', owner), single('Status', status),
    { __typename: 'ProjectV2ItemFieldNumberValue', number: points, field: { name: 'Estimate' } },
    { __typename: 'ProjectV2ItemFieldIterationValue', iterationId: iteration, title: iteration, startDate: '2026-10-05', duration: 7, field: { name: 'Iteration' } }]),
});
function inputs() {
  const records = [1, 2, 3, 4, 5, 6].map(number => ({ number, html_url: repo + '/issues/' + number, title: 'QA Issue ' + number,
    state: number === 4 ? 'closed' : 'open', updated_at: '2026-10-02T12:00:00Z', closed_at: number === 4 ? '2026-10-02T11:00:00Z' : null,
    milestone: [1, 3, 4].includes(number) ? { number: 1 } : null }));
  const response = hierarchyFixture(records), nodes = response.data.repository.issues.nodes;
  nodes[0].subIssuesSummary.total = 2;
  nodes[1].parent = { number: 1, url: records[0].html_url }; nodes[1].subIssuesSummary.total = 1;
  nodes[2].parent = { number: 2, url: records[1].html_url };
  nodes[3].parent = { number: 1, url: records[0].html_url };
  nodes[5].parent = { number: 7, url: 'https://github.com/qa-fixture/other/issues/7' };
  nodes[1].projectItems = connection([project('P1', 'Codex', 'Todo', 999)]);
  nodes[2].projectItems = connection([project('P1', 'Codex', 'In Progress')]);
  nodes[3].projectItems = connection([project('P1', 'Wakua', 'Done', 1)]);
  nodes[4].projectItems = connection([project('P1', 'Codex', 'Todo', 3, 'it2'), project('P2', 'Claude', 'In Progress', 8)]);
  return { repositoryUrl: repo, fetchedAt: at, issuePages: [records], pullPages: [[]],
    milestonePages: [[{ number: 1, html_url: repo + '/milestone/1', title: 'QA release', description: null, state: 'open',
      due_on: '2026-10-18T00:00:00Z', updated_at: '2026-10-02T12:00:00Z', closed_at: null }]], hierarchyPages: [response] };
}
const snapshot = data => buildSnapshot({ ...data, planning: buildPlanning(data) });

test('親は目標と集約に使い、作業・期間・Milestoneには末端Issueだけを一度ずつ数える', () => {
  const value = snapshot(inputs()), plan = githubPlan(value);
  assert.deepEqual(plan.tasks.map(t => t.number), [3, 4, 5, 6]);
  assert.deepEqual(plan.goals.map(g => [g.number, g.tasks.map(t => t.number)]), [[1, [3, 4]]]);
  assert.equal(plan.tasks.find(t => t.number === 5).goal, null);
  assert.equal(plan.tasks.find(t => t.number === 6).goal, null);
  assert.deepEqual(plan.releases[0].tasks.map(t => t.number), [3, 4]);
  assert.deepEqual(plan.periods.find(p => p.key === 'P1:it1').tasks.map(t => t.number), [3, 4]);
  assert.equal(plan.tasks.some(t => t.projects.some(p => p.estimatePoints === 999)), false);
  assert.equal(value.items.every(i => i.estimatePoints === null && i.deadline === null), true);
});

test('複数Projectの担当と割当を保ち、未設定・未取得とClosedの受入未確認を表示する', () => {
  const value = snapshot(inputs());
  const work = renderGithubWork(value, { owner: 'Claude' });
  assert.ok(work.includes('data-github-task="5"'));
  assert.ok(!work.includes('data-github-task="3"'));
  assert.ok(work.includes('P1：Codex') && work.includes('P2：Claude'));
  assert.ok(work.includes('受入完了は未確認'));
  assert.ok(renderGithubPeriods(value).includes('リリース（Milestone）'));
  value.planning.issues[2].projects[0].owner = null;
  assert.ok(githubItemPlanning(value, 3).includes('未設定'));
  delete value.planning;
  validateSnapshot(value, { now: Date.parse(at) });
  assert.equal(githubPlan(value), null);
  assert.ok(renderGithubWork(value).includes('未取得'));
});

test('計画の循環・欠落・異なる出典・不正な属性・重複を拒否する', () => {
  const original = snapshot(inputs());
  for (const mutate of [
    v => { v.planning.issues[0].parent = { number: 3, url: repo + '/issues/3' }; },
    v => v.planning.issues.pop(),
    v => { v.planning.issues[2].parent = { number: 99, url: repo + '/issues/99' }; },
    v => { v.planning.issues[0].childCount = 0; },
    v => { v.planning.issues[2].milestoneNumber = 99; },
    v => { v.planning.issues[2].projects[0].estimatePoints = -1; },
    v => { v.planning.issues[2].projects[0].iteration.startDate = '2026-02-30'; },
    v => { v.planning.issues[2].projects[0].url = 'javascript:alert(1)'; },
    v => { v.planning.issues[2].projects[0].iteration.duration = 8; },
    v => { v.planning.issues[2].projects[0].title = '別Project'; },
    v => v.planning.issues[2].projects.push(structuredClone(v.planning.issues[2].projects[0])),
    v => { v.planning.sources.hierarchy.complete = false; },
    v => { v.planning.sources.milestones.urls[0] = 'https://api.github.com/repos/other/repo/milestones'; },
    v => { v.planning.milestones[0].updatedAt = '2027-01-01T00:00:00Z'; },
  ]) {
    const value = structuredClone(original); mutate(value); assert.throws(() => validateSnapshot(value, { now: Date.parse(at) }));
  }
});

test('GraphQLの権限エラーと未取得の次ページ、RESTとの取得中の変更を拒否する', () => {
  for (const mutate of [
    d => { d.hierarchyPages[0].errors = [{ message: 'QA denied' }]; },
    d => { d.hierarchyPages[0].data.repository.issues.totalCount++; },
    d => { d.hierarchyPages[0].data.repository.issues.pageInfo.hasNextPage = true; },
    d => { d.hierarchyPages[0].data.repository.issues.nodes[2].projectItems.pageInfo.hasNextPage = true; },
    d => { d.hierarchyPages[0].data.repository.issues.nodes[2].projectItems.nodes[0].fieldValues.pageInfo.hasNextPage = true; },
    d => { d.hierarchyPages[0].data.repository.issues.nodes[2].updatedAt = at; },
    d => { d.hierarchyPages[0].data.repository.issues.nodes[2].projectItems.nodes[0].fieldValues.nodes[0].__typename = 'ProjectV2ItemFieldTextValue'; },
  ]) { const d = inputs(); mutate(d); assert.throws(() => snapshot(d)); }
});

test('GraphQLとMilestoneも次ページを読み、途中エラーをキャッシュしない', async () => {
  const record = inputs().issuePages[0][0];
  const records = Array.from({ length: 101 }, (_, i) => ({ ...record, number: i + 1, html_url: repo + '/issues/' + (i + 1), milestone: null }));
  const nodes = hierarchyFixture(records).data.repository.issues.nodes;
  const milestones = Array.from({ length: 101 }, (_, i) => ({ ...inputs().milestonePages[0][0], number: i + 1, html_url: repo + '/milestone/' + (i + 1) }));
  let reads = 0, fail = false;
  const run = async (_, args) => {
    reads++;
    if (args[3] === 'graphql') {
      if (fail) return { stdout: JSON.stringify({ errors: [{ message: 'QA secret denied' }] }) };
      const second = args.at(-1).includes('after:"cursor1"');
      return { stdout: JSON.stringify({ data: { repository: { issues: { totalCount: 101,
        pageInfo: { hasNextPage: !second, endCursor: second ? null : 'cursor1' }, nodes: second ? nodes.slice(100) : nodes.slice(0, 100) } } } }) };
    }
    const route = args.at(-1);
    return { stdout: JSON.stringify(route.includes('/issues?') ? (route.endsWith('page=1') ? records.slice(0, 100) : records.slice(100)) : route.includes('/milestones?') ? (route.endsWith('page=1') ? milestones.slice(0, 100) : milestones.slice(100)) : []) };
  };
  let clock = Date.parse(at);
  const refresher = createGithubRefresher({ repositories: [repo], run, now: () => clock });
  assert.equal((await refresher.refresh(repo.toLowerCase())).planning.issues.length, 101);
  assert.equal(reads, 7);
  clock += 16000; fail = true;
  await assert.rejects(refresher.refresh(repo.toLowerCase()), { code: 'invalid_snapshot' });
  fail = false;
  assert.equal((await refresher.refresh(repo.toLowerCase())).planning.issues.length, 101);
});

test('新しいProject値はsnapshotだけを更新し、失敗時は手動計画と直前snapshotを保全する', () => {
  const projectData = qaWorkspace().projects[0], manual = structuredClone(projectData.data);
  const initial = snapshot(inputs()); attachSnapshot(projectData, initial, Date.parse(at));
  const d = inputs(); d.fetchedAt = '2026-10-03T12:01:00Z';
  d.hierarchyPages[0].data.repository.issues.nodes[2].projectItems.nodes[0].fieldValues.nodes[0].name = 'Wakua';
  attachSnapshot(projectData, snapshot(d), Date.parse(d.fetchedAt));
  assert.equal(projectData.githubSnapshot.planning.issues[2].projects[0].owner, 'Wakua');
  assert.deepEqual(projectData.data, manual);
  const before = structuredClone(projectData);
  const bad = snapshot(inputs()); bad.fetchedAt = '2026-10-03T12:02:00Z'; bad.planning.issues.pop();
  assert.throws(() => attachSnapshot(projectData, bad, Date.parse(bad.fetchedAt)));
  assert.deepEqual(projectData, before);
});

test('GitHubの文字列をHTMLとして実行せず、Project別の状態と期日を表示する', () => {
  const d = inputs(); d.issuePages[0][2].title = '<img src=x onerror=alert(1)>';
  d.milestonePages[0][0].description = '<script>QA</script>';
  const value = snapshot(d), html = renderGithubPeriods(value) + renderGithubWork(value);
  assert.ok(html.includes('&lt;img') && html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('2026-10-05–2026-10-11') && html.includes('2026-10-18'));
});

const labelledInputs = () => { const data = inputs(); for (const record of data.issuePages[0]) record.labels = []; return data; };
test('親と中間Issueのモジュールラベルを継承し、作業自身の明示ラベルを優先する', () => {
  const data = labelledInputs();
  data.issuePages[0][0].labels = [{ name: 'module:進捗管理' }, { name: 'enhancement' }];
  data.issuePages[0][3].labels = [{ name: 'module:バグ管理' }];
  const plan = githubPlan(snapshot(data));
  assert.deepEqual(plan.tasks.find(t => t.number === 3).module, { kind: 'assigned', name: '進捗管理', source: 1 });
  assert.deepEqual(plan.tasks.find(t => t.number === 4).module, { kind: 'assigned', name: 'バグ管理', source: 4 });
  assert.equal(plan.tasks.find(t => t.number === 5).module.kind, 'unassigned');
  assert.deepEqual(githubModules(plan).filter(m => m.kind === 'assigned').map(m => [m.name, m.tasks.map(t => t.number), m.goals[0].tasks.map(t => t.number)]), [['バグ管理', [4], [4]], ['進捗管理', [3], [3]]]);
  assert.equal(githubModules(plan).reduce((n, m) => n + m.tasks.length, 0), plan.tasks.length);
});
test('複数モジュールの共有作業を各モジュールに含め、全体では一度だけ数える', () => {
  const data = labelledInputs();
  data.issuePages[0][1].labels = [{ name: 'module:進捗管理' }, { name: 'module:バグ管理' }];
  const plan = githubPlan(snapshot(data)), task = plan.tasks.find(t => t.number === 3);
  assert.deepEqual(task.module, { kind: 'assigned', name: '進捗管理 / バグ管理', names: ['進捗管理', 'バグ管理'], source: 2 });
  const modules = githubModules(plan).filter(m => m.kind === 'assigned');
  assert.equal(modules.length, 2);
  for (const module of modules) { assert.deepEqual(module.tasks.map(t => t.number), [3]); assert.equal(githubProgress(module.tasks).totalPoints, 2); }
  const whole = githubProgress(githubModules(plan).flatMap(m => m.tasks));
  assert.equal(whole.total, plan.tasks.length);
  assert.equal(whole.closed, 1);
  assert.equal(githubProgress(plan.tasks).total, plan.tasks.length);
});
test('旧snapshotのモジュール未取得と、ラベルを取得した未分類を区別する', () => {
  const legacy = snapshot(inputs()), current = snapshot(labelledInputs());
  validateSnapshot(legacy, { now: Date.parse(at) });
  assert.equal(githubPlan(legacy).tasks.every(t => t.module.kind === 'unfetched'), true);
  assert.equal(githubPlan(current).tasks.every(t => t.module.kind === 'unassigned'), true);
  assert.ok(renderGithubPeriods(legacy).includes('モジュール情報未取得'));
  assert.ok(renderGithubPeriods(current).includes('モジュール未分類'));
});
test('モジュールの部分取得と不正なラベルを保存しない', () => {
  const original = snapshot(labelledInputs());
  for (const mutate of [
    v => { delete v.planning.issues[0].moduleLabels; },
    v => { v.planning.issues[0].moduleLabels = ['bug']; },
    v => { v.planning.issues[0].moduleLabels = ['module: ']; },
    v => { v.planning.issues[0].moduleLabels = ['module:a', 'module:a']; },
    v => { v.planning.issues[0].moduleLabels = null; },
  ]) { const value = structuredClone(original); mutate(value); assert.throws(() => validateSnapshot(value, { now: Date.parse(at) })); }
  const data = labelledInputs(); data.issuePages[0][0].labels = [{ color: 'invalid' }];
  assert.throws(() => snapshot(data));
});
test('末端Issueの見積で重みを付け、Closedだけを終了として集計する', () => {
  const plan = githubPlan(snapshot(inputs()));
  const progress = githubProgress(plan.goals[0].tasks);
  assert.deepEqual(progress, { total: 2, closed: 1, estimatedTasks: 2, totalPoints: 3, closedPoints: 1, remainingPoints: 2, missingEstimates: 0, ambiguousEstimates: 0, percent: 33 });
  assert.equal(githubProgress([...plan.goals[0].tasks, plan.goals[0].tasks[0]]).total, 2);
  const openDone = structuredClone(plan.goals[0].tasks); openDone[1].item.state = 'open';
  assert.equal(githubProgress(openDone).percent, 0);
  assert.equal(githubProgress([]).percent, null);
});
test('未設定・ゼロ見積・複数Projectの見積を補わず、期間内は出典Projectだけを使う', () => {
  const tasks = githubPlan(snapshot(inputs())).tasks;
  assert.equal(githubProgress(tasks).percent, null);
  assert.equal(githubProgress(tasks).missingEstimates, 1);
  assert.equal(githubProgress(tasks).ambiguousEstimates, 1);
  assert.equal(githubProgress([tasks.find(t => t.number === 5)], 'P1').totalPoints, 3);
  assert.equal(githubProgress([tasks.find(t => t.number === 5)], 'P2').totalPoints, 8);
  const value = structuredClone(tasks.find(t => t.number === 3)); value.projects[0].estimatePoints = 0;
  assert.equal(githubProgress([value]).percent, null);
  assert.equal(githubProgress([value]).missingEstimates, 1);
});
test('集計対象の未終了を丸めて100%にせず、対象作業がClosedの場合だけ100%にする', () => {
  const tasks = structuredClone(githubPlan(snapshot(inputs())).goals[0].tasks);
  tasks[0].projects[0].estimatePoints = 0.001;
  tasks[1].projects[0].estimatePoints = 999;
  assert.equal(githubProgress(tasks).percent, 99);
  tasks[0].item.state = 'closed'; assert.equal(githubProgress(tasks).percent, 100);
});
test('モジュール別の目標とMilestoneは同じ範囲だけを表示し、ラベルをHTMLにしない', () => {
  const data = labelledInputs();
  data.issuePages[0][0].labels = [{ name: 'module:<img src=x onerror=alert(1)>' }];
  data.issuePages[0][3].labels = [{ name: 'module:バグ管理' }];
  const value = snapshot(data), html = renderGithubPeriods(value);
  assert.ok(html.includes('&lt;img') && !html.includes('<img src=x'));
  const plan = githubPlan(value), bugModule = githubModules(plan).find(m => m.name === 'バグ管理');
  assert.deepEqual(bugModule.releases[0].tasks.map(t => t.number), [4]);
  assert.ok(html.includes('aria-valuenow="100"'));
  assert.ok(githubItemPlanning(value, 3).includes('親Issue #1から継承'));
});

test('見積未設定を分母と分子から除外し、Issueの件数と一覧には残す', () => {
  const plan = githubPlan(snapshot(inputs())), missing = structuredClone(plan.tasks.find(t => t.number === 6));
  for (const state of ['open', 'closed']) {
    missing.item.state = state;
    const tasks = [...plan.goals[0].tasks, missing, missing];
    const progress = githubProgress(tasks);
    assert.equal(progress.total, 3);
    assert.equal(progress.closed, state === 'closed' ? 2 : 1);
    assert.equal(progress.estimatedTasks, 2);
    assert.equal(progress.missingEstimates, 1);
    assert.equal(progress.totalPoints, 3);
    assert.equal(progress.closedPoints, 1);
    assert.equal(progress.remainingPoints, 2);
    assert.equal(progress.percent, 33);
  }
});
test('見積のある作業が全てClosedなら未見積のOpenがあっても集計対象の終了率は100%', () => {
  const plan = githubPlan(snapshot(inputs()));
  const closed = plan.tasks.find(t => t.number === 4), missing = plan.tasks.find(t => t.number === 6);
  const progress = githubProgress([closed, missing]);
  assert.equal(progress.percent, 100);
  assert.equal(progress.remainingPoints, 0);
  const html = githubProgressMarkup([closed, missing], '確認用');
  assert.ok(html.includes('aria-valuenow="100"'));
  assert.ok(html.includes('見積未設定 1件を除外'));
  assert.ok(html.includes('終了 1pt / 1pt'));
  assert.ok(html.includes('（見積設定済みの作業）'));
});
test('未設定とゼロ見積しかない範囲は集計対象なしと示し、割合や残りを作らない', () => {
  const plan = githubPlan(snapshot(inputs()));
  const zero = structuredClone(plan.tasks.find(t => t.number === 3)); zero.projects[0].estimatePoints = 0;
  const missing = plan.tasks.find(t => t.number === 6);
  const progress = githubProgress([zero, missing]);
  assert.equal(progress.estimatedTasks, 0);
  assert.equal(progress.missingEstimates, 2);
  assert.equal(progress.totalPoints, null);
  assert.equal(progress.percent, null);
  const html = githubProgressMarkup([zero, missing], '確認用');
  assert.ok(html.includes('見積のある作業なし'));
  assert.ok(html.includes('見積未設定 2件を除外'));
  assert.ok(!html.includes('progressbar') && !html.includes('github-progress-remaining'));
});
