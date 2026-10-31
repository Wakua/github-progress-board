import { validateSnapshot } from './github-snapshot.mjs';
import { githubWorkCategory } from './github-work.mjs';

const key = url => url.toLowerCase();
const read = value => ({ value, problem: null });
const missing = (problem = 'not-fetched') => ({ value: null, problem });
const links = (keys, totalCount = keys.length, problem = null) => ({
  keys: [...new Set(keys)].sort(), totalCount, complete: problem === null && totalCount === new Set(keys).size, problem,
});
const absentLinks = () => links([], null, 'not-fetched');

// Completion uses every Project, before choosing the source of scheduling fields.
// A known Closed state or unanimous, completely fetched Done statuses is decisive.
export function scheduleCompletion(state, projects, projectsComplete) {
  if (state.problem === null && state.value === 'closed') return { value: 'done', reasons: [] };
  const statusKnown = projects.every(p => p.status.problem === null);
  if (projectsComplete && statusKnown && projects.length && projects.every(p => p.status.value === 'Done')) {
    return { value: 'done', reasons: [] };
  }
  if (state.problem !== null || state.value === null) return { value: 'unknown', reasons: ['Issueの開閉が未取得'] };
  // A fetched non-Done status already rules out unanimous Done, even with missing Projects.
  if ((!projectsComplete || !statusKnown) && !projects.some(p => p.status.problem === null && p.status.value !== 'Done')) {
    return { value: 'unknown', reasons: ['完了判定に必要なProject一覧・Statusが未取得'] };
  }
  const task = { item: { state: state.value }, projects: projects.map(p => ({ status: p.status.value, owner: p.owner?.value ?? null, iteration: null })) };
  const result = githubWorkCategory({ issues: [] }, task, '', '2000-01-01');
  // Only completion-related status reasons belong here, not synthetic deadline/owner warnings.
  return { value: result.group === 'done' ? 'done' : 'not-done', reasons: result.reasons.filter(r => r.startsWith('状態が未確認')) };
}

function legacyIssue(snapshot, item, metadata) {
  const all = snapshot.planning?.issues ?? [];
  const children = all.filter(i => i.parent && key(i.parent.url) === key(item.url))
    .map(i => key(`${snapshot.repositoryUrl}/issues/${i.number}`));
  return {
    key: key(item.url), state: read(item.state),
    parent: metadata ? read(metadata.parent ? key(metadata.parent.url) : null) : missing(),
    children: metadata ? links(children, metadata.childCount) : absentLinks(),
    blockedBy: metadata?.blockedBy ? links(metadata.blockedBy.map(i => key(i.url))) : absentLinks(),
    projectsComplete: Boolean(metadata),
    projects: (metadata?.projects ?? []).map(p => ({
      id: p.id, status: read(p.status), owner: read(p.owner), estimatePoints: read(p.estimatePoints),
      workProgressPercent: missing(),
      iteration: read(p.iteration ? {
        startDate: p.iteration.startDate,
        endDate: new Date(Date.parse(p.iteration.startDate + 'T00:00:00Z') + (p.iteration.duration - 1) * 86400000).toISOString().slice(0, 10),
      } : null),
    })),
  };
}

function planningFor(issue, sourceProjectId) {
  const selected = issue.projects.find(p => p.id === sourceProjectId);
  const sourceProblem = !sourceProjectId ? 'unselected' : selected ? null : issue.projectsComplete ? 'not-member' : 'unavailable';
  return {
    sourceProjectId: sourceProjectId || null, sourceProblem,
    ...Object.fromEntries(['status', 'owner', 'estimatePoints', 'workProgressPercent', 'iteration']
      .map(field => [field, selected ? structuredClone(selected[field]) : missing(issue.projectsProblem ?? 'not-fetched')])),
  };
}

// Converts validated snapshots without changing their stored representation.
// External sources are supplied explicitly by Issue URL; no first-Project fallback.
export function githubScheduleInput(snapshot, { baseDate, selectedProjectId, sourceProjectIds = {} }) {
  validateSnapshot(snapshot);
  const metadata = new Map((snapshot.planning?.issues ?? []).map(i => [i.number, i]));
  const sourceIds = new Map(Object.entries(sourceProjectIds).map(([url, id]) => [key(url), id]));
  const records = structuredClone(snapshot.planning?.schedule?.issues ?? snapshot.items.filter(i => i.kind === 'issue')
    .map(i => legacyIssue(snapshot, i, metadata.get(i.number)))).sort((a, b) => a.key.localeCompare(b.key));
  const issues = records.map(issue => ({
    key: issue.key, state: issue.state, parent: issue.parent, children: issue.children, blockedBy: issue.blockedBy,
    completion: scheduleCompletion(issue.state, issue.projects, issue.projectsComplete),
    planning: planningFor(issue, sourceIds.has(issue.key) ? sourceIds.get(issue.key) :
      issue.key.startsWith(key(snapshot.repositoryUrl) + '/issues/') ? selectedProjectId : null),
  }));
  const milestones = (snapshot.planning?.milestones ?? []).map(m => ({
    key: key(m.url), state: m.state, dueDate: m.dueOn === null ? null : m.dueOn.slice(0, 10),
    tasks: links(records.filter(i => i.key.startsWith(key(snapshot.repositoryUrl) + '/issues/') && metadata.get(Number(i.key.split('/').at(-1)))?.milestoneNumber === m.number &&
      metadata.get(Number(i.key.split('/').at(-1)))?.childCount === 0).map(i => i.key)),
  }));
  return { baseDate, selectedProjectId, fetchedAt: snapshot.fetchedAt, issues, milestones };
}
