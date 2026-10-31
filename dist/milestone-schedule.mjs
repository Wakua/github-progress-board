import { decimalMath, dateDay, nextWeekday, startCoordinate, endCoordinate, dayString, position } from './milestone-schedule-math.mjs';

const sorted = values => [...values].sort();
const unique = values => sorted(new Set(values));
const keyOf = value => typeof value === 'string' ? value.toLowerCase().replace(/\/$/, '') : value;
const idOf = (...parts) => JSON.stringify(parts);
const readOK = read => read?.problem === null;
const linksOK = links => links?.complete === true && links.problem === null;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const issueKeyOK = key => typeof key === 'string' && /^https:\/\/[^/]+\/[^/]+\/[^/]+\/issues\/\d+$/.test(key);
const max = values => values.reduce((a, b) => a > b ? a : b, 0n);
const min = values => values.reduce((a, b) => a < b ? a : b);

// Input contract errors are separate from unavailable or invalid planning data.
function prepare(input, diagnose) {
  let invalid = false;
  const fail = (key, field, code) => { invalid = true; diagnose(key, field, code, 'contract'); };
  if (!input || !Array.isArray(input.issues) || !Array.isArray(input.milestones)) {
    fail(null, 'input', 'invalid-structure');
    return { invalid: true, issues: new Map(), milestones: [] };
  }
  if (dateDay(input.baseDate) === null) fail(null, 'baseDate', 'invalid-date');
  if (typeof input.selectedProjectId !== 'string' || !input.selectedProjectId) fail(null, 'selectedProjectId', 'invalid-project');
  if (typeof input.fetchedAt !== 'string' || !Number.isFinite(Date.parse(input.fetchedAt))) fail(null, 'fetchedAt', 'invalid-timestamp');
  const checkRead = (read, key, field) => {
    if (!record(read) || !['not-fetched', 'forbidden', 'failed', null].includes(read.problem) || !('value' in read) || (read.problem !== null && read.value !== null)) fail(key, field, 'invalid-read');
  };
  const checkLinks = (links, key, field) => {
    if (!links || !Array.isArray(links.keys) || typeof links.complete !== 'boolean' || !['not-fetched', 'forbidden', 'failed', null].includes(links.problem)) {
      fail(key, field, 'invalid-links');
      return { keys: [], totalCount: null, complete: false, problem: 'failed' };
    }
    const keys = links.keys.map(keyOf);
    if (keys.some(k => !issueKeyOK(k))) fail(key, field, 'invalid-issue-key');
    if (new Set(keys).size !== keys.length) fail(key, field, 'duplicate-links');
    if (links.totalCount !== null && (!Number.isInteger(links.totalCount) || links.totalCount < keys.length)) fail(key, field, 'invalid-count');
    if (links.complete && (links.problem !== null || links.totalCount !== keys.length)) fail(key, field, 'inconsistent-completeness');
    return { ...links, keys: sorted(keys) };
  };
  const issues = new Map();
  for (const raw of input.issues) {
    const key = keyOf(raw?.key);
    if (!issueKeyOK(key)) fail(key, 'key', 'invalid-issue-key');
    if (issues.has(key)) fail(key, 'key', 'duplicate-key');
    checkRead(raw?.state, key, 'state');
    checkRead(raw?.parent, key, 'parent');
    if (readOK(raw?.state) && !['open', 'closed', null].includes(raw.state.value)) fail(key, 'state', 'invalid-state');
    if (readOK(raw?.parent) && raw.parent.value !== null && !issueKeyOK(keyOf(raw.parent.value))) fail(key, 'parent', 'invalid-issue-key');
    if (!['done', 'not-done', 'unknown'].includes(raw?.completion?.value) || !Array.isArray(raw?.completion?.reasons) || raw.completion.reasons.some(r => typeof r !== 'string')) fail(key, 'completion', 'invalid-completion');
    const planning = raw?.planning;
    if (!record(planning) || !['unselected', 'not-member', 'unavailable', null].includes(planning.sourceProblem) || (planning.sourceProjectId !== null && typeof planning.sourceProjectId !== 'string')) fail(key, 'planning', 'invalid-planning');
    for (const field of ['status', 'owner', 'estimatePoints', 'workProgressPercent', 'iteration']) checkRead(planning?.[field], key, field);
    issues.set(key, { ...raw, key, parent: { ...raw?.parent, value: keyOf(raw?.parent?.value) }, children: checkLinks(raw?.children, key, 'children'), blockedBy: checkLinks(raw?.blockedBy, key, 'blockedBy') });
  }
  const milestoneKeys = new Set();
  const milestones = input.milestones.map(raw => {
    const key = keyOf(raw?.key);
    if (typeof key !== 'string' || !/^https:\/\/[^/]+\/[^/]+\/[^/]+\/milestone\/\d+$/.test(key)) fail(key, 'key', 'invalid-milestone-key');
    if (milestoneKeys.has(key)) fail(key, 'key', 'duplicate-key');
    milestoneKeys.add(key);
    if (!['open', 'closed'].includes(raw?.state)) fail(key, 'state', 'invalid-state');
    return { ...raw, key, tasks: checkLinks(raw?.tasks, key, 'tasks') };
  }).sort((a, b) => a.key?.localeCompare(b.key));
  if (invalid) return { invalid, issues, milestones };
  // Both complete directions must agree; missing references remain data diagnostics.
  const hierarchy = new Map([...issues.keys()].map(key => [key, new Set()]));
  for (const issue of issues.values()) {
    for (const childKey of issue.children.keys) {
      const child = issues.get(childKey);
      if (child) {
        hierarchy.get(issue.key).add(childKey);
        if (linksOK(issue.children) && readOK(child.parent) && child.parent.value !== issue.key) fail(childKey, 'parent', 'inconsistent-hierarchy');
      }
    }
    const parent = readOK(issue.parent) && issues.get(issue.parent.value);
    if (parent) {
      hierarchy.get(parent.key).add(issue.key);
      if (linksOK(parent.children) && !parent.children.keys.includes(issue.key)) fail(issue.key, 'parent', 'inconsistent-hierarchy');
    }
  }
  for (const group of stronglyConnected(hierarchy)) {
    if (group.length > 1 || hierarchy.get(group[0]).has(group[0])) fail(group[0], 'parent', 'hierarchy-cycle');
  }
  return { invalid, issues, milestones };
}

function stronglyConnected(graph) {
  let index = 0;
  const indices = new Map(), low = new Map(), stack = [], active = new Set(), groups = [];
  const visit = key => {
    indices.set(key, index); low.set(key, index++); stack.push(key); active.add(key);
    for (const next of graph.get(key)) {
      if (!indices.has(next)) { visit(next); low.set(key, Math.min(low.get(key), low.get(next))); }
      else if (active.has(next)) low.set(key, Math.min(low.get(key), indices.get(next)));
    }
    if (low.get(key) === indices.get(key)) {
      const group = [];
      let member;
      do { member = stack.pop(); active.delete(member); group.push(member); } while (member !== key);
      groups.push(sorted(group));
    }
  };
  for (const key of sorted(graph.keys())) if (!indices.has(key)) visit(key);
  return groups;
}

/** Pure internal adapter boundary. See docs/milestone-gantt-calculation.md. */
export function calculateMilestoneSchedule(input) {
  const diagnostics = new Map();
  const diagnose = (key, field, code, kind = 'data', details = null) => {
    const id = idOf(kind, key, field, code);
    diagnostics.set(id, { id, kind, key, field, code, details });
    return id;
  };
  const prepared = prepare(input, diagnose);
  const result = {
    status: prepared.invalid ? 'invalid' : 'calculated',
    baseDate: input?.baseDate ?? null, calculationStartDate: null,
    fetchedAt: input?.fetchedAt ?? null, selectedProjectId: input?.selectedProjectId ?? null,
    tasks: [], milestones: [], edges: [], relations: [], hierarchy: [],
    cycles: [], overlaps: [], overlapUnchecked: [], diagnostics: [],
  };
  if (prepared.invalid) { result.diagnostics = [...diagnostics.values()].sort((a, b) => a.id.localeCompare(b.id)); return result; }
  const { issues, milestones } = prepared;
  const math = decimalMath([...issues.values()].map(i => i.planning.estimatePoints.value));
  const origin = nextWeekday(dateDay(input.baseDate));
  result.calculationStartDate = dayString(origin);
  const number = math.number;
  const at = (value, finish = false, duration = 0n) => position(origin, value, math, finish, duration);
  const nodes = new Map(), edges = new Map(), relations = new Map(), touched = new Set(), expansion = new Map();
  const readFailure = (key, field, read) => diagnose(key, field, read.problem || (read.value === null ? 'missing-value' : 'invalid-value'));
  const linksFailure = (key, field, links) => diagnose(key, field, links.problem || 'incomplete-list');
  // Expansion records a compact aggregate path per leaf, not every dependency path.
  const expand = key => {
    if (expansion.has(key)) return expansion.get(key);
    touched.add(key);
    const issue = issues.get(key);
    const value = { leaves: new Map(), causes: new Set() };
    expansion.set(key, value);
    if (!issue) { value.causes.add(diagnose(key, 'issue', 'missing-reference')); return value; }
    if (!linksOK(issue.children)) value.causes.add(linksFailure(key, 'children', issue.children));
    if (linksOK(issue.children) && issue.children.keys.length === 0) value.leaves.set(key, []);
    for (const childKey of issue.children.keys) {
      const child = expand(childKey);
      for (const [leaf, path] of child.leaves) value.leaves.set(leaf, unique([key, ...path]));
      for (const cause of child.causes) value.causes.add(cause);
    }
    return value;
  };
  const addNode = key => {
    if (nodes.has(key)) return nodes.get(key);
    const issue = issues.get(key), p = issue.planning;
    const node = {
      key, issue, done: issue.completion.value === 'done',
      causes: new Set(), directCauses: new Set(), viaEdges: new Set(),
      predecessors: new Map(), successors: new Map(),
      duration: null, release: null, end: null, es: null, ef: null,
    };
    nodes.set(key, node);
    if (node.done) { node.duration = 0n; return node; }
    if (issue.completion.value === 'unknown') node.causes.add(diagnose(key, 'completion', 'unknown-completion', 'data', [...issue.completion.reasons]));
    if (p.sourceProblem || !p.sourceProjectId) node.causes.add(diagnose(key, 'sourceProjectId', p.sourceProblem || 'missing-value'));
    else {
      const estimate = p.estimatePoints, progress = p.workProgressPercent, iteration = p.iteration;
      const validEstimate = readOK(estimate) && Number.isFinite(estimate.value) && estimate.value > 0;
      const validProgress = readOK(progress) && Number.isInteger(progress.value) && progress.value >= 0 && progress.value <= 100;
      if (!validEstimate) node.causes.add(readFailure(key, 'estimatePoints', estimate));
      if (!validProgress) node.causes.add(readFailure(key, 'workProgressPercent', progress));
      if (validEstimate && validProgress) node.duration = math.exact(estimate.value) * BigInt(100 - progress.value) / 100n;
      const start = dateDay(iteration.value?.startDate), end = dateDay(iteration.value?.endDate);
      if (!readOK(iteration) || start === null || end === null || end < start) node.causes.add(readFailure(key, 'iteration', iteration));
      else { node.release = BigInt(Math.max(0, startCoordinate(origin, start))) * math.unit; node.end = BigInt(endCoordinate(origin, end)) * math.unit; }
    }
    return node;
  };
  const milestoneWork = new Map();
  for (const milestone of milestones) {
    const work = { targets: new Set(), causes: new Set() };
    milestoneWork.set(milestone.key, work);
    if (milestone.state === 'closed') continue;
    if (!linksOK(milestone.tasks)) work.causes.add(linksFailure(milestone.key, 'tasks', milestone.tasks));
    for (const key of milestone.tasks.keys) {
      const expanded = expand(key);
      for (const leaf of expanded.leaves.keys()) { addNode(leaf); work.targets.add(leaf); }
      for (const cause of expanded.causes) work.causes.add(cause);
    }
  }
  // Map iteration includes newly discovered prerequisite leaves.
  for (const node of nodes.values()) {
    if (node.done) continue;
    let current = node.issue;
    const successorAggregates = [];
    while (current) {
      touched.add(current.key);
      if (!linksOK(current.blockedBy)) node.causes.add(linksFailure(current.key, 'blockedBy', current.blockedBy));
      for (const prerequisiteKey of current.blockedBy.keys) {
        const relationId = idOf('relation', prerequisiteKey, current.key);
        relations.set(relationId, { id: relationId, prerequisiteKey, successorKey: current.key });
        const expanded = expand(prerequisiteKey);
        for (const cause of expanded.causes) node.causes.add(cause);
        for (const [from, prerequisiteAggregates] of expanded.leaves) {
          const prerequisite = addNode(from);
          const id = idOf('edge', from, node.key);
          if (!edges.has(id)) edges.set(id, { id, from, to: node.key, evidence: new Map(), criticalByMilestone: {} });
          const edge = edges.get(id);
          edge.evidence.set(relationId, { relationId, prerequisiteAggregates, successorAggregates: sorted(successorAggregates) });
          node.predecessors.set(from, id); prerequisite.successors.set(node.key, id);
        }
      }
      if (!readOK(current.parent)) { node.causes.add(readFailure(current.key, 'parent', current.parent)); break; }
      if (!current.parent.value) break;
      const parentKey = current.parent.value;
      touched.add(parentKey);
      current = issues.get(parentKey);
      if (!current) { node.causes.add(diagnose(parentKey, 'issue', 'missing-reference')); break; }
      successorAggregates.push(parentKey);
    }
  }
  const graph = new Map([...nodes.values()].filter(n => !n.done).map(n => [n.key, new Set([...n.successors.keys()].filter(k => !nodes.get(k).done))]));
  for (const group of stronglyConnected(graph)) {
    if (group.length < 2 && !graph.get(group[0]).has(group[0])) continue;
    const cause = diagnose(group[0], 'blockedBy', 'dependency-cycle', 'data', { taskKeys: group });
    result.cycles.push({ taskKeys: group, diagnosticId: cause });
    for (const key of group) nodes.get(key).causes.add(cause);
  }
  // Propagate only cause IDs and immediate edges; cycle members remain distinct from affected successors.
  const queue = [...nodes.values()].filter(n => n.causes.size);
  for (const node of nodes.values()) node.directCauses = new Set(node.causes);
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    for (const [key, edgeId] of node.successors) {
      const next = nodes.get(key);
      if (next.done) continue;
      next.viaEdges.add(edgeId);
      const size = next.causes.size;
      for (const cause of node.causes) next.causes.add(cause);
      if (next.causes.size !== size) queue.push(next);
    }
  }
  const order = [], visited = new Set();
  const forward = node => {
    if (visited.has(node.key) || node.done || node.causes.size) return;
    visited.add(node.key);
    for (const key of node.predecessors.keys()) forward(nodes.get(key));
    // Conversion limits can be discovered during forward calculation as well.
    for (const [key, edgeId] of node.predecessors) {
      const previous = nodes.get(key);
      if (previous.causes.size) {
        node.viaEdges.add(edgeId);
        for (const cause of previous.causes) node.causes.add(cause);
      }
    }
    if (node.causes.size) return;
    node.es = max([node.release, ...[...node.predecessors.keys()].map(k => nodes.get(k)).filter(n => !n.done).map(n => n.ef)]);
    node.ef = node.es + node.duration;
    if (!Number.isFinite(number(node.ef)) || at(node.es).date === null || at(node.ef, true, node.duration).date === null) {
      const cause = diagnose(node.key, 'schedule', 'out-of-range');
      node.causes.add(cause); node.directCauses.add(cause);
      node.es = null; node.ef = null;
      return;
    }
    order.push(node.key);
  };
  for (const key of sorted(nodes.keys())) forward(nodes.get(key));

  for (const milestone of milestones) {
    const work = milestoneWork.get(milestone.key), reachable = new Set();
    const collect = key => {
      if (reachable.has(key)) return;
      reachable.add(key);
      const node = nodes.get(key);
      if (!node.done) for (const parent of node.predecessors.keys()) collect(parent);
    };
    for (const key of work.targets) collect(key);
    for (const key of reachable) for (const cause of nodes.get(key).causes) work.causes.add(cause);
    const active = [...reachable].filter(k => !nodes.get(k).done);
    const state = milestone.state === 'closed' ? 'excluded' : work.causes.size ? 'incomplete' : !work.targets.size ? 'empty' : !active.length ? 'completed' : 'calculated';
    const remainingKnown = work.causes.size === 0 && active.every(k => nodes.get(k).duration !== null);
    const output = {
      key: milestone.key, state,
      targetTaskKeys: sorted(work.targets), taskKeys: sorted(reachable), diagnosticIds: sorted(work.causes),
      remainingPoints: remainingKnown ? number(active.reduce((sum, k) => sum + nodes.get(k).duration, 0n)) : null,
      finish: null, dueDate: milestone.dueDate, dueDifference: null,
      tasks: [], criticalTaskKeys: [], criticalEdgeIds: [],
    };
    const dueDay = dateDay(milestone.dueDate);
    if (milestone.dueDate !== null && dueDay === null) output.diagnosticIds.push(diagnose(milestone.key, 'dueDate', 'invalid-date'));
    if (state === 'calculated') {
      const finish = max([...work.targets].map(k => nodes.get(k)).filter(n => !n.done).map(n => n.ef));
      const finishDuration = [...work.targets].map(k => nodes.get(k)).some(n => n.ef === finish && n.duration > 0n) ? 1n : 0n;
      output.finish = at(finish, true, finishDuration);
      if (dueDay !== null) {
        const difference = BigInt(endCoordinate(origin, dueDay)) * math.unit - finish;
        output.dueDifference = { days: number(difference), relation: difference < 0n ? 'late' : difference > 0n ? 'early' : 'on-time', display: math.display(difference) };
      }
      const latest = new Map();
      for (const key of [...order].reverse().filter(k => reachable.has(k))) {
        const node = nodes.get(key);
        const ends = [...node.successors.keys()].filter(k => latest.has(k)).map(k => latest.get(k).ls);
        if (work.targets.has(key)) ends.push(finish);
        const lf = min(ends), ls = lf - node.duration, slack = ls - node.es;
        latest.set(key, { lf, ls, slack });
      }
      for (const key of sorted(reachable)) {
        const node = nodes.get(key), timing = latest.get(key);
        output.tasks.push({
          key, latestStart: timing ? at(timing.ls) : null,
          latestFinish: timing ? at(timing.lf, true, node.duration) : null,
          slackDays: timing ? number(timing.slack) : null,
          slackDisplay: timing ? math.display(timing.slack) : null,
          critical: timing ? timing.slack === 0n : false, diagnosticIds: [],
        });
        if (timing?.slack === 0n) output.criticalTaskKeys.push(key);
      }
      for (const edge of edges.values()) {
        if (!reachable.has(edge.from) || !reachable.has(edge.to)) continue;
        const critical = latest.get(edge.from)?.slack === 0n && latest.get(edge.to)?.slack === 0n && nodes.get(edge.from).ef === nodes.get(edge.to).es;
        edge.criticalByMilestone[milestone.key] = critical;
        if (critical) output.criticalEdgeIds.push(edge.id);
      }
    } else {
      output.tasks = sorted(reachable).map(key => ({ key, latestStart: null, latestFinish: null, slackDays: null, slackDisplay: null, critical: null, diagnosticIds: sorted(work.causes) }));
      for (const edge of edges.values()) if (reachable.has(edge.from) && reachable.has(edge.to)) edge.criticalByMilestone[milestone.key] = state === 'incomplete' ? null : false;
    }
    output.criticalEdgeIds.sort();
    result.milestones.push(output);
  }
  const owners = new Map();
  for (const key of sorted(nodes.keys())) {
    const node = nodes.get(key), p = node.issue.planning;
    const overflow = node.ef !== null && node.ef > node.end ? node.ef - node.end : null;
    result.tasks.push({
      key, sourceProjectId: p.sourceProjectId,
      completion: { value: node.issue.completion.value, reasons: [...node.issue.completion.reasons] },
      remainingPoints: node.duration === null ? null : number(node.duration),
      durationDays: node.duration === null ? null : number(node.duration),
      durationDisplay: node.duration === null ? null : math.display(node.duration),
      earliestStart: node.es === null ? null : at(node.es),
      earliestFinish: node.ef === null ? null : at(node.ef, true, node.duration),
      iterationOverflow: overflow === null ? null : { days: number(overflow), display: math.display(overflow) },
      diagnosticIds: sorted(node.causes), directDiagnosticIds: sorted(node.directCauses), viaEdgeIds: sorted(node.viaEdges),
    });
    if (node.done) continue;
    const reasons = [];
    if (p.sourceProblem || !p.sourceProjectId) reasons.push('source-unavailable');
    else if (p.sourceProjectId !== input.selectedProjectId) reasons.push('outside-project');
    if (!readOK(p.owner) || typeof p.owner.value !== 'string' || !p.owner.value.trim()) reasons.push('owner-unknown');
    if (node.es === null) reasons.push('schedule-unknown');
    if (reasons.length) result.overlapUnchecked.push({ key, reasons });
    else if (node.duration > 0n) {
      const owner = p.owner.value;
      if (!owners.has(owner)) owners.set(owner, []);
      owners.get(owner).push(node);
    }
  }
  for (const owner of sorted(owners.keys())) {
    const tasks = owners.get(owner), points = [...new Set(tasks.flatMap(n => [n.es, n.ef]))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i], end = points[i + 1];
      const taskKeys = tasks.filter(n => n.es <= start && n.ef > start).map(n => n.key).sort();
      if (taskKeys.length > 1) result.overlaps.push({ sourceProjectId: input.selectedProjectId, owner, taskKeys, start: at(start), finish: at(end, true, end - start) });
    }
  }
  result.edges = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)).map(edge => ({ ...edge, evidence: [...edge.evidence.values()].sort((a, b) => a.relationId.localeCompare(b.relationId)) }));
  result.relations = [...relations.values()].sort((a, b) => a.id.localeCompare(b.id));
  result.hierarchy = sorted(touched).filter(k => issues.has(k)).map(key => ({ key, parent: { ...issues.get(key).parent }, children: { ...issues.get(key).children, keys: [...issues.get(key).children.keys] } }));
  result.cycles.sort((a, b) => a.taskKeys[0].localeCompare(b.taskKeys[0]));
  result.diagnostics = [...diagnostics.values()].sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
