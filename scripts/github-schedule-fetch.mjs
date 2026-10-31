import { SCHEDULE_FIELDS } from '../dist/github-schedule-data.mjs';

export const MAX_SCHEDULE_REQUESTS = 100;
export class ScheduleFetchError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code = 'schedule_invalid') => { throw new ScheduleFetchError(code); };
const read = value => ({ value, problem: null });
const links = (keys, totalCount = keys.length) => ({ keys: [...new Set(keys)].sort(), totalCount, complete: keys.length === totalCount, problem: null });
const key = url => url.toLowerCase();
const completeNodes = c => {
  if (!c || !Array.isArray(c.nodes) || c.nodes.some(n => !n) || !Number.isSafeInteger(c.totalCount) || c.totalCount < c.nodes.length || typeof c.pageInfo?.hasNextPage !== 'boolean') fail();
  if (c.pageInfo.hasNextPage || c.totalCount !== c.nodes.length) fail('schedule_limit');
  return c.nodes;
};
export function scheduleIssueQuery(url) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)$/i.exec(url);
  if (!match) fail();
  return `query { rateLimit { remaining resetAt } repository(owner:${JSON.stringify(match[1])},name:${JSON.stringify(match[2])}) {
    issue(number:${match[3]}) { number url title state updatedAt parent { number url }
      subIssues(first:100) { totalCount pageInfo { hasNextPage } nodes { number url } }
      blockedBy(first:100) { totalCount pageInfo { hasNextPage } nodes { number url } }
      projectItems(first:10) { totalCount pageInfo { hasNextPage } nodes {
        project { id title url }
        fieldValues(first:100) { totalCount pageInfo { hasNextPage } nodes { __typename
          ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { id name } } }
          ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { id name } } }
          ... on ProjectV2ItemFieldIterationValue { startDate duration field { ... on ProjectV2IterationField { id name } } }
        } }
      } }
    }
  } }`;
}
function projects(connection) {
  return completeNodes(connection).map(item => {
    if (!item.project) fail();
    const p = { ...item.project, fieldSources: {} };
    for (const [field, name] of Object.entries(SCHEDULE_FIELDS)) { p[field] = read(null); p.fieldSources[field] = { id: null, name }; }
    const seen = new Set();
    for (const v of completeNodes(item.fieldValues)) {
      const field = Object.keys(SCHEDULE_FIELDS).find(f => SCHEDULE_FIELDS[f] === v.field?.name);
      if (!field) continue;
      if (seen.has(field)) fail();
      seen.add(field); p.fieldSources[field].id = v.field.id ?? null;
      if (field === 'iteration') {
        if (v.__typename !== 'ProjectV2ItemFieldIterationValue') fail();
        const start = Date.parse(v.startDate), end = start + (v.duration - 1) * 86400000;
        // Do not repair malformed dates; leave a domain-invalid value for the calculator.
        const valid = typeof v.startDate === 'string' && /^\d{4}-\d\d-\d\d$/.test(v.startDate) && Number.isFinite(start) &&
          new Date(start).toISOString().slice(0, 10) === v.startDate && Number.isSafeInteger(v.duration) && v.duration > 0 && Number.isFinite(end) && Math.abs(end) <= 8640000000000000;
        p[field] = read({ startDate: typeof v.startDate === 'string' ? v.startDate : '', endDate: valid ? new Date(end).toISOString().slice(0, 10) : '' });
      } else if (field === 'estimatePoints' || field === 'workProgressPercent') {
        if (v.__typename !== 'ProjectV2ItemFieldNumberValue') fail();
        p[field] = read(v.number);
      } else {
        if (v.__typename !== 'ProjectV2ItemFieldSingleSelectValue') fail();
        p[field] = read(v.name);
      }
    }
    return p;
  });
}
function normalize(n, children) {
  if (!n || !['OPEN', 'CLOSED'].includes(n.state)) fail();
  return { key: key(n.url), title: n.title, updatedAt: n.updatedAt, state: read(n.state.toLowerCase()),
    parent: read(n.parent ? key(n.parent.url) : null), children,
    blockedBy: links(completeNodes(n.blockedBy).map(b => key(b.url))),
    projects: projects(n.projectItems), projectsComplete: true, projectsProblem: null };
}

// Local nodes reuse the already fetched REST/GraphQL pages. Only reachable external
// prerequisites, ancestors and missing aggregate children require extra requests.
export async function collectSchedule({ repositoryUrl, issuePages, hierarchyPages, planning, readIssue, maxRequests = MAX_SCHEDULE_REQUESTS }) {
  const rest = new Map(issuePages.flat().filter(i => !i.pull_request).map(i => [i.number, i]));
  const nodes = hierarchyPages.flatMap(p => p.data.repository.issues.nodes);
  const records = new Map();
  for (const n of nodes) {
    const r = rest.get(n.number);
    const children = nodes.filter(c => c.parent && key(c.parent.url) === key(n.url)).map(c => key(c.url));
    records.set(key(n.url), normalize({ ...n, title: r.title, state: r.state.toUpperCase() }, links(children, n.subIssuesSummary.total)));
  }
  const openMilestones = new Set(planning.milestones.filter(m => m.state === 'open').map(m => m.number));
  const pending = planning.issues.filter(i => i.childCount === 0 && openMilestones.has(i.milestoneNumber))
    .map(i => ({ key: key(`${repositoryUrl}/issues/${i.number}`), expand: true }));
  const visited = new Set();
  let requests = 0;
  for (let index = 0; index < pending.length; index++) {
    const next = pending[index], visitKey = `${next.key}:${next.expand}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    let issue = records.get(next.key);
    if (!issue || (next.expand && !issue.children.complete)) {
      if (requests >= maxRequests || (!issue && records.size >= 5000)) fail('schedule_limit');
      requests++;
      const response = await readIssue(next.key);
      if (response?.errors?.length) fail(response.errors.some(e => e.type === 'FORBIDDEN') ? 'schedule_forbidden' : 'schedule_failed');
      const node = response?.data?.repository?.issue;
      if (!node) fail('schedule_failed');
      const fetched = normalize(node, links(completeNodes(node.subIssues).map(c => key(c.url))));
      if (fetched.key !== next.key || (issue && Date.parse(issue.updatedAt) !== Date.parse(fetched.updatedAt))) fail();
      issue = fetched; records.set(next.key, issue);
    }
    if (next.expand) for (const child of issue.children.keys) pending.push({ key: child, expand: true });
    // Even Closed aggregate Issues can have unfinished descendants and prerequisites.
    // Completed leaves do not need their historic prerequisites for future scheduling.
    const completedLeaf = issue.children.complete && issue.children.keys.length === 0 &&
      (issue.state.value === 'closed' || (issue.projects.length > 0 && issue.projects.every(p => p.status.value === 'Done')));
    if (!completedLeaf) {
      for (const blocker of issue.blockedBy.keys) pending.push({ key: blocker, expand: true });
      if (issue.parent.value) pending.push({ key: issue.parent.value, expand: false });
    }
  }
  return { schemaVersion: 1, sourceUrl: 'https://api.github.com/graphql', issues: [...records.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}
