// Optional snapshot extension. The existing repository-wide planning stays unchanged.
export const SCHEDULE_FIELDS = Object.freeze({ status: 'Status', owner: '担当', estimatePoints: 'Estimate', workProgressPercent: '作業進捗率', iteration: 'Iteration' });
const fail = () => { throw new Error('ガントの取得データが不完全または不整合です。'); };
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, fields) => { if (!record(v) || fields.some(f => !Object.hasOwn(v, f)) || Object.keys(v).some(f => !fields.includes(f))) fail(); };
const text = v => { if (typeof v !== 'string' || !v.trim() || v.length > 1000) fail(); };
const issueKey = v => typeof v === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/.test(v) && v === v.toLowerCase();
const time = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().replace('.000Z', 'Z') === v.replace('.000Z', 'Z');
const problems = [null, 'not-fetched', 'forbidden', 'failed'];
function checkRead(v, check) {
  exact(v, ['value', 'problem']);
  if (!problems.includes(v.problem) || (v.problem !== null && v.value !== null)) fail();
  if (v.value !== null && !check(v.value)) fail();
}
function checkLinks(v) {
  exact(v, ['keys', 'totalCount', 'complete', 'problem']);
  if (!Array.isArray(v.keys) || v.keys.length > 5000 || v.keys.some(k => !issueKey(k)) || new Set(v.keys).size !== v.keys.length ||
      !problems.includes(v.problem) || typeof v.complete !== 'boolean' ||
      (v.totalCount !== null && (!Number.isSafeInteger(v.totalCount) || v.totalCount < v.keys.length)) ||
      (v.complete && (v.problem !== null || v.totalCount !== v.keys.length))) fail();
}
export function validateScheduleData(schedule, snapshot) {
  exact(schedule, ['schemaVersion', 'sourceUrl', 'issues']);
  if (schedule.schemaVersion !== 1 || schedule.sourceUrl !== 'https://api.github.com/graphql' || !Array.isArray(schedule.issues) || schedule.issues.length > 5000) fail();
  const issues = new Map(), local = new Map(snapshot.items.filter(i => i.kind === 'issue').map(i => [i.url.toLowerCase(), i]));
  const catalogs = new Map(), fieldIds = new Map();
  for (const i of schedule.issues) {
    exact(i, ['key', 'title', 'updatedAt', 'state', 'parent', 'children', 'blockedBy', 'projects', 'projectsComplete', 'projectsProblem']);
    if (!issueKey(i.key) || issues.has(i.key)) fail();
    text(i.title);
    if (!time(i.updatedAt) || Date.parse(i.updatedAt) > Date.parse(snapshot.fetchedAt) + 300000) fail();
    checkRead(i.state, v => ['open', 'closed'].includes(v));
    checkRead(i.parent, issueKey);
    checkLinks(i.children); checkLinks(i.blockedBy);
    if (!Array.isArray(i.projects) || i.projects.length > 100 || new Set(i.projects.map(p => p.id)).size !== i.projects.length ||
        typeof i.projectsComplete !== 'boolean' || !problems.includes(i.projectsProblem) || (i.projectsComplete && i.projectsProblem !== null)) fail();
    for (const p of i.projects) {
      exact(p, ['id', 'title', 'url', 'fieldSources', ...Object.keys(SCHEDULE_FIELDS)]);
      text(p.id); text(p.title);
      if (typeof p.url !== 'string' || !/^https:\/\/github\.com\/(users|orgs)\/[\w.-]+\/projects\/[1-9]\d*$/.test(p.url)) fail();
      const catalog = JSON.stringify([p.title, p.url]);
      if (catalogs.has(p.id) && catalogs.get(p.id) !== catalog) fail();
      catalogs.set(p.id, catalog);
      exact(p.fieldSources, Object.keys(SCHEDULE_FIELDS));
      for (const [field, name] of Object.entries(SCHEDULE_FIELDS)) {
        const source = p.fieldSources[field];
        exact(source, ['id', 'name']);
        if (source.name !== name) fail();
        if (source.id !== null) text(source.id);
        const fieldKey = `${p.id}:${field}`;
        if (source.id !== null) {
          if (fieldIds.has(fieldKey) && fieldIds.get(fieldKey) !== source.id) fail();
          fieldIds.set(fieldKey, source.id);
        }
        // Domain-invalid numbers/dates remain fetched data for calculation diagnostics.
        checkRead(p[field], v => {
          if (field === 'iteration') return record(v) && Object.keys(v).length === 2 && typeof v.startDate === 'string' && typeof v.endDate === 'string' && v.startDate.length <= 100 && v.endDate.length <= 100;
          if (field === 'estimatePoints' || field === 'workProgressPercent') return typeof v === 'number' && Number.isFinite(v);
          return typeof v === 'string' && v.length <= 1000;
        });
      }
    }
    const original = local.get(i.key);
    if (original && (i.state.problem !== null || i.state.value !== original.state || i.title !== original.title || Date.parse(i.updatedAt) !== Date.parse(original.updatedAt))) fail();
    if (!original && i.key.startsWith(snapshot.repositoryUrl.toLowerCase() + '/issues/')) fail();
    issues.set(i.key, i);
  }
  if ([...local.keys()].some(k => !issues.has(k))) fail();
  for (const i of issues.values()) {
    if (i.parent.value === i.key || i.children.keys.includes(i.key)) fail();
    const seen = new Set([i.key]);
    let current = i;
    while (current.parent.problem === null && current.parent.value !== null && issues.has(current.parent.value)) {
      const parent = issues.get(current.parent.value);
      if (seen.has(parent.key) || (parent.children.complete && !parent.children.keys.includes(current.key))) fail();
      seen.add(parent.key); current = parent;
    }
    for (const childKey of i.children.keys) {
      const child = issues.get(childKey);
      if (child?.parent.problem === null && child.parent.value !== i.key) fail();
    }
  }
  // The extension must not silently disagree with the legacy planning used for classification.
  for (const m of snapshot.planning.issues) {
    const i = issues.get(`${snapshot.repositoryUrl}/issues/${m.number}`.toLowerCase());
    if (i.parent.problem !== null || i.parent.value !== (m.parent?.url.toLowerCase() ?? null) || i.children.totalCount !== m.childCount) fail();
    if (m.blockedBy && (i.blockedBy.problem !== null || !i.blockedBy.complete || JSON.stringify([...i.blockedBy.keys].sort()) !== JSON.stringify(m.blockedBy.map(b => b.url.toLowerCase()).sort()))) fail();
    if (!i.projectsComplete || i.projects.length !== m.projects.length) fail();
    for (const p of m.projects) {
      const q = i.projects.find(q => q.id === p.id);
      if (!q || q.title !== p.title || q.url !== p.url) fail();
      for (const field of ['status', 'owner', 'estimatePoints']) if (q[field].problem !== null || q[field].value !== p[field]) fail();
      const iteration = p.iteration ? { startDate: p.iteration.startDate, endDate: new Date(Date.parse(p.iteration.startDate) + (p.iteration.duration - 1) * 86400000).toISOString().slice(0, 10) } : null;
      if (q.iteration.problem !== null || JSON.stringify(q.iteration.value) !== JSON.stringify(iteration)) fail();
    }
  }
  return schedule;
}
