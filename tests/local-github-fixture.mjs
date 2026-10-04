// Fabricated, clearly labelled QA data. Never imported by the application.
import { emptyWorkspace, registerProject, addGoal, addTask } from '../dist/workspace.mjs';
import { setLocalRepositories } from '../dist/local-github.mjs';
// 自動取得を許可したQA用のrepository。ブラウザ側の許可一覧にも同じものを設定する。
export const QA_REPOSITORIES = Object.freeze(['https://github.com/qa-local/alpha', 'https://github.com/qa-local/beta', 'https://github.com/qa-local/board']);
setLocalRepositories(QA_REPOSITORIES);
export function restFixture(repositoryUrl, version = 1) {
  const issue = { number: 7, html_url: `${repositoryUrl}/issues/7`, title: `QA GitHub Issue v${version}`, state: 'closed', updated_at: '2026-10-02T12:00:00Z', closed_at: '2026-10-02T11:00:00Z' };
  const pr = { number: 8, html_url: `${repositoryUrl}/pull/8`, title: 'QA Draft PR', state: 'open', updated_at: '2026-10-02T12:00:00Z', closed_at: null, merged_at: null, draft: true, base: { repo: { html_url: repositoryUrl } } };
  return { issuePages: [[issue, { number: 8, pull_request: { url: 'QA' } }]], pullPages: [[pr]] };
}
export function hierarchyFixture(records) {
  const nodes = records.map(i => ({ number: i.number, url: i.html_url, updatedAt: i.updated_at, parent: null, subIssuesSummary: { total: 0 }, projectItems: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
    blockedBy: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }, closedByPullRequestsReferences: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } }));
  return { data: { repository: { issues: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } };
}
export function mockGh({ version = () => 1, beforeRead = async () => {} } = {}) {
  return async (command, args, options) => {
    await beforeRead(command, args, options);
    if (args[3] === 'graphql') {
      const query = args.at(-1), match = query.match(/repository\(owner:("[^"]+"),name:("[^"]+")\)/);
      const repositoryUrl = 'https://github.com/' + JSON.parse(match[1]) + '/' + JSON.parse(match[2]);
      return { stdout: JSON.stringify(hierarchyFixture(restFixture(repositoryUrl, version()).issuePages.flat().filter(i => !i.pull_request))) };
    }
    const url = new URL(`https://api.github.com/${args.at(-1)}`), parts = url.pathname.split('/');
    const repositoryUrl = `https://github.com/${parts[2]}/${parts[3]}`;
    const pages = restFixture(repositoryUrl, version());
    return { stdout: JSON.stringify((parts[4] === 'issues' ? pages.issuePages : parts[4] === 'pulls' ? pages.pullPages : [[]])[Number(url.searchParams.get('page')) - 1] || []) };
  };
}
export function qaWorkspace() {
  const workspace = emptyWorkspace();
  for (const [id, url] of [['progress', QA_REPOSITORIES[2]], ['alpha', QA_REPOSITORIES[0]], ['beta', QA_REPOSITORIES[1]], ['other', 'https://github.com/qa-fixture/other']]) {
    const project = registerProject(workspace, { name: `${id}（QA用）`, repositoryUrl: url }, () => id);
    addGoal(project.data, id, { title: 'QA用の目標', issueNumber: 5 }, () => 'goal');
    const task = addTask(project.data, id, { title: 'QA用の手動作業', goalId: 'goal', issueNumber: 7, status: 'todo', criteria: ['QA用の確認条件'] }, () => 'task');
    task.owner = 'QA担当'; task.estimatePoints = 1; task.evidence = 'QA用の手動証拠';
    const prerequisite = addTask(project.data, id, { title: 'QA用の前提', goalId: 'goal', status: 'todo' }, () => 'prerequisite');
    task.deps = [prerequisite.id];
  }
  workspace.selectedProjectId = 'progress';
  return workspace;
}
