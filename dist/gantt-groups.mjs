import { validWorkProgress } from './milestone-schedule.mjs';
import { calendarPosition, diagnosticReason } from './gantt-axis.mjs';

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
    const visited = new Set([task.key]);
    while (parent && !groups.has(parent)) {
      if (visited.has(parent)) { chain.length = 0; parent = null; break; }
      visited.add(parent);
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

export function releaseGoalGroups(milestone, tasks, issues) {
  const targets = new Set(milestone.targetTaskKeys);
  const required = new Set(milestone.taskKeys);
  const groups = groupGanttTasks(tasks.filter(task => targets.has(task.key)), issues);
  const roots = new Set(issues.filter(issue => !issue.external && issue.parent.problem === null && issue.parent.value === null).map(issue => issue.key));
  const goals = groups.filter(group => group.children && roots.has(group.key));
  const others = [];
  const ungrouped = groups.filter(group => group.task || !roots.has(group.key));
  if (ungrouped.length) others.push({key:'ungrouped', title:'目標のない・特定できない作業', children:ungrouped});
  const prerequisites = tasks.filter(task => required.has(task.key) && !targets.has(task.key));
  if (prerequisites.length) others.push({key:'prerequisites', title:'リリース外の前提', children:prerequisites.map(task => ({key:task.key, task}))});
  if (others.length) goals.push({key:'other-work', title:'その他の作業', children:others});
  return goals;
}

// Membership is resolved by releaseGoalGroups before either rollup.
function leafTasks(entry) {
  return entry.task ? [entry.task] : entry.children.flatMap(leafTasks);
}

export function goalSchedule(group) {
  let earliestStart = null, earliestFinish = null, scheduled = 0;
  const remaining = leafTasks(group).filter(task => task.completion.value !== 'done');
  let firstUnscheduled = null;
  for (const task of remaining) {
    if (!task.earliestStart || !task.earliestFinish) {
      firstUnscheduled ??= task.key;
      continue;
    }
    scheduled++;
    if (!earliestStart || calendarPosition(task.earliestStart) < calendarPosition(earliestStart)) earliestStart = task.earliestStart;
    if (!earliestFinish || calendarPosition(task.earliestFinish) > calendarPosition(earliestFinish)) earliestFinish = task.earliestFinish;
  }
  return {earliestStart, earliestFinish, scheduled, remaining:remaining.length, firstUnscheduled};
}

export function goalProgress(group, sources) {
  const leaves = leafTasks(group).map(task => sources.get(task.key));
  let total = 0, weighted = 0;
  const gaps = new Set();
  for (const issue of leaves) {
    const {estimatePoints: estimate, workProgressPercent: progress} = issue.planning;
    if (estimate.problem || !Number.isFinite(estimate.value) || estimate.value <= 0)
      gaps.add('見積' + diagnosticReason(estimate.problem ?? (estimate.value === null ? 'missing-value' : 'invalid-value')));
    if (!validWorkProgress(progress))
      gaps.add('進捗' + diagnosticReason(progress.problem ?? (progress.value === null ? 'missing-value' : 'invalid-value')));
    if (!gaps.size) {
      total += estimate.value;
      weighted += estimate.value * progress.value;
    }
  }
  const percent = !gaps.size && total > 0 ? weighted / total : null;
  return {count:leaves.length, percent, gaps:[...gaps]};
}
