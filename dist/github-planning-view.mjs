import { githubPlan, githubProgress, githubModules } from './github-planning.mjs';
import { githubMyWork, taskIteration, githubIterationLastDay } from './github-work.mjs';
import { todayInTokyo } from './engine.mjs';
const shortDate = date => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const link = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
const itemButton = i => `<button class="issue-name" data-action="github-item" data-id="issue:${i.number}">#${i.number} ${esc(i.item.title)}</button>`;
export const moduleName = module => module?.kind === 'assigned' ? module.name : ({ unassigned: 'モジュール未分類', unfetched: 'モジュール情報未取得' })[module?.kind] ?? 'モジュール情報未取得';
const points = value => Number(value.toPrecision(12)) + 'pt';
export function githubProgressMarkup(tasks, title, projectId = null) {
  const p = githubProgress(tasks, projectId);
  const excluded = p.missingEstimates ? '<small>見積未設定 ' + p.missingEstimates + '件を除外</small>' : '';
  const remaining = p.remainingPoints !== null && p.estimatedTasks ? '<span class="github-progress-remaining"><small>残り</small><strong>' + points(p.remainingPoints) + '</strong></span>' : '';
  if (p.percent === null) {
    const reason = !p.total ? '作業未登録' : p.ambiguousEstimates ? '見積の出典確認 ' + p.ambiguousEstimates + '件' : !p.estimatedTasks ? '見積のある作業なし' : '見積の集計要確認';
    return '<span class="github-progress unknown"><span class="github-progress-value"><strong>' + reason + '</strong><small>' + p.closed + ' / ' + p.total + '件がClosed</small>' + excluded + '</span>' + remaining + '</span>';
  }
  return '<span class="github-progress"><span class="github-progress-value"><strong>' + p.percent + '%</strong><small>終了 ' + points(p.closedPoints) + ' / ' + points(p.totalPoints) + '</small>' + excluded + '</span><span class="github-progress-track" role="progressbar" aria-label="' + esc(title) + 'のGitHub終了率' + (p.missingEstimates ? '（見積設定済みの作業）' : '') + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + p.percent + '"><span style="width:' + p.percent + '%"></span></span>' + remaining + '</span>';
}
export const iterationEnd = i => new Date(Date.parse(i.startDate + 'T00:00:00Z') + (i.duration - 1) * 86400000).toISOString().slice(0, 10);
const projectMeta = p => `${esc(p.owner ?? '担当未設定')} · ${esc(p.status ?? 'Status未設定')} · ${p.estimatePoints === null ? 'Estimate未設定' : p.estimatePoints + 'pt'} · ${p.iteration ? esc(p.iteration.title) : '期間未設定'}`;
export function githubTaskRows(tasks, context = true, projectId = null) {
  return `<ul class="my-work-list">${tasks.map(t => `<li class="my-work-row" data-github-task="${t.number}"><div class="my-work-main">${itemButton(t)}${context ? `<p class="footnote">${esc(moduleName(t.module))} · ${t.goal ? esc(t.goal.item.title) : t.parent ? '親Issueは別repository' : '目標なし・単独Issue'}</p>` : ''}<div class="github-project-meta">${(projectId ? t.projects.filter(p => p.id === projectId) : t.projects).length ? (projectId ? t.projects.filter(p => p.id === projectId) : t.projects).map(p => `<p>${t.projects.length > 1 ? esc(p.title) + '：' : ''}${projectMeta(p)}</p>`).join('') : '<p>Project未登録</p>'}</div></div><span class="github-state">${t.item.state === 'closed' ? 'Closed' : 'Open'}</span></li>`).join('')}</ul>`;
}
// ③ 要対応：githubMyWork の「要対応」を、期間が終わった日つきで取り出す。計画情報がなければ null。
export function githubAttentionItems(snapshot, today = todayInTokyo()) {
  const work = githubMyWork(snapshot, { all: true }, today);
  if (!work) return null;
  return (work.sections.find(section => section.id === 'action')?.tasks ?? []).map(({ task: t, reasons }) => {
    const endedOn = t.projects.map(p => p.iteration).filter(i => i && githubIterationLastDay(i) < today).map(githubIterationLastDay).sort()[0] || null;
    const owners = t.projects.length ? t.projects.map(p => `${t.projects.length > 1 ? esc(p.title) + '：' : ''}${esc(p.owner ?? '担当未設定')}`).join(' / ') : 'Project未登録';
    const iteration = taskIteration(t), end = iteration && githubIterationLastDay(iteration);
    const deadline = iteration ? `${esc(iteration.title)} · ${shortDate(end)}まで` : '期間未設定';
    return { endedOn, reasons, nameHtml: itemButton(t),
      metaHtml: `<span class="my-work-owner ${t.projects.some(p => p.owner) ? '' : 'missing'}">${owners}</span><span class="task-deadline ${endedOn ? 'overdue' : iteration ? '' : 'unknown'}">${deadline}</span>` };
  });
}
export function githubOwners(snapshot) {
  return [...new Set((githubPlan(snapshot)?.tasks || []).flatMap(t => t.projects.length ? t.projects.map(p => p.owner) : [null]))];
}
export function renderGithubWork(snapshot, filter = { all: true }, today = undefined) {
  const work = githubMyWork(snapshot, filter, today);
  if (!work) return '<p class="empty-message">親子Issue・Projectの計画情報は未取得です。</p>';
  const owners = githubOwners(snapshot), choices = [[{ all: true }, '全員'], ...owners.filter(v => v !== null).sort().map(owner => [{ owner }, owner]), ...(owners.includes(null) ? [[{ owner: null }, '担当未設定']] : [])];
  const count = work.sections.filter(s => s.id !== 'done').reduce((n, s) => n + s.tasks.length, 0);
  // 今の期間はProjectごとに決まる。Projectが複数あるときはProject名を添える。
  const period = work.currents.length ? '今の期間：' + work.currents.map(c => `${work.currents.length > 1 ? esc(c.project.title) + ' ' : ''}${esc(c.iteration.title)}（${shortDate(c.iteration.startDate)}–${shortDate(c.lastDay)}）`).join('、') : '今の期間：なし（Iterationが未設定）';
  const collapsed = new Set(['ready-later', 'waiting', 'done']);
  const row = ({ task: t, reasons }, section) => {
    const shown = section === 'waiting' ? reasons.slice(0, 1) : reasons;
    const reasonList = shown.length ? `<ul class="my-work-reasons">${shown.map(r => `<li>${esc(r)}</li>`).join('')}${reasons.length > shown.length ? `<li class="my-work-more">ほか${reasons.length - shown.length}件</li>` : ''}</ul>` : '';
    // 一覧は作業名と理由、担当・期限だけにする。モジュール・目標・Estimateは詳細で見る。
    const owners = t.projects.length ? t.projects.map(p => `${t.projects.length > 1 ? esc(p.title) + '：' : ''}${esc(p.owner ?? '担当未設定')}`).join(' / ') : 'Project未登録';
    const iteration = taskIteration(t), end = iteration && githubIterationLastDay(iteration);
    const overdue = end && t.item.state !== 'closed' && end < (today ?? todayInTokyo());
    const deadline = iteration ? `${esc(iteration.title)} · ${shortDate(end)}まで` : '期間未設定';
    const status = section === 'action' ? `<span class="badge unknown">${esc([...new Set(t.projects.map(p => p.status ?? 'Status未設定'))].join(' / ') || 'Project未登録')}</span>` : '';
    return `<li class="my-work-row" data-github-task="${t.number}"><div class="my-work-main">${itemButton(t)}${reasonList}</div><div class="my-work-meta"><span class="my-work-owner ${t.projects.some(p => p.owner) ? '' : 'missing'}">${owners}</span>${status}<span class="task-deadline ${overdue ? 'overdue' : iteration ? '' : 'unknown'}">${deadline}</span></div></li>`;
  };
  const sections = work.sections.map(section => {
    const list = `<ul class="my-work-list">${section.tasks.map(item => row(item, section.id)).join('')}</ul>`;
    const heading = `${esc(section.title)} <span class="my-work-count">${section.tasks.length}件</span>`;
    return collapsed.has(section.id)
      ? `<details class="my-work-section" data-github-disclosure="work:${section.id}" data-my-work-section="${section.id}"><summary><h3>${heading}</h3></summary>${list}</details>`
      : `<section class="my-work-section ${section.id === 'action' ? 'needs-action' : ''}" data-my-work-section="${section.id}"><h3>${heading}</h3>${list}</section>`;
  }).join('');
  return `<div class="owner-filter" role="group" aria-label="GitHubの担当者で絞り込む">${choices.map(([value, label]) => `<button class="owner-choice" data-action="github-owner" data-github-owner-filter="${value.all ? 'all' : value.owner === null ? 'none' : 'owner'}"${typeof value.owner === 'string' ? ` data-owner-name="${esc(value.owner)}"` : ''} aria-pressed="${value.all ? !!filter.all : !filter.all && value.owner === filter.owner}">${esc(label)}</button>`).join('')}</div><p class="footnote my-work-period">${period} · 未完了 ${count}件 · 末端Issueのみ。Closed・Doneの受入完了は未確認。${work.dependenciesFetched ? '' : '前提とPRは未取得のため、再取得すると前提待ち・確認待ちを判定します。'}</p>${sections || '<p class="empty-message">この担当者の作業はありません。</p>'}`;
}
export function githubGoalTree(snapshot, selectedNumber = null, taskNumbers = null) {
  const plan = githubPlan(snapshot);
  if (!plan) return '<p>親子関係は未取得です。</p>';
  const branch = i => {
    const children = plan.issues.filter(child => child.parent?.url.toLowerCase() === i.item.url.toLowerCase());
    const childRows = children.map(branch).filter(Boolean);
    if (taskNumbers && (i.childCount === 0 ? !taskNumbers.has(i.number) : !childRows.length)) return '';
    return `<li>${itemButton(i)} <small>${i.item.state === 'closed' ? 'Closed' : 'Open'}</small>${i.childCount > children.length ? `<p class="footnote">このrepository外または参照できない子Issue ${i.childCount - children.length}件</p>` : ''}${childRows.length ? `<ul class="tree">${childRows.join('')}</ul>` : ''}</li>`;
  };
  const roots = selectedNumber === null ? plan.issues.filter(i => !i.parent || !plan.issues.some(p => p.item.url.toLowerCase() === i.parent.url.toLowerCase())) : plan.issues.filter(i => i.number === selectedNumber);
  return `<ul class="tree">${roots.map(branch).join('')}</ul>`;
}
export function renderGithubPeriods(snapshot) {
  const plan = githubPlan(snapshot);
  if (!plan) return '';
  const grouped = (tasks, projectId = null) => {
    const groups = new Map();
    for (const t of tasks) { const key = t.goal?.number ?? null; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(t); }
    return [...groups.values()].map(group => '<section class="github-period-goal"><h4>' + esc(group[0].goal?.item.title ?? '目標なし・親が別repository') + '</h4>' + githubTaskRows(group, false, projectId) + '</section>').join('');
  };
  const goals = tasks => '<section class="github-plan-section"><h4>目標</h4>' + tasks.map(g => '<details class="github-period" data-github-disclosure="goal:' + g.number + ':' + esc(g.moduleKey ?? 'all') + '"><summary><span class="github-scope-name">#' + g.number + ' ' + esc(g.item.title) + '</span>' + githubProgressMarkup(g.tasks, g.item.title) + '</summary>' + githubGoalTree(snapshot, g.number, new Set(g.tasks.map(t => t.number))) + '</details>').join('') + '</section>';
  const releases = items => '<section class="github-plan-section"><h4>リリース（Milestone）</h4>' + items.map(m => '<details class="github-period" data-github-disclosure="release:' + m.number + ':' + esc(m.moduleKey ?? 'all') + '"><summary><span class="github-scope-name">' + esc(m.title) + '<small>期日 ' + (m.dueOn ? m.dueOn.slice(0, 10) : '未設定') + '</small></span>' + githubProgressMarkup(m.tasks, m.title) + '</summary><p class="footnote">' + link(m.url, 'GitHubのMilestone') + ' · ' + (m.state === 'closed' ? 'Closed' : 'Open') + '</p>' + (m.description ? '<p class="github-description">' + esc(m.description) + '</p>' : '') + githubTaskRows(m.tasks) + '</details>').join('') + '</section>';
  const modules = githubModules(plan);
  const moduleHtml = modules.map(module => {
    const name = moduleName(module);
    return '<details class="github-module" data-github-module="' + esc(module.key) + '" data-github-disclosure="module:' + esc(module.key) + '"><summary><span class="github-scope-name">' + esc(name) + '<small>作業 ' + module.tasks.length + '件</small></span>' + githubProgressMarkup(module.tasks, name) + '</summary><div class="github-module-body"><p class="footnote">このモジュールに属する、取得したrepository内の作業だけを集計</p>' + goals(module.goals.map(g => ({ ...g, moduleKey: module.key }))) + releases(module.releases.map(m => ({ ...m, moduleKey: module.key }))) + (module.tasks.some(t => !t.goal) ? '<section class="github-plan-section"><h4>目標に属さない作業</h4>' + githubTaskRows(module.tasks.filter(t => !t.goal)) + '</section>' : '') + '</div></details>';
  }).join('');
  const periodHtml = plan.periods.map(p => '<details class="github-period" data-github-disclosure="period:' + esc(p.key) + '"><summary><span class="github-scope-name">' + esc(p.iteration.title) + '<small>' + p.iteration.startDate + '–' + iterationEnd(p.iteration) + '</small></span>' + githubProgressMarkup(p.tasks, p.iteration.title, p.project.id) + '</summary><p class="footnote">' + link(p.project.url, p.project.title) + ' · 集計はこのProjectの期間内</p>' + grouped(p.tasks, p.project.id) + '</details>').join('');
  return '<section class="github-plan-section"><h3>モジュール別の進み具合</h3><p class="footnote">GitHubの終了率はClosedの末端IssueのEstimateで集計。複数モジュールの共有作業を含むため、モジュール間の件数は合算しません。</p>' + (moduleHtml || '<p class="empty-message">作業Issueはありません。</p>') + '</section><details class="github-period-browse" data-github-disclosure="periods"><summary>イテレーションから確認</summary>' + periodHtml + (plan.unassigned.length ? '<details class="github-period" data-github-disclosure="unassigned"><summary><span class="github-scope-name">期間未設定 ' + plan.unassigned.length + '件</span></summary>' + grouped(plan.unassigned) + '</details>' : '') + '</details>';
}
export function githubItemPlanning(snapshot, number) {
  const plan = githubPlan(snapshot), i = plan?.issues.find(i => i.number === number);
  if (!i) return '<p class="empty-message">親子Issue・Project・Milestoneは未取得です。</p>';
  const task = plan.tasks.find(t => t.number === number);
  const milestone = plan.releases.find(m => m.number === i.milestoneNumber);
  return `<section class="detail-section"><h3>${i.childCount ? '集約用Issue' : '作業Issue'}</h3>${task ? `<p>モジュール：${esc(moduleName(task.module))}${task.module.source && task.module.source !== number ? ' · 親Issue #' + task.module.source + 'から継承' : ''}</p>` : ''}<p>${task?.goal ? '目標：' + esc(task.goal.item.title) : ''}</p><p>親Issue：${i.parent ? link(i.parent.url, '#' + i.parent.number) : 'なし'}</p><p>リリース：${milestone ? link(milestone.url, milestone.title) : 'Milestone未設定'}</p>${i.childCount ? githubGoalTree(snapshot, number) : ''}</section>${i.projects.map(p => `<section class="detail-section"><h3>${link(p.url, p.title)}</h3><dl class="snapshot-facts"><dt>担当</dt><dd>${esc(p.owner ?? '未設定')}</dd><dt>Status</dt><dd>${esc(p.status ?? '未設定')}</dd><dt>Estimate</dt><dd>${p.estimatePoints === null ? '未設定' : p.estimatePoints + 'pt'}</dd><dt>Iteration</dt><dd>${p.iteration ? esc(p.iteration.title) + ' · ' + p.iteration.startDate + '–' + iterationEnd(p.iteration) : '未設定'}</dd></dl></section>`).join('') || '<p class="footnote">Project未登録</p>'}`;
}
