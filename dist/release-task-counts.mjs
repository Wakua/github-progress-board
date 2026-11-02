import { githubTaskDone } from './github-work.mjs';

export function releaseTaskCounts(tasks) {
  const groups = { done:[], cancelled:[], ended:[], pending:[], open:[] };
  let pendingUnfetched = false;
  for (const task of tasks) {
    if (githubTaskDone(task)) {
      const key = task.item.notPlanned === true ? 'cancelled'
        : task.item.state === 'closed' && task.item.notPlanned === undefined ? 'ended' : 'done';
      groups[key].push(task);
    } else if (task.item.acceptancePending === true) {
      groups.pending.push(task);
    } else {
      groups.open.push(task);
      pendingUnfetched ||= task.item.acceptancePending === undefined;
    }
  }
  return { ...groups, pendingUnfetched, allPending:groups.pending.length > 0 && groups.open.length === 0 };
}

export function goalTaskCounts(group, tasksByKey) {
  const leaves = entry => entry.task ? [entry.task.key] : entry.children.flatMap(leaves);
  const keys = leaves(group);
  if (!keys.every(key => tasksByKey.has(key))) return null;
  return releaseTaskCounts(keys.map(key => tasksByKey.get(key)));
}
