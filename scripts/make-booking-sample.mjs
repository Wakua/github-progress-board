// 画面の撮影用に、架空の予約管理アプリ（GitHubで計画しているプロジェクト）のworkspaceを作る。実在のrepositoryのデータは使わない。
// 使い方：node scripts/make-booking-sample.mjs <出力するJSONのパス>
import { writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url).href;
const { buildSnapshot, attachSnapshot } = await import(root + 'dist/github-snapshot.mjs');
const { buildPlanning } = await import(root + 'scripts/github-planning-fetch.mjs');
const { emptyWorkspace, registerProject } = await import(root + 'dist/workspace.mjs');

const repo = 'https://github.com/example/booking-app';
const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const connection = nodes => ({ totalCount: nodes.length, pageInfo: { hasNextPage: false }, nodes });
const iterations = {
  it0: { iterationId: 'it0', title: 'It0', startDate: '2026-09-28', duration: 7 },
  it1: { iterationId: 'it1', title: 'It1', startDate: '2026-10-05', duration: 7 },
  it2: { iterationId: 'it2', title: 'It2', startDate: '2026-10-12', duration: 7 },
  it3: { iterationId: 'it3', title: 'It3', startDate: '2026-10-19', duration: 7 },
};
// [番号, タイトル, 状態, 親, Status, 担当, Estimate, Iteration, Milestone, 前提の番号, PR, ラベル]
const rows = [
  [1, '予約フォームを使えるようにする', 'open', null, null, null, null, null, 1, [], null, []],
  [2, '入力項目を決める', 'closed', 1, 'Done', 'Wakua', 1, 'it0', 1, [], null, []],
  [3, '入力欄を作る', 'open', 1, 'In Progress', 'Claude', 2, 'it1', 1, [], 'draft', []],
  [4, '確認画面を作る', 'open', 1, 'Todo', 'Claude', 1, 'it1', 1, [3], null, []],
  [5, '通知文を整える', 'open', 1, 'In Progress', null, 1, 'it1', 1, [], null, []],
  [6, '予約一覧を作る', 'open', 1, 'Todo', 'Codex', 2, 'it0', 1, [], null, []],
  [7, '管理画面に組み込む', 'open', 1, 'Todo', 'Codex', null, null, 1, [], null, []],
  [8, '手順書を書く', 'open', 1, 'Todo', 'Wakua', 1, 'it3', 1, [], null, []],
  [9, '保存形式を決める', 'open', 1, 'Todo', 'Wakua', 0.5, 'it1', 1, [], null, ['仕様']],
  [10, '取消の受付を作る', 'open', 1, 'Todo', 'Codex', 1, 'it2', 1, [9], null, []],
  [11, '予約の自動テストを足す', 'open', 1, 'Todo', 'Claude', 1, 'it2', 1, [], 'ready', []],
  [12, '利用者の声を集める', 'open', null, null, null, null, null, null, [], null, []],
];
const url = n => `${repo}/issues/${n}`;
const issuePages = [rows.map(([number, title, state, , , , , , milestone, , , labels]) => ({
  number, html_url: url(number), title, state, updated_at: at, closed_at: state === 'closed' ? at : null,
  labels: labels.map(name => ({ name })), ...(milestone ? { milestone: { number: milestone } } : {}),
}))];
const nodes = rows.map(([number, , , parent, status, owner, estimate, iteration, , blockers, pr]) => ({
  number, url: url(number), updatedAt: at,
  parent: parent ? { number: parent, url: url(parent) } : null,
  subIssuesSummary: { total: rows.filter(r => r[3] === number).length },
  projectItems: connection(status === null ? [] : [{ project: { id: 'P1', title: '予約管理アプリ 開発', url: 'https://github.com/users/example/projects/1' }, fieldValues: connection([
    { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: status, field: { name: 'Status' } },
    ...(owner ? [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', name: owner, field: { name: '担当' } }] : []),
    ...(estimate === null ? [] : [{ __typename: 'ProjectV2ItemFieldNumberValue', number: estimate, field: { name: 'Estimate' } }]),
    ...(iteration ? [{ __typename: 'ProjectV2ItemFieldIterationValue', ...iterations[iteration], field: { name: 'Iteration' } }] : []),
  ]) }]),
  blockedBy: connection(blockers.map(b => { const r = rows.find(x => x[0] === b); return { number: b, url: url(b), title: r[1], state: r[2].toUpperCase(), labels: connection(r[11].map(name => ({ name }))) }; })),
  closedByPullRequestsReferences: connection(pr ? [{ number: 20 + number, url: `${repo}/pull/${20 + number}`, isDraft: pr === 'draft', state: 'OPEN' }] : []),
}));
const prRecords = rows.filter(r => r[10]).map(r => ({ number: 20 + r[0], html_url: `${repo}/pull/${20 + r[0]}`, title: `${r[1]}（PR）`, state: 'open', updated_at: at, closed_at: null, merged_at: null, draft: r[10] === 'draft', base: { repo: { html_url: repo } } }));
const input = {
  repositoryUrl: repo, fetchedAt: at, issuePages, pullPages: [prRecords],
  hierarchyPages: [{ data: { repository: { issues: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } }],
  milestonePages: [[{ number: 1, html_url: `${repo}/milestone/1`, title: 'R1 予約フォームの公開', description: '架空のリリース', state: 'open', due_on: '2026-10-18T00:00:00Z', updated_at: at, closed_at: null }]],
};
// Issue一覧に含まれないPRは、PR一覧で渡す。issuePagesにはPR自体のIssue表現も必要。
for (const pr of prRecords) issuePages[0].push({ number: pr.number, html_url: pr.html_url, title: pr.title, state: 'open', updated_at: at, closed_at: null, pull_request: { url: 'sample' } });

const workspace = emptyWorkspace();
const project = registerProject(workspace, { name: '予約管理アプリ（サンプル）', repositoryUrl: repo }, () => 'booking-sample');
attachSnapshot(project, buildSnapshot({ ...input, planning: buildPlanning({ ...input, issuePages }) }), Date.parse(at));
workspace.selectedProjectId = project.id;
writeFileSync(process.argv[2], JSON.stringify(workspace));
console.log('ok', JSON.stringify(workspace).length, 'bytes');
