// Read-only GitHub planning metadata; manual plans never enter this model.
const fail = () => { throw new Error('GitHubの計画情報が不完全または不整合です。'); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, required, optional = []) => {
  if (!object(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) fail();
};
const text = (v, max = 1000) => { if (typeof v !== 'string' || !v.trim() || v.length > max) fail(); };
const nullableText = v => { if (v !== null) text(v); };
const integer = (v, min = 0) => { if (!Number.isSafeInteger(v) || v < min) fail(); };
const date = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) fail();
};
const time = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v) || !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString().replace('.000Z', 'Z') !== v.replace('.000Z', 'Z')) fail();
};
const issueUrl = (url, number) => {
  if (typeof url !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/.test(url) || !url.endsWith('/' + number)) fail();
};
const WORK_KEYS = ['blockedBy', 'pullRequests', 'spec'];
// Projectの「優先度」の値。どれかのProjectで緊急なら、その作業は緊急。
export const URGENT_PRIORITY = '緊急';
export const isUrgent = task => task.projects.some(p => p.priority === URGENT_PRIORITY);
export function validatePlanning(planning, snapshot) {
  keys(planning, ['sources', 'issues', 'milestones']);
  keys(planning.sources, ['hierarchy', 'milestones']);
  keys(planning.sources.hierarchy, ['complete', 'url']);
  if (planning.sources.hierarchy.complete !== true || planning.sources.hierarchy.url !== 'https://api.github.com/graphql') fail();
  const source = planning.sources.milestones;
  keys(source, ['complete', 'urls']);
  if (source.complete !== true || !Array.isArray(source.urls) || !source.urls.length || source.urls.length > 50) fail();
  source.urls.forEach((url, i) => {
    if (url !== `https://api.github.com/repos/${snapshot.repositoryUrl.slice(19)}/milestones?state=all&per_page=100&sort=due_on&direction=asc&page=${i + 1}`) fail();
  });
  if (!Array.isArray(planning.issues) || !Array.isArray(planning.milestones) || planning.milestones.length > 5000) fail();
  const issues = new Map(snapshot.items.filter(i => i.kind === 'issue').map(i => [i.number, i]));
  const metadata = new Map(), milestones = new Set(), projectSources = new Map(), iterationSources = new Map(), projectEntries = [];
  for (const m of planning.milestones) {
    keys(m, ['number', 'url', 'title', 'description', 'state', 'dueOn', 'updatedAt', 'closedAt']);
    integer(m.number, 1); text(m.title);
    if (m.url.toLowerCase() !== `${snapshot.repositoryUrl}/milestone/${m.number}`.toLowerCase() || milestones.has(m.number)) fail();
    if (m.description !== null && (typeof m.description !== 'string' || m.description.length > 20000)) fail();
    if (!['open', 'closed'].includes(m.state)) fail();
    time(m.updatedAt);
    if (Date.parse(m.updatedAt) > Date.parse(snapshot.fetchedAt) + 300000) fail();
    if (m.dueOn !== null) time(m.dueOn);
    if (m.closedAt !== null) { time(m.closedAt); if (Date.parse(m.closedAt) > Date.parse(m.updatedAt)) fail(); }
    if ((m.state === 'open') !== (m.closedAt === null)) fail();
    milestones.add(m.number);
  }
  for (const m of planning.issues) {
    keys(m, ['number', 'parent', 'childCount', 'milestoneNumber', 'projects'], ['moduleLabels', ...WORK_KEYS]);
    // 前提・紐づくPR・仕様ラベルは後から取得に加えた。古いsnapshotには3つとも無く、新しいsnapshotには3つとも有る。
    const workKeys = WORK_KEYS.filter(k => Object.hasOwn(m, k)).length;
    if (workKeys && workKeys !== WORK_KEYS.length) fail();
    if (workKeys) {
      if (typeof m.spec !== 'boolean' || !Array.isArray(m.blockedBy) || m.blockedBy.length > 50 || !Array.isArray(m.pullRequests) || m.pullRequests.length > 20) fail();
      for (const b of m.blockedBy) {
        keys(b, ['number', 'url', 'title', 'state', 'spec']); integer(b.number, 1); issueUrl(b.url, b.number); text(b.title);
        if (!['open', 'closed'].includes(b.state) || typeof b.spec !== 'boolean') fail();
      }
      if (new Set(m.blockedBy.map(b => b.url.toLowerCase())).size !== m.blockedBy.length) fail();
      for (const pr of m.pullRequests) {
        keys(pr, ['number', 'url', 'draft']); integer(pr.number, 1);
        if (typeof pr.url !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(pr.url) || !pr.url.endsWith('/' + pr.number) || typeof pr.draft !== 'boolean') fail();
      }
    }
    if (Object.hasOwn(m, 'moduleLabels')) {
      if (!Array.isArray(m.moduleLabels) || m.moduleLabels.length > 100 || new Set(m.moduleLabels).size !== m.moduleLabels.length) fail();
      for (const label of m.moduleLabels) { text(label); if (!/^module:/i.test(label) || !label.slice(7).trim()) fail(); }
    }
    integer(m.number, 1); integer(m.childCount);
    if (!issues.has(m.number) || metadata.has(m.number)) fail();
    if (m.parent !== null) {
      keys(m.parent, ['number', 'url']); integer(m.parent.number, 1); issueUrl(m.parent.url, m.parent.number);
      if (m.parent.url.toLowerCase() === issues.get(m.number).url.toLowerCase()) fail();
    }
    if (m.milestoneNumber !== null && !milestones.has(m.milestoneNumber)) fail();
    if (!Array.isArray(m.projects) || m.projects.length > 100) fail();
    const projects = new Set();
    for (const p of m.projects) {
      // 優先度は後から取得に加えた。古いsnapshotには無く、新しいsnapshotではすべてのProject登録に有る。
      keys(p, ['id', 'title', 'url', 'owner', 'status', 'estimatePoints', 'iteration'], ['priority']);
      text(p.id); text(p.title); nullableText(p.owner); nullableText(p.status);
      if (Object.hasOwn(p, 'priority')) nullableText(p.priority);
      projectEntries.push(p);
      if (projects.has(p.id) || typeof p.url !== 'string' || !/^https:\/\/github\.com\/(users|orgs)\/[\w.-]+\/projects\/[1-9]\d*$/.test(p.url)) fail();
      if (p.estimatePoints !== null && (typeof p.estimatePoints !== 'number' || !Number.isFinite(p.estimatePoints) || p.estimatePoints < 0)) fail();
      if (p.iteration !== null) {
        keys(p.iteration, ['id', 'title', 'startDate', 'duration']);
        text(p.iteration.id); text(p.iteration.title); date(p.iteration.startDate); integer(p.iteration.duration, 1);
        if (p.iteration.duration > 3660) fail();
      }
      const source = JSON.stringify([p.title, p.url]);
      if (projectSources.has(p.id) && projectSources.get(p.id) !== source) fail();
      projectSources.set(p.id, source);
      if (p.iteration) {
        const key = p.id + ':' + p.iteration.id, value = JSON.stringify(p.iteration);
        if (iterationSources.has(key) && iterationSources.get(key) !== value) fail();
        iterationSources.set(key, value);
      }
      projects.add(p.id);
    }
    metadata.set(m.number, m);
  }
  if (metadata.size !== issues.size) fail();
  const moduleCoverage = planning.issues.filter(i => Object.hasOwn(i, 'moduleLabels')).length;
  if (moduleCoverage && moduleCoverage !== planning.issues.length) fail();
  const workCoverage = planning.issues.filter(i => Object.hasOwn(i, 'spec')).length;
  if (workCoverage && workCoverage !== planning.issues.length) fail();
  const priorityCoverage = projectEntries.filter(p => Object.hasOwn(p, 'priority')).length;
  if (priorityCoverage && priorityCoverage !== projectEntries.length) fail();
  const childCounts = new Map();
  for (const m of metadata.values()) {
    let node = m, seen = new Set([m.number]);
    while (node.parent && node.parent.url.toLowerCase().startsWith(snapshot.repositoryUrl.toLowerCase() + '/issues/')) {
      const parent = metadata.get(node.parent.number);
      if (!parent || seen.has(parent.number)) fail();
      seen.add(parent.number); node = parent;
    }
    if (m.parent?.url.toLowerCase().startsWith(snapshot.repositoryUrl.toLowerCase() + '/issues/')) childCounts.set(m.parent.number, (childCounts.get(m.parent.number) || 0) + 1);
  }
  for (const m of metadata.values()) if (m.childCount < (childCounts.get(m.number) || 0)) fail();
  return planning;
}

export function githubPlan(snapshot) {
  if (!snapshot?.planning) return null;
  const records = new Map(snapshot.items.filter(i => i.kind === 'issue').map(i => [i.number, i]));
  const issues = snapshot.planning.issues.map(m => ({ ...m, item: records.get(m.number) })).sort((a, b) => a.number - b.number);
  const byNumber = new Map(issues.map(i => [i.number, i]));
  const rootFor = issue => {
    let current = issue;
    while (current.parent) {
      if (!current.parent.url.toLowerCase().startsWith(snapshot.repositoryUrl.toLowerCase() + '/issues/')) return null;
      current = byNumber.get(current.parent.number);
    }
    return current.childCount > 0 ? current : null;
  };
  const modulesFetched = issues.every(i => Object.hasOwn(i, 'moduleLabels'));
  const moduleFor = issue => {
    if (!modulesFetched) return { kind: 'unfetched', name: null, source: null };
    let current = issue;
    while (current) {
      const names = [...new Set(current.moduleLabels.map(label => label.slice(7).trim()))];
      if (names.length) return { kind: 'assigned', name: names.join(' / '), ...(names.length > 1 ? { names } : {}), source: current.number };
      current = current.parent && current.parent.url.toLowerCase().startsWith(snapshot.repositoryUrl.toLowerCase() + '/issues/') ? byNumber.get(current.parent.number) : null;
    }
    return { kind: 'unassigned', name: null, source: null };
  };
  const tasks = issues.filter(i => i.childCount === 0).map(i => ({ ...i, goal: rootFor(i), module: moduleFor(i) }));
  const goals = issues.filter(i => !i.parent && i.childCount > 0).map(i => ({ ...i, tasks: tasks.filter(t => t.goal?.number === i.number) }));
  const periods = new Map();
  for (const task of tasks) for (const p of task.projects) if (p.iteration) {
    const key = p.id + ':' + p.iteration.id;
    if (!periods.has(key)) periods.set(key, { key, project: p, iteration: p.iteration, tasks: [] });
    periods.get(key).tasks.push(task);
  }
  return { issues, tasks, goals,
    periods: [...periods.values()].sort((a, b) => a.iteration.startDate.localeCompare(b.iteration.startDate) || a.key.localeCompare(b.key)),
    unassigned: tasks.filter(t => !t.projects.some(p => p.iteration)),
    releases: snapshot.planning.milestones.map(m => ({ ...m, tasks: tasks.filter(t => t.milestoneNumber === m.number) })) };
}

// Estimate belongs to a source Project. Repository-wide scopes require one source per task.
export function githubProgress(tasks, projectId = null) {
  tasks = [...new Map(tasks.map(t => [t.item.url.toLowerCase(), t])).values()];
  const estimates = tasks.map(task => {
    const projects = projectId ? task.projects.filter(p => p.id === projectId) : task.projects;
    return { task, ambiguous: projects.length > 1, points: projects.length === 1 && projects[0].estimatePoints > 0 ? projects[0].estimatePoints : null };
  });
  // Unset estimates are excluded from points, but every Issue remains in the task counts and lists.
  const included = estimates.filter(row => row.points !== null || row.ambiguous);
  const sum = rows => { const value = rows.reduce((total, row) => total + row.points, 0); return rows.every(row => row.points !== null) && Number.isFinite(value) ? value : null; };
  const closed = included.filter(row => row.task.item.state === 'closed');
  const remaining = included.filter(row => row.task.item.state !== 'closed');
  const totalPoints = included.length ? sum(included) : null, closedPoints = sum(closed), remainingPoints = sum(remaining);
  const percent = totalPoints > 0 && closedPoints !== null ? Math.round(closedPoints / totalPoints * 100) : null;
  return { total: tasks.length, closed: estimates.filter(row => row.task.item.state === 'closed').length,
    estimatedTasks: estimates.filter(row => row.points !== null).length, totalPoints, closedPoints, remainingPoints,
    missingEstimates: estimates.filter(row => row.points === null && !row.ambiguous).length,
    ambiguousEstimates: estimates.filter(row => row.ambiguous).length,
    percent: percent !== null && remaining.length ? Math.min(99, percent) : percent };
}
export function githubModules(plan) {
  const groups = new Map();
  for (const task of plan.tasks) {
    const names = task.module.kind === 'assigned' ? task.module.names ?? [task.module.name] : [null];
    for (const name of names) {
      const key = task.module.kind + ':' + (name ?? '');
      if (!groups.has(key)) groups.set(key, { key, ...task.module, name, tasks: [] });
      groups.get(key).tasks.push(task);
    }
  }
  return [...groups.values()].map(group => {
    const numbers = new Set(group.tasks.map(task => task.number));
    return { ...group, goals: plan.goals.map(goal => ({ ...goal, tasks: goal.tasks.filter(task => numbers.has(task.number)) })).filter(goal => goal.tasks.length),
      releases: plan.releases.map(release => ({ ...release, tasks: release.tasks.filter(task => numbers.has(task.number)) })).filter(release => release.tasks.length) };
  }).sort((a, b) => Number(a.kind !== 'assigned') - Number(b.kind !== 'assigned') || a.key.localeCompare(b.key, 'ja'));
}
