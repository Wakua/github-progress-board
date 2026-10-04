import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, validateSnapshot } from '../dist/github-snapshot.mjs';
import { githubPlan } from '../dist/github-planning.mjs';
import { githubMyWork } from '../dist/github-work.mjs';
import { renderGithubWork } from '../dist/github-planning-view.mjs';
import { buildPlanning } from '../scripts/github-planning-fetch.mjs';
import { hierarchyFixture } from './local-github-fixture.mjs';

// Fabricated, clearly labelled QA data.
const repo = 'https://github.com/Wakua/github-progress-board';
const at = '2026-10-03T12:00:00Z';
const today = '2026-10-06';
const connection = nodes => ({ totalCount: nodes.length, pageInfo: { hasNextPage: false }, nodes });
const single = (field, name) => ({ __typename: 'ProjectV2ItemFieldSingleSelectValue', name, field: { name: field } });
const iterations = { past: '2026-09-21', it1: '2026-10-05', it2: '2026-10-12', sprint: '2026-10-01' };
const project = (owner, status, iteration = 'it1', id = 'P1') => ({
  project: { id, title: id, url: 'https://github.com/users/Wakua/projects/' + (id === 'P1' ? 3 : 4) },
  fieldValues: connection([...(owner ? [single('担当', owner)] : []), single('Status', status),
    { __typename: 'ProjectV2ItemFieldIterationValue', iterationId: iteration, title: iteration, startDate: iterations[iteration], duration: iteration === 'sprint' ? 14 : 7, field: { name: 'Iteration' } }]),
});
const blocker = (number, { state = 'OPEN', spec = false, url = `${repo}/issues/${number}` } = {}) =>
  ({ number, url, title: `QA 前提 ${number}`, state, labels: connection(spec ? [{ name: '仕様' }] : []) });
const pr = (number, isDraft) => ({ number, url: `${repo}/pull/${number}`, isDraft, state: 'OPEN' });

function inputs() {
  const records = Array.from({ length: 12 }, (_, i) => i + 1).map(number => ({ number, html_url: `${repo}/issues/${number}`, title: `QA Issue ${number}`,
    state: number === 12 ? 'closed' : 'open', updated_at: '2026-10-02T12:00:00Z', closed_at: number === 12 ? '2026-10-02T11:00:00Z' : null,
    milestone: null, labels: number === 2 ? [{ name: '仕様' }] : [] }));
  const response = hierarchyFixture(records), nodes = response.data.repository.issues.nodes;
  const set = (number, items, blockedBy = [], prs = []) => {
    nodes[number - 1].projectItems = connection(items);
    nodes[number - 1].blockedBy = connection(blockedBy);
    nodes[number - 1].closedByPullRequestsReferences = connection(prs);
  };
  set(1, [project('Claude', 'In Progress')], [], [pr(101, true)]);
  set(2, [project('Wakua', 'Todo')]);
  set(3, [project('Claude', 'Todo')], [blocker(2, { spec: true })]);
  set(4, [project('Codex', 'Todo')], [blocker(5, { url: 'https://github.com/qa-fixture/spec/issues/5' })]);
  set(5, [project('Claude', 'In Progress')], [], [pr(102, false)]);
  set(6, [project(null, 'Todo')], [blocker(12, { state: 'CLOSED' })]);
  set(7, [project('Codex', 'Todo', 'it2')]);
  set(8, [project(null, 'In Progress')]);
  set(9, [project('Codex', 'Todo', 'past')]);
  set(10, []);
  set(11, [project('Codex', 'Todo')], [blocker(9)]);
  set(12, [project('Claude', 'Done')]);
  return { repositoryUrl: repo, fetchedAt: at, issuePages: [records], pullPages: [[]],
    milestonePages: [[]], hierarchyPages: [response] };
}
const snapshot = data => buildSnapshot({ ...data, planning: buildPlanning(data) });
const groups = work => Object.fromEntries(work.sections.map(s => [s.id, s.tasks.map(({ task, reasons }) => [task.number, reasons])]));

test('GitHubの作業を手動の作業と同じ順で、要対応・確認待ち・作業中・前提待ち・着手可能に分ける', () => {
  const value = snapshot(inputs());
  validateSnapshot(value, { now: Date.parse(at) });
  const work = githubMyWork(value, { all: true }, today);
  assert.deepEqual(work.currents.map(c => c.iteration.title), ['it1']);
  assert.equal(work.dependenciesFetched, true);
  assert.deepEqual(groups(work), {
    active: [[1, ['Draft PR #101']]],
    action: [
      [9, ['期限超過：past（9/27終了）']],
      [2, ['仕様待ち：QA Issue 2']],
      [8, ['作業中なのに担当者がいない']],
      [11, ['前提の期限超過：#9（past）']],
      [10, ['状態が未確認：Projectに未登録']],
    ],
    review: [[5, ['承認待ちのPR #102']]],
    'ready-now': [[6, []]],
    'ready-later': [[7, []]],
    waiting: [[3, ['仕様待ち：#2 QA 前提 2']], [4, ['前提：qa-fixture/spec#5 QA 前提 5']]],
    done: [[12, []]],
  });
});

test('担当者で絞り込むと、その人の作業だけを分類する', () => {
  const value = snapshot(inputs());
  assert.deepEqual(groups(githubMyWork(value, { owner: 'Wakua' }, today)), { action: [[2, ['仕様待ち：QA Issue 2']]] });
  assert.deepEqual(Object.keys(groups(githubMyWork(value, { owner: null }, today))), ['action', 'ready-now']);
});

test('作業中なのに未完了の前提がある作業は要対応に入れる', () => {
  const data = inputs();
  data.hierarchyPages[0].data.repository.issues.nodes[0].blockedBy = connection([blocker(2, { spec: true })]);
  const work = githubMyWork(snapshot(data), { owner: 'Claude' }, today);
  assert.deepEqual(groups(work).action, [[1, ['作業中なのに前提が未完了：#2']]]);
});

test('仕様待ちの前提が閉じると、止まっていた作業は着手可能に戻る', () => {
  const data = inputs();
  data.hierarchyPages[0].data.repository.issues.nodes[2].blockedBy = connection([blocker(2, { spec: true, state: 'CLOSED' })]);
  assert.deepEqual(groups(githubMyWork(snapshot(data), { owner: 'Claude' }, today))['ready-now'], [[3, []]]);
});

test('前提・PRを取得していない古いsnapshotでも表示し、未取得と示す', () => {
  const value = snapshot(inputs());
  for (const issue of value.planning.issues) { delete issue.blockedBy; delete issue.pullRequests; delete issue.spec; }
  validateSnapshot(value, { now: Date.parse(at) });
  const work = githubMyWork(value, { all: true }, today);
  assert.equal(work.dependenciesFetched, false);
  assert.ok(renderGithubWork(value, { all: true }, today).includes('前提とPRは未取得'));
});

test('前提・PR・仕様ラベルの一部だけの保存や不正な値を拒否する', () => {
  for (const mutate of [
    v => { delete v.planning.issues[0].spec; },
    v => { v.planning.issues[2].blockedBy[0].url = 'https://example.com/issues/2'; },
    v => { v.planning.issues[2].blockedBy[0].state = 'merged'; },
    v => { v.planning.issues[0].pullRequests[0].draft = 'yes'; },
    v => { v.planning.issues[0].pullRequests[0].url = `${repo}/issues/101`; },
    v => { v.planning.issues[2].blockedBy.push({ ...v.planning.issues[2].blockedBy[0] }); },
  ]) {
    const value = structuredClone(snapshot(inputs()));
    mutate(value);
    assert.throws(() => validateSnapshot(value, { now: Date.parse(at) }), /不完全|不整合/);
  }
});

test('GitHubの作業の表示は分類の見出しで並び、文字列をHTMLとして実行しない', () => {
  const data = inputs();
  data.issuePages[0][1].title = '<img src=x onerror=alert(1)>';
  const html = renderGithubWork(snapshot(data), { all: true }, today);
  assert.ok(html.indexOf('作業中') < html.indexOf('要対応') && html.indexOf('要対応') < html.indexOf('確認待ち'));
  assert.ok(html.includes('今の期間：it1（10/5–10/11）'));
  assert.ok(html.includes('&lt;img') && !html.includes('<img src=x'));
  assert.ok(html.includes('<details class="my-work-section" data-github-disclosure="work:waiting"'));
  assert.equal(githubPlan(snapshot(data)).tasks.length, 12);
});

test('複数Projectのどれかの期間が終わっていれば、取得順によらず期限超過として要対応に入れる', () => {
  const data = inputs();
  data.hierarchyPages[0].data.repository.issues.nodes[5].projectItems = connection([project(null, 'Todo', 'it1'), project('Claude', 'Todo', 'past', 'P2')]);
  const work = githubMyWork(snapshot(data), { owner: 'Claude' }, today);
  assert.deepEqual(groups(work).action, [[6, ['期限超過：past（9/27終了）']]]);
});

test('子Issueを持つ親Issueを前提にしても、その期限超過を判定する', () => {
  const data = inputs(), nodes = data.hierarchyPages[0].data.repository.issues.nodes;
  nodes[9].subIssuesSummary.total = 1; nodes[9].projectItems = connection([project('Codex', 'Todo', 'past')]);
  nodes[6].parent = { number: 10, url: `${repo}/issues/10` };
  nodes[5].blockedBy = connection([blocker(10)]);
  const work = githubMyWork(snapshot(data), { owner: null }, today);
  assert.deepEqual(groups(work).action, [[6, ['前提の期限超過：#10（past）']], [8, ['作業中なのに担当者がいない']]]);
});

test('今の期間はProjectごとに決め、同時に進行中の別Projectの作業も今の期間に入れる', () => {
  const data = inputs();
  data.hierarchyPages[0].data.repository.issues.nodes[6].projectItems = connection([project('Codex', 'Todo', 'sprint', 'P2')]);
  const value = snapshot(data), work = githubMyWork(value, { owner: 'Codex' }, today);
  assert.deepEqual(work.currents.map(c => [c.project.id, c.iteration.title]), [['P1', 'it1'], ['P2', 'sprint']]);
  assert.deepEqual(groups(work)['ready-now'], [[7, []]]);
  assert.ok(renderGithubWork(value, { owner: 'Codex' }, today).includes('今の期間：P1 it1（10/5–10/11）、P2 sprint（10/1–10/14）'));
});
