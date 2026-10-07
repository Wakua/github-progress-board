// GitHubで計画しているプロジェクトの「自分の作業」。手動の作業と同じ順（要対応 → 確認待ち → 作業中 → 前提待ち → 着手可能）で分類する。
import { githubPlan, isUrgent } from './github-planning.mjs';
import { todayInTokyo } from './engine.mjs';
import { capacityLimit, sumEstimates, assessLoad } from './capacity.mjs';

const DAY = 86400000;
const lastDay = iteration => new Date(Date.parse(iteration.startDate + 'T00:00:00Z') + (iteration.duration - 1) * DAY).toISOString().slice(0, 10);
const shortDate = date => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
export const SECTIONS = [['urgent', '緊急'], ['active', '作業中'], ['action', '要対応'], ['review', '確認待ち'], ['ready-now', '着手可能（今の期間）'],
  ['ready-later', '着手可能（先の期間・未割当・期間不明）'], ['waiting', '前提待ち'], ['done', '完了・Closed']];

// 今の期間：Projectごとに、進行中のIteration、なければ次に始まるIteration。Projectが違えば期間も別に数える。
export function githubCurrentIterations(plan, today = todayInTokyo()) {
  const byProject = new Map();
  for (const period of plan.periods) {
    if (!byProject.has(period.project.id)) byProject.set(period.project.id, { project: period.project, iterations: [] });
    byProject.get(period.project.id).iterations.push(period.iteration);
  }
  return [...byProject.values()].map(({ project, iterations }) => {
    const iteration = iterations.find(i => i.startDate <= today && today <= lastDay(i)) ||
      iterations.filter(i => i.startDate > today).sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
    return iteration ? { project, iteration, lastDay: lastDay(iteration) } : null;
  }).filter(Boolean);
}
// 一覧の並びと期限の表示には、最も早く終わるIterationを使う。
export const taskIteration = task => task.projects.map(p => p.iteration).filter(Boolean).sort((a, b) => lastDay(a).localeCompare(lastDay(b)))[0] || null;
// 期限超過は、どれか1つのProjectのIterationが終わっていれば当たる。
const endedIteration = (issue, today) => issue.projects.map(p => p.iteration).filter(i => i && lastDay(i) < today).sort((a, b) => lastDay(a).localeCompare(lastDay(b)))[0] || null;
export const taskOwners = task => [...new Set(task.projects.map(p => p.owner))];
// 前提の参照名。別のrepositoryの前提は「owner/repo#番号」とする。
export const blockerRef = (blocker, repositoryUrl) => {
  const local = blocker.url.toLowerCase().startsWith(repositoryUrl.toLowerCase() + '/issues/');
  return `${local ? '' : blocker.url.slice(19).replace(/\/issues\/\d+$/, '')}#${blocker.number}`;
};
const blockerName = (blocker, repositoryUrl) => `${blockerRef(blocker, repositoryUrl)} ${blocker.title}`;

export function githubWorkCategory(plan, task, repositoryUrl, today = todayInTokyo()) {
  if (task.item.state === 'closed') return { group: 'done', reasons: [] };
  const statuses = [...new Set(task.projects.map(p => p.status))];
  const status = statuses.length === 1 ? statuses[0] : null;
  if (status === 'Done') return { group: 'done', reasons: [] };
  const blockedBy = task.blockedBy || [], pullRequests = task.pullRequests || [];
  const open = blockedBy.filter(b => b.state === 'open');
  const byUrl = new Map(plan.issues.filter(i => i.item).map(i => [i.item.url.toLowerCase(), i]));
  const reasons = [];
  if (!task.projects.length) reasons.push('状態が未確認：Projectに未登録');
  else if (statuses.length > 1) reasons.push('状態が未確認：ProjectごとにStatusが異なる');
  else if (!status) reasons.push('状態が未確認：Status未設定');
  else if (!['Todo', 'In Progress'].includes(status)) reasons.push(`状態が未確認：Status「${status}」`);
  if (task.spec) reasons.push(`仕様待ち：${task.item.title}`);
  const ended = endedIteration(task, today);
  if (ended) reasons.push(`期限超過：${ended.title}（${shortDate(lastDay(ended))}終了）`);
  for (const blocker of open) {
    const issue = byUrl.get(blocker.url.toLowerCase()), blockerEnded = issue && endedIteration(issue, today);
    if (blockerEnded) reasons.push(`前提の期限超過：#${blocker.number}（${blockerEnded.title}）`);
  }
  if (status === 'In Progress' && !taskOwners(task).some(Boolean)) reasons.push('作業中なのに担当者がいない');
  if (status === 'In Progress' && open.length) reasons.push(`作業中なのに前提が未完了：${open.map(b => '#' + b.number).join('、')}`);
  if (reasons.length) return { group: 'action', reasons };
  const ready = pullRequests.filter(pr => !pr.draft);
  if (ready.length) return { group: 'review', reasons: ready.map(pr => `承認待ちのPR #${pr.number}`) };
  if (status === 'In Progress') return { group: 'active', reasons: pullRequests.map(pr => `Draft PR #${pr.number}`) };
  if (open.length) return { group: 'waiting', reasons: open.map(b => `${b.spec ? '仕様待ち' : '前提'}：${blockerName(b, repositoryUrl)}`) };
  return { group: 'ready', reasons: [] };
}

// filter は { all: true } か { owner: 担当者名 | null（担当未設定） }。
// urgentFirst：緊急の未完了の作業を、ほかのまとまりへ重ねず先頭の「緊急」に集める。各項目の group は、本来のまとまり。
export function githubMyWork(snapshot, filter = { all: true }, today = todayInTokyo(), { urgentFirst = false } = {}) {
  const plan = githubPlan(snapshot);
  if (!plan) return null;
  const currents = githubCurrentIterations(plan, today);
  const isCurrent = task => task.projects.some(p => p.iteration && currents.some(c => c.project.id === p.id && c.iteration.id === p.iteration.id));
  const sections = SECTIONS.map(([id, title]) => ({ id, title, tasks: [] }));
  const byId = new Map(sections.map(section => [section.id, section]));
  const order = task => [taskIteration(task)?.startDate || '9999-99-99', task.number];
  const tasks = plan.tasks
    .filter(t => filter.all || (t.projects.length ? t.projects.some(p => p.owner === filter.owner) : filter.owner === null))
    .sort((a, b) => { const [x, y] = [order(a), order(b)]; return x[0].localeCompare(y[0]) || x[1] - y[1]; });
  for (const task of tasks) {
    const category = githubWorkCategory(plan, task, snapshot.repositoryUrl, today);
    const id = urgentFirst && category.group !== 'done' && isUrgent(task) ? 'urgent'
      : category.group !== 'ready' ? category.group : isCurrent(task) ? 'ready-now' : 'ready-later';
    byId.get(id).tasks.push({ task, reasons: category.reasons, group: category.group });
  }
  return { currents, dependenciesFetched: plan.issues.every(i => Object.hasOwn(i, 'spec')),
    sections: sections.filter(section => section.tasks.length) };
}
// 期間（GitHubのProject × Iteration）の担当別の負荷。そのProjectの担当・Estimate・Statusだけを使い、ClosedとDoneは除く。
// 担当者は名前順に並べ、担当のない作業（未担当）は末尾に置く。未担当には上限を当てない。
export function githubPeriodWorkload(period, today = todayInTokyo()) {
  const limit = capacityLimit({ startDate: period.iteration.startDate, durationDays: period.iteration.duration }, today);
  const groups = new Map();
  for (const task of period.tasks) {
    const entry = task.projects.find(p => p.id === period.project.id);
    if (!entry) continue;
    const owner = entry.owner ?? null;
    if (!groups.has(owner)) groups.set(owner, []);
    if (task.item.state !== 'closed' && entry.status !== 'Done') groups.get(owner).push(entry.estimatePoints > 0 ? entry.estimatePoints : null);
  }
  return [...groups].sort(([a], [b]) => a === null ? 1 : b === null ? -1 : a.localeCompare(b, 'ja')).map(([owner, values]) => {
    const sum = sumEstimates(values);
    return { owner, count: values.length, ...sum, load: owner === null ? null : assessLoad(sum, limit) };
  });
}
export { lastDay as githubIterationLastDay };
