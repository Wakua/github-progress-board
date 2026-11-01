// Keep the calculated task set. Ancestors are headings, never extra schedule rows.
export function groupGanttTasks(tasks, issues) {
  const parents = new Map(issues.filter(issue => issue.parent.problem === null).map(issue => [issue.key, issue.parent.value]));
  // If the child's parent was not fetched, a known child link still identifies it.
  const fromChildren = new Map();
  for (const issue of issues) {
    for (const child of issue.children.keys) {
      if (parents.has(child)) continue;
      const previous = fromChildren.get(child);
      fromChildren.set(child, previous === undefined || previous === issue.key ? issue.key : null);
    }
  }
  for (const [child,parent] of fromChildren) parents.set(child,parent);
  const groups = new Map();
  const roots = [];
  for (const task of tasks) {
    const chain = [];
    let parent = parents.get(task.key);
    while (parent && !groups.has(parent)) {
      chain.push(parent);
      parent = parents.get(parent);
    }
    let entries = groups.get(parent) ?? roots;
    for (const key of chain.reverse()) {
      const children = [];
      entries.push({ key, children });
      groups.set(key, children);
      entries = children;
    }
    entries.push({ key: task.key, task });
  }
  return roots;
}
