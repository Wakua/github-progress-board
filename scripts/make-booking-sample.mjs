// 画面の撮影と試作用に、架空の予約管理アプリ（GitHubで計画しているプロジェクト）のworkspaceを作る。実在のrepositoryのデータは使わない。
// 使い方：node scripts/make-booking-sample.mjs <出力するJSONのパス>
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildSnapshot, attachSnapshot } from '../dist/github-snapshot.mjs';
import { buildPlanning } from './github-planning-fetch.mjs';
import { emptyWorkspace, registerProject } from '../dist/workspace.mjs';

const repo = 'https://github.com/example/booking-app';
const connection = nodes => ({ totalCount: nodes.length, pageInfo: { hasNextPage: false }, nodes });
const iterations = {
  it0: { iterationId: 'it0', title: 'It0', startDate: '2026-09-28', duration: 7 },
  it1: { iterationId: 'it1', title: 'It1', startDate: '2026-10-05', duration: 7 },
  it2: { iterationId: 'it2', title: 'It2', startDate: '2026-10-12', duration: 7 },
  it3: { iterationId: 'it3', title: 'It3', startDate: '2026-10-19', duration: 7 },
  it4: { iterationId: 'it4', title: 'It4', startDate: '2026-10-26', duration: 7 },
  it5: { iterationId: 'it5', title: 'It5', startDate: '2026-11-02', duration: 7 },
};
// Milestone（リリース）。R1の期日は It2 の最終日、R2の期日は It4 の最終日である。
const milestones = [
  { number: 1, title: 'R1 予約フォームの公開', due_on: '2026-10-18T00:00:00Z' },
  { number: 2, title: 'R2 通知と管理画面', due_on: '2026-11-01T00:00:00Z' },
];
// [番号, タイトル, 状態, 親, Status, 担当, Estimate, Iteration, Milestone, 前提の番号, PR, ラベル]
// R1の #8（It3）とR2の #17（It5）は、Milestoneの期日より後のイテレーションに割り当てている。
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
  [13, '通知と管理画面を使えるようにする', 'open', null, null, null, null, null, 2, [], null, []],
  [14, '予約の変更を通知する', 'open', 13, 'Todo', 'Claude', 2, 'it3', 2, [], null, []],
  [15, '管理画面で予約を絞り込む', 'open', 13, 'Todo', 'Codex', 2, 'it4', 2, [14], null, []],
  [16, '管理者向けの案内を書く', 'open', 13, 'Todo', 'Wakua', 1, 'it4', 2, [], null, []],
  [17, '通知の文面を見直す', 'open', 13, 'Todo', 'Claude', 1, 'it5', 2, [14], null, []],
];

export function bookingSampleWorkspace(fetchedAt = new Date()) {
  const at = fetchedAt.toISOString().replace(/\.\d+Z$/, 'Z');
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
  // PR自体のIssue表現も、Issue一覧に含まれる。
  for (const pr of prRecords) issuePages[0].push({ number: pr.number, html_url: pr.html_url, title: pr.title, state: 'open', updated_at: at, closed_at: null, pull_request: { url: 'sample' } });
  const input = {
    repositoryUrl: repo, fetchedAt: at, issuePages, pullPages: [prRecords],
    hierarchyPages: [{ data: { repository: { issues: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } }],
    milestonePages: [milestones.map(m => ({ ...m, html_url: `${repo}/milestone/${m.number}`, description: '架空のリリース', state: 'open', updated_at: at, closed_at: null }))],
  };
  const workspace = emptyWorkspace();
  const project = registerProject(workspace, { name: '予約管理アプリ（サンプル）', repositoryUrl: repo }, () => 'booking-sample');
  attachSnapshot(project, buildSnapshot({ ...input, planning: buildPlanning(input) }), Date.parse(at));
  workspace.selectedProjectId = project.id;
  return workspace;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { process.stderr.write('使い方：node scripts/make-booking-sample.mjs <出力するJSONのパス>\n'); process.exitCode = 1; }
  else {
    const text = JSON.stringify(bookingSampleWorkspace());
    writeFileSync(process.argv[2], text);
    process.stdout.write(`ok ${text.length} bytes\n`);
  }
}
