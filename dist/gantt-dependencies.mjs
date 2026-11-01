// Keep the calculation's leaf edges and their registered Issue pairs together.
export function releaseDependencies(input, result, milestone, groups) {
  const displayed = new Set(milestone.taskKeys);
  const scoped = new Set(displayed);
  function include(group) {
    scoped.add(group.key);
    group.children?.forEach(include);
  }
  groups.forEach(include);
  const targets = new Set(milestone.targetTaskKeys);
  const registered = new Map(result.relations.map(r => [r.id,r]));
  const covered = new Set(), pairs = new Map();
  const id = (from,to) => JSON.stringify([from,to]);
  const gaps = [];
  for (const edge of result.edges) {
    const evidence = edge.evidence.map(e => registered.get(e.relationId)).filter(Boolean);
    for (const r of evidence) covered.add(id(r.prerequisiteKey,r.successorKey));
    pairs.set(id(edge.from,edge.to),{...edge, registered:evidence});
  }
  // Completed and unresolved Issues can have registered relationships without a calculated edge.
  for (const issue of input.issues) {
    if (scoped.has(issue.key) && !issue.blockedBy.complete) gaps.push(issue.key);
    for (const from of issue.blockedBy.keys) {
      const key = id(from,issue.key);
      if (covered.has(key) || pairs.has(key)) continue;
      pairs.set(key,{from,to:issue.key,registered:[{prerequisiteKey:from,successorKey:issue.key}],criticalByMilestone:{}});
    }
  }
  const allEdges = [...pairs.values()];
  const edges = allEdges.filter(edge => (scoped.has(edge.from) && scoped.has(edge.to)) ||
    targets.has(edge.from) || targets.has(edge.to) || edge.registered.some(r =>
      (scoped.has(r.successorKey) && r.successorKey === edge.to) ||
      (scoped.has(r.prerequisiteKey) && r.prerequisiteKey === edge.from)));
  return {edges,allEdges,gaps};
}

// A hidden leaf is represented by its nearest visible real Issue row.
// Synthetic folders are navigation aids, never prerequisite Issues.
export function projectDependencies(edges, groups, collapsed) {
  const representative = new Map(), parents = new Set();
  function visit(entry, folded = null, hiddenFolder = false) {
    const folder = Boolean(entry.title);
    const row = folded ?? entry.key;
    representative.set(entry.key,row);
    if (!entry.children) return;
    if (!folder) parents.add(entry.key);
    const hidden = hiddenFolder || (folder && collapsed.has(entry.key));
    const next = folded ?? (!hidden && !folder && collapsed.has(entry.key) ? entry.key : null);
    for (const child of entry.children) visit(child,next,hidden);
  }
  for (const entry of groups) visit(entry);
  const pairs = new Map();
  for (const edge of edges) {
    const from = representative.get(edge.from) ?? edge.from;
    const to = representative.get(edge.to) ?? edge.to;
    const key = 'pair:'+JSON.stringify([from,to]);
    if (!pairs.has(key)) pairs.set(key,{key,from,to,internal:from===to && parents.has(from),edges:[]});
    pairs.get(key).edges.push(edge);
  }
  const priority = p => p.from !== p.to && parents.has(p.from) && parents.has(p.to) ? 0 : p.internal ? 1 : 2;
  return [...pairs.values()].sort((a,b)=>priority(a)-priority(b));
}
