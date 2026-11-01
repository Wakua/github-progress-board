import { buildSnapshot } from '../dist/github-snapshot.mjs';
import { buildPlanning } from '../scripts/github-planning-fetch.mjs';
import { hierarchyFixture } from './local-github-fixture.mjs';
import { collectSchedule } from '../scripts/github-schedule-fetch.mjs';

export const repo = 'https://github.com/qa-local/board';
export const external = 'https://github.com/qa-external/other';
export const at = '2026-10-03T12:00:00Z';
export const url = (n, root = repo) => `${root}/issues/${n}`;
export const connection = nodes => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false } });
export function projectNode(id = 'P1', progress = 0, status = 'Todo') {
  const single = (name, value) => ({ __typename: 'ProjectV2ItemFieldSingleSelectValue', name: value, field: { id: `${id}-${name}`, name } });
  const number = (name, value) => ({ __typename: 'ProjectV2ItemFieldNumberValue', number: value, field: { id: `${id}-${name}`, name } });
  return { project: { id, title: id, url: `https://github.com/users/qa/projects/${id === 'P1' ? 1 : 2}` }, fieldValues: connection([
    single('Status', status), single('担当', 'Codex'), number('Estimate', 1),
    ...(progress === undefined ? [] : [number('作業進捗率', progress)]),
    { __typename: 'ProjectV2ItemFieldIterationValue', startDate: '2026-10-05', duration: 7, iterationId: 'It1', title: 'It1', field: { id: `${id}-Iteration`, name: 'Iteration' } },
  ]) };
}
export function externalNode(n, { parent = null, children = [], blockers = [], state = 'OPEN' } = {}) {
  const ref = number => ({ number, url: url(number, external) });
  return { number: n, url: url(n, external), title: `QA external ${n}`, state, updatedAt: '2026-10-02T12:00:00Z',
    parent: parent ? ref(parent) : null, subIssues: connection(children.map(ref)), blockedBy: connection(blockers.map(ref)), projectItems: connection([projectNode('P2')]) };
}
export function scheduleFixture() {
  const issuePages = [[1, 9].map(number => ({ number, html_url: url(number), title: `QA ${number}`, state: 'open',
    updated_at: '2026-10-02T12:00:00Z', closed_at: null, milestone: number === 1 ? { number: 1 } : null }))];
  const hierarchyPages = [hierarchyFixture(issuePages[0])], [child, parent] = hierarchyPages[0].data.repository.issues.nodes;
  child.parent = { number: 9, url: url(9) }; parent.subIssuesSummary.total = 1;
  for (const n of [child, parent]) n.projectItems = connection([projectNode()]);
  const blocker = n => ({ number: n, url: url(n, external), title: `QA external ${n}`, state: 'OPEN', labels: connection([]) });
  child.blockedBy = connection([blocker(1)]); parent.blockedBy = connection([blocker(3)]);
  const milestonePages = [[{ number: 1, html_url: `${repo}/milestone/1`, title: 'QA release', description: null, state: 'open',
    due_on: '2026-10-18T00:00:00Z', updated_at: '2026-10-02T12:00:00Z', closed_at: null }]];
  const input = { repositoryUrl: repo, fetchedAt: at, issuePages, pullPages: [[]], hierarchyPages, milestonePages };
  const externalNodes = new Map([
    [1, externalNode(1, { parent: 4, children: [2], state: 'CLOSED' })],
    [2, externalNode(2, { parent: 1 })], [3, externalNode(3)],
    [4, externalNode(4, { children: [1, 6], blockers: [5] })], [5, externalNode(5)],
    [6, externalNode(6, { parent: 4 })],
  ].map(([n, node]) => [url(n, external), node]));
  const reads = [];
  const readIssue = async key => { reads.push(key); return { data: { repository: { issue: externalNodes.get(key) } } }; };
  return { ...input, externalNodes, reads, readIssue };
}
export async function scheduleSnapshot(data = scheduleFixture(), overrides = {}) {
  const planning = buildPlanning(data);
  planning.schedule = await collectSchedule({ ...data, planning, ...overrides });
  return buildSnapshot({ ...data, planning });
}
