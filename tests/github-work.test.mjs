import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, validateSnapshot } from '../dist/github-snapshot.mjs';
import { githubPlan } from '../dist/github-planning.mjs';
import { githubMyWork } from '../dist/github-work.mjs';
import { renderGithubWork, githubUrgentSummary, githubItemPlanning } from '../dist/github-planning-view.mjs';
import { buildPlanning, planningQuery } from '../scripts/github-planning-fetch.mjs';
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

// 緊急：Projectの「優先度」が「緊急」の未完了の作業を、自分の作業の先頭に集める。
const setPriority = (data, number, name, itemIndex = 0) => {
  const item = data.hierarchyPages[0].data.repository.issues.nodes[number - 1].projectItems.nodes[itemIndex];
  item.fieldValues = connection([...item.fieldValues.nodes, single('優先度', name)]);
};
const urgentData = () => {
  const data = inputs();
  setPriority(data, 1, '緊急');    // 作業中
  setPriority(data, 2, '緊急');    // 要対応（仕様待ち）
  setPriority(data, 3, '通常');    // 前提待ち。通常なので先頭に出さない
  setPriority(data, 12, '緊急');   // Done。完了した作業は先頭に出さない
  data.hierarchyPages[0].data.repository.issues.nodes[5].projectItems = connection([project(null, 'Todo', 'it1'), project('Claude', 'Todo', 'it1', 'P2')]);
  setPriority(data, 6, '緊急', 1); // 複数Projectのどれかが緊急なら緊急（着手可能）
  return data;
};
const groupsOf = work => Object.fromEntries(work.sections.map(s => [s.id, s.tasks.map(({ task, group }) => [task.number, group])]));

test('「優先度」を取得してsnapshotに保存し、未設定は通常として扱う', () => {
  const value = snapshot(urgentData());
  validateSnapshot(value, { now: Date.parse(at) });
  const priorities = number => value.planning.issues.find(i => i.number === number).projects.map(p => p.priority);
  assert.deepEqual([priorities(1), priorities(3), priorities(6), priorities(7), priorities(10)], [['緊急'], ['通常'], [null, '緊急'], [null], []]);
});

test('緊急の未完了の作業を、ほかのまとまりへ重ねず先頭に出す。完了した作業と通常の作業は出さない', () => {
  const work = githubMyWork(snapshot(urgentData()), { all: true }, today, { urgentFirst: true });
  assert.equal(work.sections[0].id, 'urgent');
  assert.deepEqual(groupsOf(work), {
    urgent: [[1, 'active'], [2, 'action'], [6, 'ready']],
    action: [[9, 'action'], [8, 'action'], [11, 'action'], [10, 'action']],
    review: [[5, 'review']],
    'ready-later': [[7, 'ready']],
    waiting: [[3, 'waiting'], [4, 'waiting']],
    done: [[12, 'done']],
  });
});

test('緊急の指定がなければ「緊急」のまとまりを作らず、指定しない呼び出しは従来の分類のまま', () => {
  const plain = snapshot(inputs());
  assert.ok(!githubMyWork(plain, { all: true }, today, { urgentFirst: true }).sections.some(s => s.id === 'urgent'));
  const value = snapshot(urgentData());
  assert.deepEqual(Object.keys(groups(githubMyWork(value, { all: true }, today))), ['active', 'action', 'review', 'ready-now', 'ready-later', 'waiting', 'done']);
  assert.deepEqual(groups(githubMyWork(value, { all: true }, today)).action.map(([n]) => n), [9, 2, 8, 11, 10]);
});

test('緊急の作業も担当者の絞り込みに従う', () => {
  const value = snapshot(urgentData());
  assert.deepEqual(groupsOf(githubMyWork(value, { owner: 'Claude' }, today, { urgentFirst: true })).urgent, [[1, 'active'], [6, 'ready']]);
  assert.deepEqual(groupsOf(githubMyWork(value, { owner: 'Wakua' }, today, { urgentFirst: true })), { urgent: [[2, 'action']] });
});

test('「優先度」を持たない既存のsnapshotは通常として読み込む', () => {
  const value = snapshot(urgentData());
  for (const issue of value.planning.issues) for (const p of issue.projects) delete p.priority;
  validateSnapshot(value, { now: Date.parse(at) });
  assert.ok(!githubMyWork(value, { all: true }, today, { urgentFirst: true }).sections.some(s => s.id === 'urgent'));
  assert.equal(githubUrgentSummary(value, today), null);
  assert.ok(githubItemPlanning(value, 1).includes('<dt>優先度</dt><dd>未設定</dd>'));
  assert.ok(githubItemPlanning(snapshot(urgentData()), 1).includes('<dt>優先度</dt><dd>緊急</dd>'));
});

test('「優先度」の一部だけの保存や文字列でない値を拒否する', () => {
  for (const mutate of [
    v => { delete v.planning.issues[0].projects[0].priority; },
    v => { v.planning.issues[0].projects[0].priority = 1; },
    v => { v.planning.issues[0].projects[0].priority = ''; },
  ]) {
    const value = structuredClone(snapshot(urgentData()));
    mutate(value);
    assert.throws(() => validateSnapshot(value, { now: Date.parse(at) }), /不完全|不整合/);
  }
});

test('自分の作業の表示は「緊急」を作業中より上に、1行1作業で出す', () => {
  const html = renderGithubWork(snapshot(urgentData()), { all: true }, today);
  assert.ok(html.indexOf('data-my-work-section="urgent"') < html.indexOf('data-my-work-section="action"'));
  const section = html.slice(html.indexOf('data-my-work-section="urgent"'), html.indexOf('</section>', html.indexOf('data-my-work-section="urgent"')));
  assert.ok(section.includes('緊急 <span class="my-work-count">3件</span>'));
  assert.deepEqual([...section.matchAll(/data-github-task="(\d+)"/g)].map(m => Number(m[1])), [1, 2, 6]);
  assert.deepEqual([...section.matchAll(/<span class="urgent-label">([^<]*)<\/span>/g)].map(m => m[1]), ['作業中', '仕様待ち', '着手可能']);
  assert.ok(!section.includes('my-work-reasons'));
  for (const number of [1, 2, 6]) assert.equal(html.split(`data-github-task="${number}"`).length - 1, 1);
});

test('全体一覧のカードには、緊急の件数と先頭の1件を出す', () => {
  assert.deepEqual(githubUrgentSummary(snapshot(urgentData()), today), { count: 3, first: '#1 QA Issue 1' });
  assert.equal(githubUrgentSummary(snapshot(inputs()), today), null);
  assert.equal(githubUrgentSummary(null, today), null);
});

test('「優先度」の取得でGraphQLのコストを増やさない：入れ子の接続の件数は変えない', () => {
  // GitHubはコストを入れ子の接続の件数の積から数える（#41）。件数を変えたときは、取得コストの実測と、仕様書の上限の記述を合わせて更新する。
  const sizes = [...planningQuery(repo).matchAll(/first:(\d+)/g)].map(m => Number(m[1]));
  assert.deepEqual(sizes, [100, 20, 50, 20, 10, 100]);
});
