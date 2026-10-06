// ④ リリース：Milestoneごとに、計画のはみ出しだけを示す。完了予定日と、間に合うかの判定は出さない。
import { githubPlan, githubProgress } from './github-planning.mjs';
import { githubWorkCategory, githubIterationLastDay, taskIteration } from './github-work.mjs';
import { itemButton } from './github-planning-view.mjs';
import { todayInTokyo } from './engine.mjs';

const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortDate = date => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const pt = value => Number(value.toPrecision(12)) + 'pt';
// Estimateは、一つのProjectに登録した正の値だけを使う。
const points = task => { const value = task.projects.length === 1 ? task.projects[0].estimatePoints : null; return value > 0 ? value : null; };

// Estimateで重み付けした、最長の前提の流れ。見積のない作業は足さず、件数を数える。
function longestChain(open, pool) {
  const byUrl = new Map(pool.map(t => [t.item.url.toLowerCase(), t]));
  const memo = new Map();
  const best = (task, seen) => {
    if (memo.has(task)) return memo.get(task);
    if (seen.has(task)) return { weight: 0, chain: [] };
    seen.add(task);
    let top = { weight: 0, chain: [] };
    for (const blocker of task.blockedBy || []) {
      const dep = byUrl.get(blocker.url.toLowerCase());
      if (!dep) continue;
      const found = best(dep, seen);
      if (found.weight > top.weight || (found.weight === top.weight && found.chain.length > top.chain.length)) top = found;
    }
    seen.delete(task);
    const result = { weight: top.weight + (points(task) ?? 0), chain: [...top.chain, task] };
    memo.set(task, result);
    return result;
  };
  let winner = null;
  for (const task of open) {
    const found = best(task, new Set());
    if (!winner || found.weight > winner.weight || (found.weight === winner.weight && found.chain.length > winner.chain.length)) winner = found;
  }
  return winner && winner.chain.length >= 2 ? { tasks: winner.chain, points: winner.weight, missing: winner.chain.filter(t => points(t) === null).length } : null;
}

// 期日のある、開いているMilestoneごとの要約。計画情報がなければ null。
export function releaseSummaries(snapshot, today = todayInTokyo()) {
  const plan = githubPlan(snapshot);
  if (!plan) return null;
  return plan.releases.filter(release => release.state === 'open' && release.dueOn).map(release => {
    const due = release.dueOn.slice(0, 10);
    const categories = new Map(release.tasks.map(task => [task, githubWorkCategory(plan, task, snapshot.repositoryUrl, today)]));
    const groups = new Map([...categories].map(([task, category]) => [task, category.group]));
    const open = release.tasks.filter(task => groups.get(task) !== 'done');
    const pool = plan.tasks.filter(task => githubWorkCategory(plan, task, snapshot.repositoryUrl, today).group !== 'done');
    const iterations = new Set(plan.periods.map(period => period.iteration).filter(i => githubIterationLastDay(i) >= today && githubIterationLastDay(i) <= due).map(i => i.id));
    const progress = githubProgress(release.tasks);
    const attention = open.filter(task => groups.get(task) === 'action');
    return {
      number: release.number, title: release.title, due, late: due < today, iterations: iterations.size,
      remainingPoints: progress.remainingPoints,
      overflow: open.map(task => {
        const iteration = taskIteration(task), labels = [];
        if (!iteration) labels.push('未割当'); else if (githubIterationLastDay(iteration) > due) labels.push('期日より後');
        if (points(task) === null) labels.push('見積なし');
        return { task, labels };
      }).filter(row => row.labels.length),
      attention: attention.length, overdue: attention.filter(task => categories.get(task).reasons.some(reason => reason.includes('期限超過'))).length,
      path: longestChain(open, pool),
    };
  });
}

const rows = {
  overflow: ({ task, labels }) => `<li class="my-work-row attention-row"><div class="my-work-main">${itemButton(task)}<span class="attention-label">${esc(labels.join('・'))}</span></div></li>`,
  attention: summary => `<li class="my-work-row"><button type="button" class="text-button" data-view-go="attention">要対応 ${summary.attention}件${summary.overdue ? `（期限切れ ${summary.overdue}件）` : ''} →</button></li>`,
  path: path => `<li class="my-work-row"><div class="my-work-main"><span class="attention-label">最長の流れ</span>${path.tasks.map(t => `<button class="issue-name" data-action="github-item" data-id="issue:${t.number}" title="${esc(t.item.title)}">#${t.number}</button>`).join(' → ')} · ${pt(path.points)}${path.missing ? `（見積なし${path.missing}件を除く）` : ''}</div></li>`,
};
function card(summary) {
  const when = summary.late ? '期日超過' : `あと${summary.iterations}期間`;
  const remaining = summary.remainingPoints > 0 ? ` · 残り${pt(summary.remainingPoints)}` : '';
  const list = [...summary.overflow.map(rows.overflow), ...(summary.attention ? [rows.attention(summary)] : []), ...(summary.path ? [rows.path(summary.path)] : [])];
  return `<section class="my-work-section release-card"><h3>${esc(summary.title)} <span class="release-due">期日 ${shortDate(summary.due)} · ${when}${remaining}</span></h3>${list.length ? `<ul class="my-work-list">${list.join('')}</ul>` : '<p class="empty-message">はみ出しなし</p>'}</section>`;
}
export function releasePanelMarkup(summaries) {
  if (!summaries) return '<p class="empty-message">GitHubの計画情報は未取得です。</p>';
  return summaries.length ? summaries.map(card).join('') : '<p class="empty-message">期日のあるリリース（Milestone）がありません。</p>';
}
