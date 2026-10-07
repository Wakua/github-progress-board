import { githubPlan } from './github-planning.mjs';
import { renderGithubWork, githubOwners, renderGithubPeriods, githubItemPlanning, githubGoalTree, githubAttentionItems, githubMineItems, githubUrgentSummary } from './github-planning-view.mjs';
import { releaseSummaries, releasePanelMarkup } from './release.mjs';
import { attentionPanelMarkup, attentionCount, manualEndedOn, MINE_GROUPS } from './attention.mjs';
import { findTask, findGoal, findParentIssue, issueChildren, issuePath, issueProgress, iterationTiming, taskTiming, periodGoalDeadline, currentIterations, iterationWork, groupTasksByGoal, iterationWorkload, workloadForTasks, taskOwner, setOwner, overdueTasks, setIteration, blockers, blockingTasks, statusLabel, orderedTasks, goalProgress, criteriaProgress, nextWork, descendants, directSuccessors, transition, setCriterion, setWait, setEstimate, reorder, resolveDecision, myWork, todayInTokyo } from './engine.mjs';
import { STORAGE_KEY, createWorkspaceStore, registerProject, selectProject, updateProject, findProject, addGoal, addTask, setTaskCriteria, projectSummary, importSnapshots, addDecision, setApprovalLimit } from './workspace.mjs';
import { MAX_IMPORT_BYTES, parseSnapshotImport, repositoryKey, snapshotAge, githubStateLabel, approvalQueue, approvalState, projectApprovalLimit, approvalLimitMessage, APPROVAL_LIMIT, APPROVAL_LIMIT_MAX } from './github-snapshot.mjs';
import { createLocalGithubClient, applyRefreshedSnapshot, localRepositoryKey, isLocalRuntime, REFRESH_INTERVAL_MS } from './local-github.mjs';
import { createCloudWorkspaceStore, MAX_CLOUD_BYTES } from './cloud-workspace.mjs';
import { planPreparedEstimates, applyPreparedEstimates, isProvisionalEstimate } from './estimate-proposals.mjs';
import { registerProgressTools } from './progress-tools.mjs';
import { workloadChipClass, workloadChipTitle, workloadChipLabel, workloadFigures, workloadLimitMarkup } from './workload-view.mjs';
let storage;
try { storage = window.localStorage; } catch { storage = { getItem() { throw new Error('ブラウザの保存領域を利用できません。'); } }; }
const cloudMode = document.documentElement.dataset.storageMode === 'cloud';
const store = cloudMode ? createCloudWorkspaceStore(window.fetch.bind(window), { storage }) : createWorkspaceStore(storage);
let workspace, state, viewProjectId;
let busy = false;
const exclusive = action => navigator.locks ? navigator.locks.request(STORAGE_KEY, action) : Promise.resolve().then(action);
const editingActions = new Set(['prepared-estimates', 'prepared-workspace', 'migrate-workspace', 'import-snapshot', 'add-project', 'add-goal', 'add-task', 'assign-owner', 'assign-iteration', 'estimate', 'evidence', 'resolve', 'wait', 'clear-wait', 'up', 'down', 'start', 'review', 'complete', 'pause', 'reopen', 'dependencies', 'criteria', 'add-decision', 'save-approval-limit']);
const expandedIterations = new Map();
const collapsedPeriodGoals = new Set();
let panel = null;
let snapshotCandidates = null;
let migrationData = null;
let estimateData = null;
let migrationBackupWritten = false;
let migrationLoadSequence = 0;
let snapshotLoadSequence = 0;
let workloadPanel = null;
let managementPanel = null;
const panelDrafts = new Map();
let panelInputValues = new Map();
let toastTimer;
// 表示の好み（開いているタブ、担当者の絞り込み）は作業データと分け、失敗しても画面を止めない。
const VIEW_KEY = 'progress-tool.view.v1';
function readView() {
  try { const value = JSON.parse(storage.getItem(VIEW_KEY)); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
function writeView(change) {
  try { storage.setItem(VIEW_KEY, JSON.stringify({ ...readView(), ...change })); } catch { /* 保存できなくても表示は切り替える */ }
}
const attentionMe = new Map(Object.entries(readView().attentionMe || {}).filter(([, value]) => typeof value === 'string'));
let viewTab = ['iterations', 'attention', 'release'].includes(readView().tab) ? readView().tab : 'my-work';
// 担当者の絞り込みは { all: true } か { owner: 担当者名 | null（未担当） }。担当者名と「全員」が衝突しないように種類で分ける。
const validOwnerFilter = value => value && typeof value === 'object' && (value.all === true || typeof value.owner === 'string' || value.owner === null);
const githubDisclosures = new Map();
const githubOwnerFilters = new Map(Object.entries(readView().githubOwners || {}).filter(([, value]) => validOwnerFilter(value)));
const ownerFilters = new Map(Object.entries(readView().owners || {}).filter(([, value]) => validOwnerFilter(value)));
const sameOwnerFilter = (a, b) => a.all === true ? b.all === true : b.all !== true && a.owner === b.owner;
const ownerFilterFromButton = button => button.dataset.ownerFilter === 'all' ? { all: true } : { owner: button.dataset.ownerFilter === 'none' ? null : button.dataset.ownerName };
const $ = selector => document.querySelector(selector);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const badge = task => `<span class="badge ${task.status === 'todo' && blockers(state, task).length ? 'blocked' : task.status}">${task.status === 'todo' && blockers(state, task).length ? '着手待ち' : statusLabel(task.status)}</span>`;
const button = (label, action, id = '', primary = false, disabled = false) => `<button type="button" class="button ${primary ? 'primary' : 'secondary'}" data-action="${action}" data-id="${escape(id)}" ${disabled ? 'disabled' : ''}>${escape(label)}</button>`;
const issueReference = issue => issue.issueNumber ? `${findProject(workspace, workspace.selectedProjectId).repositoryUrl?.replace('https://github.com/', '') || 'repository未登録'} #${issue.issueNumber}` : 'Issue未登録';
const parentIssueBadge = issue => `<span class="badge ${issue.issueState === 'closed' ? 'done' : issue.issueState === 'open' ? 'todo' : 'unknown'}">${issue.issueState === 'closed' ? 'Closed' : issue.issueState === 'open' ? 'Open' : 'Issue未確認'}</span>`;
function issueBreadcrumbs(id) {
  const path = issuePath(state, id);
  return `<nav class="issue-breadcrumbs" aria-label="親子Issueの階層">${path.map((issue, index) => {
    const label = `${issueReference(issue)} ${issue.title}`.trim();
    return `${index ? '<span class="breadcrumb-arrow" aria-hidden="true">›</span>' : ''}${index === path.length - 1 ? `<span aria-current="page">${escape(label)}</span>` : `<button class="text-button" data-action="${index === 0 ? 'overview' : 'issue'}" data-id="${escape(issue.id)}">${escape(label)}</button>`}`;
  }).join('')}</nav>`;
}
function formatEstimate(points) {
  if (points == null || !Number.isFinite(points)) return '未入力';
  return `${Number(points.toPrecision(12))}pt`;
}
const shortDate = value => value ? `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}` : '未確認';
function iterationLabel(iteration) {
  const timing = iterationTiming(iteration);
  return `${iteration.title} · ${timing.endDate ? `${shortDate(timing.startDate)}–${shortDate(timing.endDate)}` : '日付未確認'}`;
}
function deadlineText(task, compact = false) {
  const timing = taskTiming(state, task);
  if (timing.phase === 'unassigned') return '期限未設定';
  if (timing.phase === 'unknown') return '期限未確認';
  const prefix = `${timing.iteration.title} · ${shortDate(timing.endDate)}まで`;
  if (task.status === 'done') return `${prefix}（完了）`;
  if (timing.daysLeft < 0) return `${prefix} · ${-timing.daysLeft}日超過`;
  if (timing.daysLeft === 0) return `${timing.iteration.title} · 今日まで`;
  return compact ? prefix : `${prefix} · あと${timing.daysLeft}日`;
}
function taskDeadline(task, compact = false) {
  const timing = taskTiming(state, task);
  const overdue = task.status !== 'done' && timing.daysLeft !== null && timing.daysLeft < 0;
  return `<span class="task-deadline ${overdue ? 'overdue' : timing.phase === 'unknown' || timing.phase === 'unassigned' ? 'unknown' : ''}" title="${escape(deadlineText(task))}">${escape(deadlineText(task, compact))}</span>`;
}
function iterationAssignment(task) {
  return `<section class="detail-section"><h3>イテレーションの割当</h3><div class="iteration-assignment"><label class="field">作業のイテレーション<select id="task-iteration" aria-label="作業のイテレーション"><option value="">未割当</option>${state.iterations.map(i => `<option value="${escape(i.id)}" ${task.iterationId === i.id ? 'selected' : ''}>${escape(iterationLabel(i))}</option>`).join('')}</select></label>${button('割当を更新', 'assign-iteration', task.id)}</div><p class="estimate-caption">割り当てた期間の終了日を、この作業の期限として表示します。変更は${cloudMode ? 'クラウド' : 'このブラウザ'}に保存します。</p></section>`;
}
function ownerAssignment(task) {
  const owners = [...new Set(state.tasks.map(taskOwner).filter(Boolean))];
  return `<section class="detail-section"><h3>担当者</h3><div class="iteration-assignment"><label class="field">担当者名<input id="task-owner" list="owner-options" maxlength="60" value="${escape(taskOwner(task) || '')}" placeholder="未担当"><datalist id="owner-options">${owners.map(owner => `<option value="${escape(owner)}"></option>`).join('')}</datalist></label>${button('担当を更新', 'assign-owner', task.id)}</div><p class="estimate-caption">空欄で更新すると未担当になります。</p></section>`;
}
const hasProvisional = tasks => tasks.some(isProvisionalEstimate);
function estimateTag(task) { return isProvisionalEstimate(task) ? `<small class="estimate-provisional">${task.estimateProvenance.retrospective ? '事後の仮見積' : '仮見積'}</small>` : ''; }
function estimateRationale(task) {
  if (!isProvisionalEstimate(task)) return '';
  const p = task.estimateProvenance;
  return `<details class="panel-note"><summary>${p.retrospective ? '事後の仮見積' : '仮見積'}の根拠・目安 ${p.range[0]}–${p.range[1]}pt</summary><p>${escape(p.rationale)}</p><p>登録範囲からの低確度な計画値です。実績時間ではありません。1日＝1ポイント。登録後に見積値を変更すると、この仮見積の注記は解除されます。</p></details>`;
}
function goalProgressMetric(progress, label = '', compact = false, provisional = false) {
  const note = !progress.total ? '作業未登録' : progress.missingEstimates ? `Estimate未入力 ${progress.missingEstimates}件` : compact ? '' : `完了分 ${formatEstimate(progress.completePoints)}<small>合計 ${formatEstimate(progress.totalPoints)}</small>`;
  return `<div class="goal-progress-metric"><strong>${label ? `<small class="progress-scope">${escape(label)}</small>` : ''}${progress.percent === null ? '—' : `${progress.percent}%${provisional ? '<small>暫定</small>' : ''}`}</strong>${note ? `<span>${note}</span>` : ''}</div>`;
}
function taskProgressSummary(task) {
  const progress = criteriaProgress(task);
  return `<span class="task-progress-summary" data-task-progress="${escape(task.id)}">${progress.percent === null ? '完了条件 未登録' : `完了条件 ${progress.percent}%<small>達成 ${progress.achieved}/${progress.total}件</small>`}</span>`;
}
function criteriaProgressText(task) {
  const progress = criteriaProgress(task);
  return progress.percent === null ? '条件未登録' : `${progress.percent}%達成（${progress.achieved}/${progress.total}件）`;
}
function notify(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
function blockingLabel(row) {
  if (!row.task) return '未確認';
  if (row.causes.some(c => c.kind === 'decision')) return '判断待ち';
  if (row.causes.some(c => c.kind === 'wait')) return '待ちあり';
  if (row.task.status === 'todo' && row.causes.some(c => c.kind === 'dependency')) return '前提待ち';
  return statusLabel(row.task.status);
}
function blockerCardRow(row, goalId, all = false, compact = false) {
  const next = row.direct.find(t => t.goalId === goalId) || row.direct[0];
  const impact = !next ? 'この作業が待っています' : all ? `→ ${row.direct.map(t => escape(t.title)).join('・')}` : `→ ${escape(next.title)}${row.direct.length > 1 ? ` ほか${row.direct.length - 1}件` : ''}`;
  return `<li><button class="blocking-link" data-action="blocker" data-id="${escape(row.id)}" data-goal-id="${escape(goalId)}"><span class="blocking-name"><span>${escape(row.task?.title || `未確認の前提（${row.id}）`)}</span><small>${blockingLabel(row)}</small></span>${compact ? '' : `<span class="blocking-impact">${impact}</span>`}</button></li>`;
}
function listProgress(goal, progress, provisional = false) {
  if (progress.percent === null) return `<div class="list-progress"><strong>—</strong><small>${progress.total ? `Estimate未入力 ${progress.missingEstimates}件` : '作業未登録'}</small></div>`;
  return `<div class="list-progress"><strong>${progress.percent}%${provisional ? '<small>暫定</small>' : ''}</strong><div class="list-progress-track" role="progressbar" aria-label="${escape(goal.title)}の完了率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}" aria-valuetext="${progress.percent}%、Estimate ${formatEstimate(progress.completePoints)} / ${formatEstimate(progress.totalPoints)}"><span style="width:${progress.percent}%" aria-hidden="true"></span></div></div>`;
}
function scopeSummary(tasks) {
  if (!tasks.length) return '作業を登録すると進捗を確認できます。';
  const groups = [...new Set(tasks.map(t => t.group))];
  const complete = groups.filter(group => tasks.filter(t => t.group === group).every(t => t.status === 'done'));
  const remaining = groups.filter(group => !complete.includes(group));
  if (!remaining.length) return 'すべての作業と完了条件を確認しました。';
  return `${complete.length ? `${complete.join('・')}は完了。` : `${tasks.filter(t => t.status === 'done').length}件の作業が完了。`}${remaining.join('・')}が残っています。`;
}
function workloadPoints(bucket) {
  return bucket.points === null ? `<span class="workload-unknown">未入力<small>${bucket.missingEstimates}件</small></span>` : formatEstimate(bucket.points);
}
function renderWorkload(tasks, iterationId, goalId = '') {
  const rows = iterationId ? iterationWorkload(state, iterationId, goalId || undefined) : workloadForTasks(state, tasks);
  if (!rows.length) return '';
  return `<section class="workload-strip" aria-label="担当別の残りポイント"><h3>担当別の残り</h3><div class="workload-chips">${rows.map(row => `<button class="${workloadChipClass(row)}" title="${escape(workloadChipTitle(row))}" data-action="workload" data-id="${escape(iterationId)}" data-goal-id="${escape(goalId)}" data-owner="${escape(row.owner || '')}" data-workload-owner="${escape(row.owner || '')}" aria-label="${escape(workloadChipLabel(row))}"><span class="workload-avatar" aria-hidden="true">${escape((row.owner || '未')[0])}</span><span>${escape(row.owner || '未担当')}</span>${workloadFigures(row)}<span class="workload-chevron" aria-hidden="true">›</span></button>`).join('')}</div></section>`;
}
function taskBlocker(task) {
  const causes = task.status === 'done' ? [] : blockers(state, task);
  if (!causes.length) return '<span class="period-no-blocker">—</span>';
  const first = causes[0];
  const dependency = first.kind === 'dependency' && state.tasks.find(t => t.id === first.id);
  const label = dependency ? dependency.title : first.kind === 'unknown' ? '情報未確認' : first.text;
  return `<button class="period-blocker-link" data-action="reason" data-id="${escape(task.id)}" aria-label="${escape(task.title)}の待ちの理由を確認" title="${escape(causes.map(c => c.text).join(' / '))}"><span aria-hidden="true">↳</span><span class="period-blocker-name">${escape(label)}</span>${causes.length > 1 ? `<small>+${causes.length - 1}</small>` : ''}</button>`;
}
function iterationRows(tasks) {
  if (!tasks.length) return '<p class="period-empty">作業未登録</p>';
  return `<table class="period-tasks"><thead><tr><th scope="col">作業</th><th scope="col" class="period-task-owner">担当</th><th scope="col" class="period-task-state">状態</th><th scope="col" class="period-task-points">Estimate</th><th scope="col" class="period-task-blocker">待ちの理由</th></tr></thead><tbody>${tasks.map(task => {
    const overdue = task.status !== 'done' && taskTiming(state, task).phase === 'past';
    const block = taskBlocker(task);
    return `<tr data-period-task="${escape(task.id)}" class="${task.status === 'done' ? 'period-task-done' : ''}"><td class="period-task-name"><button class="issue-name" data-action="task" data-id="${escape(task.id)}">${escape(task.title)}</button><div class="period-task-criteria">${taskProgressSummary(task)}</div><small class="period-mobile-owner">${escape(taskOwner(task) || '未担当')}</small>${overdue ? '<span class="period-task-overdue">期限超過</span>' : ''}${task.status !== 'done' && blockers(state, task).length ? `<div class="period-mobile-blocker">${block}</div>` : ''}</td><td class="period-task-owner">${escape(taskOwner(task) || '未担当')}</td><td class="period-task-state">${task.status === "todo" && !blockers(state, task).length ? '<span class="badge ready">着手可能</span>' : badge(task)}</td><td class="period-task-points">${formatEstimate(task.estimatePoints)}${estimateTag(task)}</td><td class="period-task-blocker">${block}</td></tr>`;
  }).join('')}</tbody></table>`;
}
function iterationGoalGroups(tasks, scope, iterationId) {
  const groups = groupTasksByGoal(state, tasks);
  if (!groups.length) return '<p class="period-empty">作業未登録</p>';
  return `<section class="period-goals"><div class="period-goals-heading"><h3>目標別の作業</h3><span>集計：${iterationId ? 'この期間内' : '未割当・割当未確認'}</span></div>${groups.map(({ goal, tasks, progress, remainingPoints }) => {
    const key = JSON.stringify([scope, iterationId, goal.id]);
    const deadline = periodGoalDeadline(state, tasks);
    return `<details class="period-goal-group" data-period-goal="${escape(goal.id)}" data-period-goal-key="${escape(key)}" ${collapsedPeriodGoals.has(key) ? '' : 'open'}><summary class="period-goal-summary ${deadline ? 'has-deadline' : ''}" aria-label="${escape(goal.shortTitle || goal.title)}の作業 ${tasks.length}件"><span class="period-goal-name"><span class="period-goal-chevron" aria-hidden="true">›</span><strong title="${escape(goal.title)}">${escape(goal.shortTitle || goal.title)}</strong><small>${tasks.length}件</small><button class="period-goal-overview" data-action="overview" data-id="${escape(goal.id)}" aria-label="${escape(goal.shortTitle || goal.title)}の目標全体を確認">目標全体<span aria-hidden="true">↗</span></button></span><span class="period-goal-progress"><small>登録作業の見積完了率</small>${listProgress({ title: `${goal.shortTitle || goal.title}・${iterationId ? 'この期間内' : '未割当・割当未確認'}` }, progress, hasProvisional(tasks))}</span>${deadline ? `<span class="period-goal-deadline ${deadline.overdue ? 'overdue' : ''}"><small>作業期限</small><strong>${deadline.endDate ? shortDate(deadline.endDate) : '要確認'}${deadline.overdue ? ' · 期限超過' : ''}</strong></span>` : ''}<span class="period-goal-remaining"><small>残り</small><strong>${formatEstimate(remainingPoints)}</strong></span></summary><div class="period-goal-body">${iterationRows(tasks)}</div></details>`;
  }).join('')}</section>`;
}
function iterationPhase(timing, work) {
  if (timing.phase === 'active') return `<span class="period-phase active">進行中</span><small>${timing.daysLeft === 0 ? '今日まで' : `あと${timing.daysLeft}日`}</small>`;
  if (timing.phase === 'past') return `<span class="period-phase past">終了</span><small class="${work.remainingTasks.length ? 'period-overdue' : ''}">${work.remainingTasks.length ? `未完了 ${work.remainingTasks.length}件` : work.tasks.length ? '完了' : '作業未登録'}</small>`;
  if (timing.phase === 'upcoming') return `<span class="period-phase upcoming">予定</span><small>${shortDate(timing.startDate)}開始</small>`;
  return '<span class="period-phase unknown">日付未確認</span>';
}
function renderIterations(scope, goalId = '') {
  if (!expandedIterations.has(scope)) {
    const iterations = goalId ? state.iterations.filter(i => iterationWork(state, i.id, goalId).tasks.length) : state.iterations;
    expandedIterations.set(scope, new Set(currentIterations({ ...state, iterations }).map(i => i.id)));
  }
  const detail = scope !== 'main';
  const expanded = expandedIterations.get(scope);
  const periods = [...state.iterations].sort((a, b) => (iterationTiming(a).startDate || '9999').localeCompare(iterationTiming(b).startDate || '9999'));
  const orphaned = orderedTasks(state, goalId || undefined).filter(t => !state.iterations.some(i => i.id === t.iterationId));
  return `<div class="period-list" data-period-scope="${escape(scope)}"><div class="period-list-head" aria-hidden="true"><span>期間</span><span>完了率</span>${detail ? '<span>完了 / 合計</span>' : ''}<span>残り</span><span>期間の状態</span><span>作業</span></div>${periods.map(iteration => {
    const work = iterationWork(state, iteration.id, goalId || undefined);
    const timing = iterationTiming(iteration);
    return `<details class="period-group ${timing.phase === 'active' ? 'current-period' : ''}" data-period-id="${escape(iteration.id)}" data-period-scope="${escape(scope)}" ${expanded.has(iteration.id) ? 'open' : ''}><summary class="period-summary" aria-label="${escape(iteration.title)}の作業 ${work.tasks.length}件"><span class="period-name"><strong>${escape(iteration.title)}</strong><small>${timing.endDate ? `${shortDate(timing.startDate)}–${shortDate(timing.endDate)}` : '日付未確認'}</small></span><span class="period-progress" data-label="完了率">${listProgress(iteration, work.progress, hasProvisional(work.tasks))}</span>${detail ? `<span class="period-completed-points" data-label="完了 / 合計">${formatEstimate(work.progress.completePoints)} <span class="period-separator">/</span> ${formatEstimate(work.progress.totalPoints)}${work.progress.missingEstimates ? `<small>未入力 ${work.progress.missingEstimates}件</small>` : ''}</span>` : ''}<span class="period-remaining-points" data-label="残り">${formatEstimate(work.remainingPoints)}</span><span class="period-status">${iterationPhase(timing, work)}</span><span class="period-disclosure"><span>${work.tasks.length}件</span><span class="period-chevron" aria-hidden="true">›</span></span></summary><div class="period-body">${renderWorkload(work.tasks, iteration.id, goalId)}${iterationGoalGroups(work.tasks, scope, iteration.id)}</div></details>`;
  }).join('')}${!periods.length ? '<p class="period-empty">イテレーション未登録</p>' : ''}${orphaned.length ? `<section class="period-unassigned"><h3>未割当・割当未確認 <span>${orphaned.length}件</span></h3>${renderWorkload(orphaned, "", goalId)}${iterationGoalGroups(orphaned, scope, "")}</section>` : ''}</div>`;
}
const utcTime = value => value.replace('T', ' ').replace('Z', ' UTC');
const sourceLink = (url, label) => `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>`;
function snapshotAgeMarkup(snapshot) {
  const age = snapshotAge(snapshot);
  return `<span class="snapshot-age ${age.stale ? 'stale' : ''}" data-fetched-at="${escape(snapshot.fetchedAt)}">${escape(age.label)}</span>`;
}
function localGithubMarkup(project) {
  const key = localRepositoryKey(project.repositoryUrl);
  if (!key) return '';
  const status = localGithub.state(key);
  if (!status.available) return '';
  const text = status.phase === 'loading' ? 'GitHubを取得中…' : status.message || (status.phase === 'updated' ? '自動更新済み。' : '登録済みrepositoryを自動更新します。');
  // 1画面目に作業が入るよう、取得の状態と再取得を1行にまとめる。
  return `<p class="footnote local-github-line" role="status">${escape(text)} 起動時と表示中の5分ごとに取得し、このブラウザに保存します。<button type="button" class="text-button" data-action="refresh-local-github" data-id="" ${status.phase === 'loading' || store.status().readOnly ? 'disabled' : ''}>GitHubを再取得</button></p>`;
}
function renderLocalGithubStatus() {
  const elements = document.querySelectorAll('[data-local-github]');
  const project = workspace?.selectedProjectId && workspace.projects.find(project => project.id === workspace.selectedProjectId);
  if (project) for (const element of elements) element.innerHTML = localGithubMarkup(project);
}
function renderGithubSnapshot(project) {
  const snapshot = project.githubSnapshot;
  const local = `<div data-local-github>${localGithubMarkup(project)}</div>`;
  if (!snapshot) return `<h2>GitHub snapshot</h2>${local}<p class="empty-message">未取得。GitHubから取得したJSONを読み込むと、Issue・PRの状態を確認できます。</p>`;
  const rows = items => items.length ? `<ul class="snapshot-items">${items.map(item => `<li><button class="text-button" data-action="github-item" data-id="${item.kind}:${item.number}"><small>${item.kind === 'issue' ? 'Issue' : 'PR'} #${item.number}</small><span>${escape(item.title)}</span></button><span class="github-state">${escape(githubStateLabel(item))}</span></li>`).join('')}</ul>` : '<p class="empty-message">該当なし</p>';
  return `<div class="snapshot-heading"><h2>GitHub snapshot <small>読み取り専用</small></h2>${snapshotAgeMarkup(snapshot)}</div>${local}<p class="footnote">取得：${escape(utcTime(snapshot.fetchedAt))} · 出典：${sourceLink(snapshot.repositoryUrl, snapshot.repositoryUrl.slice(19))}</p><p class="snapshot-note">GitHubが正本です。表示は取得時点のIssue・PR状態で、作業の受入完了は未確認です。${snapshot.planning ? '担当・期間・EstimateはProject、リリースはMilestoneから表示します。' : '親子Issue・Project・Milestoneは未取得です。'}</p>${[['issue', 'Issue'], ['pull_request', 'PR']].map(([kind, label]) => {
    const items = snapshot.items.filter(item => item.kind === kind), open = items.filter(item => item.state === 'open'), closed = items.filter(item => item.state === 'closed');
    return `<section class="snapshot-kind" data-snapshot-kind="${kind}"><h3>${label} <small>Open ${open.length} / Closed ${closed.length}</small></h3>${rows(open)}${closed.length ? `<details class="snapshot-history"><summary>Closedの${label} ${closed.length}件を確認</summary>${rows(closed)}</details>` : ''}</section>`;
  }).join('')}`;
}
function renderGithubPlanning(project) {
  const snapshot = project.githubSnapshot;
  if (!snapshot && !localRepositoryKey(project.repositoryUrl)) return '';
  return `<div class="snapshot-heading"><h2>GitHubの計画 <small>読み取り専用</small></h2>${snapshot ? snapshotAgeMarkup(snapshot) : ''}</div><div data-local-github>${localGithubMarkup(project)}</div><p class="footnote">Closed・Doneの受入完了は未確認です。</p>${snapshot?.planning ? renderGithubPeriods(snapshot) : '<p class="empty-message">親子Issue・Project・Milestoneは未取得です。</p>'}`;
}
function renderSnapshotImport() {
  $('#drawer-project').textContent = '';
  $('#drawer-kicker').textContent = 'GitHubの状態を取り込む';
  $('#drawer-title').textContent = 'GitHub snapshotを読み込む';
  $('#drawer-body').innerHTML = `<p class="snapshot-note">取込先を確認してから保存します。手動の目標・作業・完了条件・証拠を保持し、GitHub snapshotだけを更新します。</p><p>${button('サンプルの3repositoryを確認', 'load-bundled-snapshot')}</p><p class="footnote">同梱の架空のサンプルです。実在のrepositoryの状態ではありません。</p><label class="field">snapshot JSON（5MiB以下）<input id="snapshot-file" type="file" accept="application/json,.json"></label>${snapshotCandidates ? `<form data-form="import-snapshot" class="snapshot-import">${snapshotCandidates.map((snapshot, index) => {
    const matches = workspace.projects.filter(project => project.repositoryUrl && repositoryKey(project.repositoryUrl) === repositoryKey(snapshot.repositoryUrl));
    return `<section class="detail-section"><h3>${escape(snapshot.repositoryUrl.slice(19))}</h3><p class="footnote">取得：${escape(utcTime(snapshot.fetchedAt))} · Issue ${snapshot.items.filter(item => item.kind === 'issue').length}件 / PR ${snapshot.items.filter(item => item.kind === 'pull_request').length}件</p>${snapshotAgeMarkup(snapshot)}<label class="field">取込先：${escape(snapshot.repositoryUrl.slice(19))}<select id="snapshot-target-${index}" name="target-${index}" required>${matches.length > 1 ? '<option value="" selected>取込先を選んでください</option>' : ''}${matches.map(project => `<option value="${escape(project.id)}">${escape(project.name)}（${escape(project.id)}）</option>`).join('')}<option value="new">新しい空のプロジェクトを登録</option></select></label><label class="field">新規登録時のプロジェクト名<input id="snapshot-name-${index}" name="name-${index}" maxlength="100" value="${escape(snapshot.repositoryUrl.split('/').at(-1))}" required></label><p class="footnote">${matches.length ? '同じrepositoryのプロジェクトだけを選べます。' : '同じrepositoryのプロジェクトがないため、新規登録します。'}</p></section>`;
  }).join('')}<button type="submit" class="button primary">取込先を確認して保存</button></form>` : '<p class="footnote">検証済みの単一snapshot、または複数repositoryのbundle JSONに対応します。認証情報は不要です。</p>'}`;
}
function ownerFilter(project) {
  const value = ownerFilters.get(project.id) ?? { all: true };
  const owners = new Set(project.data.tasks.filter(t => t.status !== 'done').map(taskOwner));
  return value.all === true || owners.has(value.owner) ? value : { all: true };
}
function myWorkRow({ task, reasons }, section) {
  const owner = taskOwner(task);
  const reasonList = reasons.length ? `<ul class="my-work-reasons">${(section === 'waiting' ? reasons.slice(0, 1) : reasons).map(reason => `<li>${escape(reason)}</li>`).join('')}${section === 'waiting' && reasons.length > 1 ? `<li class="my-work-more">ほか${reasons.length - 1}件</li>` : ''}</ul>` : '';
  return `<li class="my-work-row" data-my-work-task="${escape(task.id)}"><div class="my-work-main"><button class="issue-name" data-action="task" data-id="${escape(task.id)}">${escape(task.title)}</button>${reasonList}</div><div class="my-work-meta"><span class="my-work-owner ${owner ? '' : 'missing'}">${escape(owner || '未担当')}</span>${section === 'action' ? `<span class="badge ${task.status}">${statusLabel(task.status)}</span>` : ''}${taskDeadline(task, true)}</div></li>`;
}
function renderManualMyWork(project) {
  const filter = ownerFilter(project);
  const owners = [...new Set(orderedTasks(state).filter(t => t.status !== 'done').map(taskOwner))];
  const named = owners.filter(Boolean).sort((a, b) => a.localeCompare(b, 'ja'));
  const choices = [[{ all: true }, '全員'], ...named.map(owner => [{ owner }, owner]), ...(owners.includes(null) ? [[{ owner: null }, '未担当']] : [])];
  const work = myWork(state, filter.all === true ? undefined : filter.owner);
  const timing = work.current && iterationTiming(work.current);
  const period = work.current ? `今の期間：${escape(work.current.title)}（${shortDate(timing.startDate)}–${shortDate(timing.endDate)}${timing.phase === 'upcoming' ? `、${shortDate(timing.startDate)}開始` : ''}）` : '今の期間：なし（日付のあるイテレーションが未登録）';
  const collapsed = new Set(['ready-later', 'waiting']);
  const sections = work.sections.map(section => {
    const list = `<ul class="my-work-list">${section.tasks.map(item => myWorkRow(item, section.id)).join('')}</ul>`;
    const heading = `${escape(section.title)} <span class="my-work-count">${section.tasks.length}件</span>`;
    return collapsed.has(section.id)
      ? `<details class="my-work-section" data-my-work-section="${section.id}"><summary><h3>${heading}</h3></summary>${list}</details>`
      : `<section class="my-work-section ${section.id === 'action' ? 'needs-action' : ''}" data-my-work-section="${section.id}"><h3>${heading}</h3>${list}</section>`;
  }).join('');
  return `<div class="owner-filter" role="group" aria-label="担当者で絞り込む">${choices.map(([value, label]) => `<button type="button" class="owner-choice" data-owner-filter="${value.all ? 'all' : value.owner === null ? 'none' : 'owner'}"${typeof value.owner === 'string' ? ` data-owner-name="${escape(value.owner)}"` : ''} aria-pressed="${sameOwnerFilter(value, filter)}" title="${escape(label)}">${escape(label)}</button>`).join('')}</div><p class="footnote my-work-period">${period}</p>${sections || `<p class="empty-message">${state.tasks.length ? 'この担当者の未完了の作業はありません。' : '作業未登録。「登録・取込」から目標と作業を登録します。'}</p>`}`;
}
function renderMyWork(project) {
  const snapshot = project.githubSnapshot;
  if (!snapshot && !localRepositoryKey(project.repositoryUrl)) return renderManualMyWork(project);
  const owners = githubOwners(snapshot), requested = githubOwnerFilters.get(project.id) || { all: true };
  const filter = requested.all || owners.includes(requested.owner) ? requested : { all: true };
  return `<section class="github-work"><div class="snapshot-heading"><h2>GitHubの作業 <small>読み取り専用</small></h2>${snapshot ? snapshotAgeMarkup(snapshot) : ''}</div><div data-local-github>${localGithubMarkup(project)}</div>${renderGithubWork(snapshot, filter)}</section><details class="manual-work" ${state.tasks.length && !githubPlan(snapshot) ? 'open' : ''}><summary>手動の作業 ${state.tasks.length}件${githubPlan(snapshot) ? '（GitHubで計画しているため畳んで表示）' : ''}</summary>${renderManualMyWork(project)}</details>`;
}
// 古いsnapshotの件数だけでは、Readyにできると断定しない。上限に達していた事実は取得時点のものとして示す。
function approvalStatus(project) {
  const { queue, stale } = approvalState(project.githubSnapshot, Date.now(), projectApprovalLimit(project));
  if (!queue) return { queue, full: false, text: 'GitHub snapshotを読み込むと表示します。' };
  if (queue.full) return { queue, full: true, text: stale ? '取得時点で上限に達していました。古いsnapshotのため、最新の件数は未確認です。' : '上限に達しています。AIは新しくPRをReadyにせず、承認を待ちます。' };
  return { queue, full: false, text: stale ? '古いsnapshotのため、PRをReadyにできるかは未確認です。最新のsnapshotを取得してください。' : `あと${queue.remaining}件まで、AIはPRをReadyにできます。` };
}
function approvalSummary(project) {
  const { queue, full, text } = approvalStatus(project);
  const heading = queue ? `承認待ちのPR ${queue.items.length}件 / 上限${queue.limit}件` : `承認待ちのPR：未取得（上限${projectApprovalLimit(project)}件）`;
  return `<dt class="summary-approval ${full ? 'full' : ''}">${escape(heading)}</dt><dd>${escape(text)}${queue ? `<br>${snapshotAgeMarkup(project.githubSnapshot)}` : ''}</dd>`;
}
function renderApprovalQueue(project) {
  const limit = projectApprovalLimit(project), queue = approvalQueue(project.githubSnapshot, limit);
  const change = `<button type="button" class="text-button approval-limit-change" data-action="approval-limit" data-id="">上限を変更</button>`;
  if (!queue) return `<div class="approval-head"><h2>承認待ちのPR <small>上限${limit}件</small></h2>${change}</div><p class="approval-note">未取得。GitHub snapshotを読み込むと、承認待ちのPRと上限の状態を表示します。</p>`;
  const current = approvalStatus(project);
  const status = `<p class="approval-status ${current.full ? 'full' : ''}" role="status">${escape(current.text)}</p>`;
  const list = queue.items.length ? `<ul class="approval-items">${queue.items.map(item => `<li><a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">#${item.number}</a><span>${escape(item.title)}</span><small>${escape(githubStateLabel(item))}</small></li>`).join('')}</ul>` : '';
  return `<div class="approval-head"><h2>承認待ちのPR <strong class="${queue.full ? 'full' : ''}">${queue.items.length}件</strong> <small>上限${queue.limit}件</small></h2>${change}${snapshotAgeMarkup(project.githubSnapshot)}</div>${status}${list}`;
}
// ③ 要対応：手動計画とGitHubの計画のどちらも、同じ判定（要対応のまとまり）を使う。
function attentionView(project) {
  const snapshot = project.githubSnapshot, today = todayInTokyo();
  const requested = attentionMe.get(project.id) ?? null;
  if (githubPlan(snapshot)) {
    const owners = githubOwners(snapshot).filter(Boolean).sort((x, y) => x.localeCompare(y, 'ja'));
    const me = owners.includes(requested) ? requested : null;
    const queue = approvalQueue(snapshot);
    return { kind: 'github', model: { approvals: queue ? queue.items.map(({ number, title, url }) => ({ number, title, url })) : [], owners, me,
      mine: me ? githubMineItems(snapshot, me, today) : [], items: githubAttentionItems(snapshot, today) || [] } };
  }
  if (snapshot || localRepositoryKey(project.repositoryUrl)) return { kind: 'github', model: null };
  const owners = [...new Set(orderedTasks(state).filter(task => task.status !== 'done').map(taskOwner).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'ja'));
  const me = owners.includes(requested) ? requested : null;
  const action = myWork(state, undefined, today).sections.find(section => section.id === 'action');
  const mine = me ? myWork(state, me, today).sections.filter(section => MINE_GROUPS.includes(section.id)).flatMap(section => section.tasks.map(({ task }) => ({
    nameHtml: `<button class="issue-name" data-action="task" data-id="${escape(task.id)}">${escape(task.title)}</button>` }))) : [];
  return { kind: 'manual', model: { approvals: null, owners, me, mine, items: (action?.tasks ?? []).map(({ task, reasons }) => ({
    reasons, endedOn: manualEndedOn(reasons, today),
    nameHtml: `<button class="issue-name" data-action="task" data-id="${escape(task.id)}">${escape(task.title)}</button>`,
  })) } };
}
function renderAttention(project) {
  const view = attentionView(project);
  if (!view.model) return '<p class="empty-message">GitHubの計画情報は未取得です。取得すると、手が要る作業を表示します。</p>';
  return attentionPanelMarkup(view.model);
}
function renderViewTabs(project) {
  const hasRelease = !!githubPlan(project.githubSnapshot);
  $('#tab-release').hidden = !hasRelease;
  if (!hasRelease && viewTab === 'release') viewTab = 'my-work';
  for (const tab of document.querySelectorAll('.view-tab')) {
    const selected = tab.dataset.view === viewTab;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
  }
  $('#my-work-panel').hidden = viewTab !== 'my-work';
  $('#iterations-panel').hidden = viewTab !== 'iterations';
  $('#attention-panel').hidden = viewTab !== 'attention';
  $('#release-panel').hidden = viewTab !== 'release';
  if (hasRelease) $('#release-panel').innerHTML = releasePanelMarkup(releaseSummaries(project.githubSnapshot));
  $('#approval-queue').hidden = viewTab === 'attention';
  $('#my-work-panel').innerHTML = renderMyWork(project);
  const attention = attentionView(project), count = attention.model ? attentionCount(attention.model) : 0;
  $('#tab-attention').innerHTML = `要対応${count ? `<span class="tab-count">${count}</span>` : ''}`;
  $('#attention-panel').innerHTML = renderAttention(project);
}
function selectView(view, focus = false) {
  viewTab = view; writeView({ tab: view }); render();
  if (focus) document.querySelector(`.view-tab[data-view="${view}"]`).focus();
}
function render() {
  if (workspace?.selectedProjectId) for (const element of document.querySelectorAll('[data-github-disclosure]')) githubDisclosures.set(workspace.selectedProjectId + ':' + element.dataset.githubDisclosure, element.open);
  queueMicrotask(() => localGithub.refresh());
  workspace = store.snapshot();
  if (viewProjectId !== undefined) workspace.selectedProjectId = viewProjectId;
  const project = workspace.selectedProjectId ? findProject(workspace, workspace.selectedProjectId) : null;
  state = project?.data || null;
  const status = store.status();
  $('#storage-label').textContent = cloudMode ? (status.readOnly ? '保存を停止' : 'クラウド保存') : 'ブラウザ保存';
  $('.storage-scope').textContent = cloudMode ? `同じChatGPTアカウントで開くPC・スマートフォンに共有します。最新データは読込時に取得し、保存が確認できるまで変更を反映しません。GitHubへの書込はありません。${status.updatedAt ? ` 最終保存：${utcTime(status.updatedAt)}` : ''}` : 'このブラウザ・このURLの保存領域に保存します。サーバーやGitHubへの同期はありません。ブラウザのデータ削除で失われるため、必要なデータは書き出してください。';
  $('#bug-reporting-link').hidden = cloudMode;
  $('#migrate-workspace').hidden = !cloudMode;
  $('#prepared-workspace').hidden = !cloudMode;
  $('#prepared-estimates').hidden = !cloudMode;
  $('#refresh-cloud').hidden = !cloudMode;
  $('#export-cloud-backup').hidden = !cloudMode;
  $('#export-workspace').disabled = cloudMode && !status.loaded;
  $('#storage-warning').hidden = !status.problem;
  $('#storage-problem').textContent = status.problem;
  $('#recover-backup').hidden = !status.readOnly || !status.hasBackup;
  $('#recovery-file-label').hidden = cloudMode || !status.readOnly;
  $('#project-switch').innerHTML = '<option value="">全体一覧</option>' + workspace.projects.map(project => `<option value="${escape(project.id)}">${escape(project.name)}</option>`).join('');
  $('#project-switch').value = workspace.selectedProjectId || '';
  $('#project-detail').hidden = !project;
  $('#projects-overview').hidden = !!project;
  $('#open-overview').hidden = !project;
  document.title = `今日の進捗 — ${project?.name || 'プロジェクト一覧'}`;
  if (!project) {
    $('#project-name').textContent = 'プロジェクト一覧';
    $('#projects-overview').innerHTML = workspace.projects.length ? `${workspace.projects.some(project => project.githubSnapshot) ? '<p class="snapshot-note">次の作業・要対応・確認待ちは手動の目標・作業から、承認待ちのPRはGitHub snapshotから表示します。</p>' : ''}<div class="project-grid">${workspace.projects.map(project => {
      const summary = projectSummary(project);
      const next = summary.next?.title || (summary.total ? (summary.review.length || summary.action.length ? '要対応・確認待ちの確認が必要' : '未完了の作業なし') : '作業未登録');
      const action = summary.action[0], urgent = githubUrgentSummary(project.githubSnapshot);
      return `<article class="project-card" data-project-card="${escape(project.id)}"><h2>${escape(project.name)}</h2><p class="repository">${escape(project.repositoryUrl || 'repository未登録')}</p>${githubPlan(project.githubSnapshot) ? `<p class="footnote">GitHub：目標 ${githubPlan(project.githubSnapshot).goals.length}件 · 作業 ${githubPlan(project.githubSnapshot).tasks.length}件 · リリース ${githubPlan(project.githubSnapshot).releases.length}件</p>` : ''}<dl>${urgent ? `<dt class="summary-urgent">緊急 ${urgent.count}件</dt><dd class="summary-urgent">${escape(urgent.first)}</dd>` : ''}<dt>手動計画の次の作業</dt><dd>${escape(next)}</dd><dt>要対応 ${summary.action.length}件</dt><dd class="summary-action">${action ? escape(`${action.task.title}：${action.reasons[0]}`) : 'なし'}</dd><dt>確認待ち ${summary.review.length}件</dt><dd>${escape(summary.review[0]?.title || 'なし')}</dd>${approvalSummary(project)}</dl>${button('プロジェクトを開く', 'select-project', project.id)}</article>`;
    }).join('')}</div>` : `<div class="workspace-empty"><h2>管理するプロジェクトを登録</h2><p>複数のプロジェクトを個別に登録できます。ローカルでは、PROGRESS_GITHUB_REPOSで指定したrepositoryの目標・作業・期間・リリースを既存ghから自動取得します。手動の計画も別に入力できます。</p>${button('プロジェクトを登録', 'add-project', '', true)}</div>`;
    disableEditing(); return;
  }
  $('#estimate-scope').textContent = `割合は登録した計画作業の見積ベースの完了率です。製品全体の成熟度ではありません。${hasProvisional(state.tasks) ? ' 仮見積を含む割合は暫定です。' : ''}`;
  $('#project-meta').innerHTML = `${project.repositoryUrl ? `<a href="${escape(project.repositoryUrl)}" target="_blank" rel="noopener noreferrer">${escape(project.repositoryUrl.replace('https://github.com/', ''))}</a>` : 'repository未登録'} · プロジェクトID：${escape(project.id)}`;
  $('#goal-list').innerHTML = state.goals.length ? `<div class="goal-list">${state.goals.map(goal => button(goal.title, 'overview', goal.id)).join('')}</div>` : '<p class="empty-message">目標未登録。「登録・取込」から目標を登録し、その目標の作業を追加します。</p>';
  $('#github-planning').innerHTML = renderGithubPlanning(project);
  $('#manual-periods').hidden = !state.goals.length && !!githubPlan(project.githubSnapshot);
  $('#project-name').textContent = state.project;
  const overdue = overdueTasks(state);
  $('#open-overdue').hidden = !overdue.length;
  $('#open-overdue').textContent = `期限超過 ${overdue.length}件`;
  const active = state.tasks.filter(t => t.status === 'active').length;
  const ready = state.goals.reduce((count, goal) => count + nextWork(state, goal.id).ready.length, 0);
  $('#board-status').textContent = `作業中 ${active}${ready ? ` · 着手可能 ${ready}` : ''}`;
  $('#iteration-count').textContent = state.iterations.length;
  $('#iterations-board').innerHTML = renderIterations('main');
  $('#approval-queue').innerHTML = renderApprovalQueue(project);
  $('#approval-queue').classList.toggle('full', !!approvalQueue(project.githubSnapshot, projectApprovalLimit(project))?.full);
  renderViewTabs(project);
  for (const element of document.querySelectorAll('[data-github-disclosure]')) {
    const key = project.id + ':' + element.dataset.githubDisclosure;
    if (githubDisclosures.has(key)) element.open = githubDisclosures.get(key);
  }
  updateIterationExpandButton();
  disableEditing();
}
function disableEditing() {
  const readOnly = store.status().readOnly;
  document.querySelectorAll('[data-action]').forEach(element => {
    if (!editingActions.has(element.dataset.action)) return;
    if (readOnly && !element.disabled) { element.dataset.storageDisabled = 'true'; element.disabled = true; }
    else if (!readOnly && element.dataset.storageDisabled) { element.disabled = false; delete element.dataset.storageDisabled; }
  });
  const addTaskButton = $('#add-task');
  if (addTaskButton) addTaskButton.disabled = readOnly || !state?.goals.length;
  if (readOnly) $('#drawer-body').querySelectorAll('input, textarea, select, [type="submit"]').forEach(element => { element.disabled = true; });
}
function updateIterationExpandButton() {
  const expanded = expandedIterations.get('main');
  $('#expand-iterations').textContent = state.iterations.length && state.iterations.every(i => expanded?.has(i.id)) ? 'すべて閉じる' : 'すべて展開';
  $('#expand-iterations').disabled = !state.iterations.length;
}
function openPanel(type, id = '', goalId = '', owner = null) {
  if (busy) { notify('保存中です。完了後に詳細を開いてください。'); return; }
  capturePanelDrafts();
  if (!$('#detail-dialog').open) { workloadPanel = null; managementPanel = null; }
  if (type === 'manage') { workloadPanel = null; managementPanel = { projectId: workspace.selectedProjectId }; }
  if (type === 'workload') workloadPanel = { type, id, goalId, owner, projectId: workspace.selectedProjectId };
  panel = { type, id, goalId, owner, projectId: workspace.selectedProjectId }; renderPanel(); disableEditing();
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
  else $('#close-dialog').focus();
  $('#detail-dialog').scrollTop = 0;
}
const panelKey = () => JSON.stringify([panel.projectId, panel.type, panel.id, panel.goalId || '', panel.owner]);
const panelInputValue = input => input.multiple ? [...input.selectedOptions].map(option => option.value) : input.value;
const panelInputs = () => [...$('#drawer-body').querySelectorAll('input[id]:not([type="checkbox"]), textarea[id], select[id]')];
function capturePanelDrafts() {
  if (!panel) return;
  const key = panelKey();
  const drafts = panelDrafts.get(key) || new Map();
  for (const input of panelInputs()) {
    const value = panelInputValue(input);
    if (JSON.stringify(value) === JSON.stringify(panelInputValues.get(input.id))) drafts.delete(input.id);
    else drafts.set(input.id, value);
  }
  if (drafts.size) panelDrafts.set(key, drafts);
  else panelDrafts.delete(key);
}
function clearPanelSession() {
  panel = null;
  workloadPanel = null;
  managementPanel = null;
  panelDrafts.clear();
  panelInputValues.clear();
  snapshotCandidates = null;
  migrationData = null;
  estimateData = null;
  migrationBackupWritten = false;
  migrationLoadSequence++;
  snapshotLoadSequence++;
}
function error(message) {
  if (!$('#detail-dialog').open) { notify(message); return; }
  let element = $('#panel-error');
  if (!element) { element = document.createElement('p'); element.id = 'panel-error'; element.className = 'inline-error'; element.setAttribute('role', 'alert'); $('#drawer-body').prepend(element); }
  element.textContent = message;
  if (cloudMode && store.status().readOnly && !$('#export-pending-inputs')) {
    element.insertAdjacentHTML('afterend', '<button type="button" class="button secondary" id="export-pending-inputs" data-action="export-pending-inputs">変更候補・未保存入力を退避</button>');
  }
}
async function commitWorkspace(action, message, afterSave = null, rerenderPanel = true, savedInputs = []) {
  if (busy) return false;
  busy = true; $('main').setAttribute('aria-busy', 'true');
  const heldInputs = [...$('#drawer-body').querySelectorAll('input, textarea, select')].map(input => ({ input, disabled: input.disabled }));
  try {
    capturePanelDrafts();
    heldInputs.forEach(({ input }) => { input.disabled = true; });
    await exclusive(() => store.transact(action));
    if (afterSave) afterSave();
    render();
    if (panel) {
      const drafts = panelDrafts.get(panelKey());
      savedInputs.forEach(id => drafts?.delete(id));
    }
    if (rerenderPanel && panel) {
      const focusAction = document.activeElement?.dataset?.action;
      const focusId = document.activeElement?.dataset?.id;
      renderPanel();
      const replacement = [...$('#drawer-body').querySelectorAll('[data-action]')].find(el => el.dataset.action === focusAction && el.dataset.id === focusId && !el.disabled);
      (replacement || $('#close-dialog')).focus();
    }
    disableEditing();
    notify(message);
    return true;
  } catch (e) { render(); error(e.message); return false; }
  finally {
    heldInputs.forEach(({ input, disabled }) => { if (input.isConnected) input.disabled = disabled || store.status().readOnly; });
    busy = false; $('main').removeAttribute('aria-busy');
  }
}
function mutate(action, message, rerenderPanel = true, savedInputs = []) {
  const projectId = workspace.selectedProjectId;
  if (!projectId || panel?.projectId !== projectId) { error('対象のプロジェクトを開き直してください。'); return Promise.resolve(false); }
  return commitWorkspace(draft => updateProject(draft, projectId, action), message, null, rerenderPanel, savedInputs);
}
function closePanel() {
  $('#detail-dialog').close(); clearPanelSession();
}
function finishRegistration() {
  if (!managementPanel) { closePanel(); return; }
  const projectId = store.snapshot().selectedProjectId;
  clearPanelSession();
  managementPanel = { projectId };
  panel = { type: 'manage', id: '', goalId: '', owner: null, projectId };
}
function switchProject(projectId) {
  if (busy) { notify('保存中です。完了後に表示を切り替えてください。'); return Promise.resolve(false); }
  if (cloudMode && !store.status().readOnly) {
    store.select(projectId); viewProjectId = undefined;
    closePanel(); expandedIterations.clear(); collapsedPeriodGoals.clear(); render();
    return Promise.resolve(true);
  }
  if (store.status().readOnly) {
    if (projectId !== null) findProject(workspace, projectId);
    viewProjectId = projectId; closePanel(); expandedIterations.clear(); collapsedPeriodGoals.clear(); render();
    notify('保存を停止した状態で閲覧しています'); return Promise.resolve(true);
  }
  return commitWorkspace(draft => selectProject(draft, projectId), '表示を切り替えました', () => {
    closePanel(); expandedIterations.clear(); collapsedPeriodGoals.clear();
  });
}
function taskLink(task, showGoal = false) {
  return `<li>${badge(task)}<button class="text-button" data-action="task" data-id="${task.id}">${escape(task.title)}</button>${showGoal ? `<span class="footnote">${escape(findGoal(state, task.goalId).title)}</span>` : ''}</li>`;
}
function iterationTaskRow(task, showGoal = false) {
  const block = blockers(state, task);
  return `<li><div class="iteration-task-title">${badge(task)}<button class="text-button" data-action="task" data-id="${escape(task.id)}">${escape(task.title)}</button></div>${showGoal ? `<p class="footnote">${escape(findGoal(state, task.goalId).title)}</p>` : ''}<p class="iteration-task-meta">Estimate：${formatEstimate(task.estimatePoints)} · ${taskDeadline(task)}</p>${task.status !== 'done' && block.length ? `<p class="dependent-note">待ち：${escape(block[0].text)}</p>` : ''}</li>`;
}
function workloadTaskRow(task, showGoal = false) {
  return `<li class="compact-task"><div><button class="text-button" data-action="task" data-id="${escape(task.id)}">${escape(task.title)}</button>${showGoal ? `<small class="compact-task-goal">${escape(findGoal(state, task.goalId).shortTitle || findGoal(state, task.goalId).title)}</small>` : ''}${blockers(state, task).length ? `<div class="compact-task-blocker">${taskBlocker(task)}</div>` : ''}</div><div class="compact-task-values"><strong>${formatEstimate(task.estimatePoints)}</strong>${estimateTag(task)}${badge(task)}</div></li>`;
}
function parentProgressNote(issue, progress) {
  return issue.issueState === 'closed' && progress.total && progress.complete < progress.total
    ? '<p class="notice">このIssueはClosedですが、配下には未完了の作業Issueが残っています。</p>' : '';
}
function issueTree(parentId, depth = 0) {
  const children = issueChildren(state, parentId);
  if (!children.length) return '<p class="empty-message">子Issueが登録されていません。</p>';
  return `<ul class="issue-tree" data-parent-issue="${escape(parentId)}">${children.map(({ kind, issue }) => {
    if (kind === 'parent') {
      const progress = issueProgress(state, issue.id);
      return `<li class="issue-branch"><details ${depth === 0 ? 'open' : ''}><summary><span class="issue-node-name"><small class="issue-reference">子Issue · ${escape(issueReference(issue))}</small><span>${escape(issue.title)}</span></span><span class="issue-node-progress"><strong>${progress.percent === null ? '—' : `${progress.percent}%`}</strong><small>${progress.missingEstimates ? `Estimate未入力 ${progress.missingEstimates}件` : progress.total ? `${formatEstimate(progress.completePoints)} / ${formatEstimate(progress.totalPoints)}` : '作業未登録'}</small></span>${parentIssueBadge(issue)}</summary><div class="issue-branch-content">${parentProgressNote(issue, progress)}<p class="branch-description">配下の作業Issue ${progress.complete}/${progress.total}件 完了 <button class="text-button" data-action="issue" data-id="${escape(issue.id)}">内訳を確認</button></p>${issueTree(issue.id, depth + 1)}</div></details></li>`;
    }
    return `<li class="issue-task"><button class="tree-row" data-action="task" data-id="${escape(issue.id)}"><span class="tree-task-name"><small class="issue-reference">作業Issue · ${escape(issueReference(issue))}</small>${escape(issue.title)}<small class="tree-estimate">Estimate：${formatEstimate(issue.estimatePoints)}${estimateTag(issue)}</small><small class="tree-deadline">${taskDeadline(issue, true)}</small></span>${taskProgressSummary(issue)}${badge(issue)}</button>${issue.status !== 'done' && blockers(state, issue).length ? `<p class="tree-sub">${escape(blockers(state, issue)[0].text)}</p>` : ''}</li>`;
  }).join('')}</ul>`;
}
function treeForGoal(goal, showTitle = true) {
  const progress = goalProgress(state, goal.id);
  return `<section class="overview-goal"><p class="issue-root-reference">親Issue · ${escape(issueReference(goal))} ${parentIssueBadge(goal)}</p>${showTitle ? `<h3 class="overview-goal-title">${escape(goal.title)}</h3>` : ''}<div class="overview-progress">${goalProgressMetric(progress, '登録計画の見積完了率', false, hasProvisional(orderedTasks(state, goal.id)))}</div>${parentProgressNote(goal, progress)}<div class="actions overview-actions">${button('優先順を変更', 'order', goal.id)}${button('期間の内訳', 'iteration', goal.id)}${button('依存関係', 'blockers', goal.id)}</div>${issueTree(goal.id)}</section>`;
}
function blockingDetail(row, goalId) {
  const task = row.task;
  const decision = task && state.decisions.find(d => d.id === task.decisionId && !d.resolved);
  const actionText = !task ? '前提作業の状態と完了条件を確認してください。' : task.waitReason ? `待ちを解除する対応：${task.waitReason}` : task.status === 'review' ? '成果の根拠と完了条件を確認し、完了を確定してください。' : task.status === 'unknown' ? '作業の状態を確認してください。' : decision ? '判断材料を確認し、採用する内容と理由を記録してください。' : row.causes.length ? '未完了の前提・待ちを先に解消してください。' : '完了条件を満たし、成果を確認して完了にしてください。';
  return `<div class="detail-meta"><span class="badge blocked">${blockingLabel(row)}</span>${task?.goalId !== goalId && task ? `<span>${escape(findGoal(state, task.goalId).title)}</span>` : ''}</div><section class="detail-section"><h3>解除に必要な対応</h3><p>${escape(actionText)}</p>${row.causes.length ? `<div class="notice">${row.causes.map(c => escape(c.text)).join('<br>')}</div>` : ''}<div class="actions">${decision ? button('判断材料を確認', 'decision', decision.id, true) : ''}${task ? button(task.status === 'review' ? '成果を確認する' : '作業を開く', 'task', task.id, !decision) : ''}${task && row.causes.some(c => c.kind === 'dependency') ? button('前提を確認', 'reason', task.id) : ''}</div></section><section class="detail-section"><h3>直接待っている作業 <span class="muted-count">${row.direct.length}件</span></h3>${row.direct.length ? `<ul class="dependency-list blocking-dependents">${row.direct.map(t => {
    const other = blockers(state, t).filter(c => !(c.kind === 'dependency' && c.id === row.id));
    return `<li><div>${badge(t)}<button class="text-button" data-action="task" data-id="${t.id}">${escape(t.title)}</button></div>${t.goalId !== goalId ? `<p class="footnote">${escape(findGoal(state, t.goalId).title)}</p>` : ''}<p class="dependent-note">${other.length ? `ほかの前提・待ち：${other.map(c => escape(c.text)).join(' / ')}` : t.status === 'todo' ? 'この前提が完了すると着手できます。' : 'この前提の完了を待っています。'}</p></li>`;
  }).join('')}</ul>` : '<p>この作業だけが待っています。</p>'}</section>${row.indirect.length ? `<section class="detail-section"><h3>その先で待っている作業 <span class="muted-count">${row.indirect.length}件</span></h3><ul class="dependency-list">${row.indirect.map(t => taskLink(t, t.goalId !== goalId)).join('')}</ul><p class="blocking-explanation">途中の前提が完了するまで、これらの作業は着手できません。</p></section>` : ''}`;
}
function renderPanel() {
  renderPanelContent();
  const inputs = panelInputs();
  panelInputValues = new Map(inputs.map(input => [input.id, panelInputValue(input)]));
  const drafts = panelDrafts.get(panelKey());
  for (const input of inputs) {
    if (!drafts?.has(input.id)) continue;
    if (input.multiple) for (const option of input.options) option.selected = drafts.get(input.id).includes(option.value);
    else input.value = drafts.get(input.id);
  }
  $('#back-workload').hidden = !workloadPanel || workloadPanel.projectId !== panel.projectId || panel.type === 'workload';
  $('#back-manage').hidden = !managementPanel || managementPanel.projectId !== panel.projectId || panel.type === 'manage';
}
function renderPreparedEstimates() {
  $('#drawer-project').textContent = '';
  $('#drawer-kicker').textContent = '未入力の見積を登録';
  $('#drawer-title').textContent = '仮見積を確認して登録';
  let content = '<p role="status">見積案を読み込んでいます…</p>';
  if (estimateData) {
    try {
      const plan = planPreparedEstimates(store.snapshot(), estimateData.baseline, estimateData.proposal);
      estimateData.confirmedChanges = structuredClone(plan.changes);
      content = `<p><strong>未入力 → 仮見積 ${plan.changes.length}件・合計 ${plan.addedPoints}ptを追加</strong></p>${plan.changes.map(change => `<section class="detail-section estimate-proposal"><h3>${escape(change.projectName)} · ${escape(change.title)}</h3><p>未入力 → <strong>${change.points}pt</strong> <span class="badge unknown">${change.retrospective ? '事後の仮見積' : '仮見積'}</span></p><details><summary>根拠と不確かさ（目安 ${change.range[0]}–${change.range[1]}pt）</summary><p>${escape(change.rationale)}</p><p>低確度の計画値です。実績時間・期限ではありません。範囲が変わった場合は見直してください。</p></details></section>`).join('')}${plan.skipped.length ? `<details class="detail-section"><summary>変更しない作業 ${plan.skipped.length}件</summary><ul class="migration-projects">${plan.skipped.map(item => `<li><strong>${escape(item.projectName)} · ${escape(item.title)}</strong><small>${escape(item.reason)}</small></li>`).join('')}</ul></details>` : ''}${plan.changes.length ? '<form data-form="apply-prepared-estimates"><button class="button primary" type="submit">この仮見積を未入力の作業に登録</button></form>' : '<p role="status">追加できる未入力の見積はありません。既存データは変更しません。</p>'}`;
    } catch (e) { estimateData.confirmedChanges = null; content = `<p class="inline-error" role="alert">${escape(e.message)}</p>`; }
  }
  $('#drawer-body').innerHTML = `<p class="snapshot-note">1日＝1ポイント。0.5ptなど小数も使います。同梱のサンプル記録（架空）の18作業に用意した仮見積です。その後の新規作業や変更した範囲には当てはめません。</p><p class="snapshot-note">保存済みの見積は保持します。状態・完了条件・証拠は変えず、未入力だけに追加します。割合は登録した計画作業の見積ベースの完了率です。製品全体の成熟度ではありません。</p>${content}`;
}
async function loadPreparedEstimates() {
  if (!cloudMode || busy || store.status().readOnly) return;
  estimateData = null; openPanel('prepared-estimates');
  const origin = panel, sequence = ++migrationLoadSequence;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const [baseline, proposal] = await Promise.all(['prepared-workspace.json', 'prepared-estimates.json'].map(async path => {
      const response = await fetch('./' + path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('見積案を読み込めません。');
      return response.json();
    }));
    if (panel !== origin || sequence !== migrationLoadSequence || store.status().readOnly) return;
    estimateData = { baseline, proposal, confirmedChanges: null }; renderPanel(); disableEditing();
  } catch (e) {
    if (panel === origin && sequence === migrationLoadSequence) { $('#drawer-body [role="status"]')?.remove(); error(`保存内容は変えていません。閉じてからもう一度お試しください。${e.message}`); }
  } finally { clearTimeout(timer); }
}
function renderPreparedWorkspace() {
  $('#drawer-project').textContent = '';
  $('#drawer-kicker').textContent = '初回のデータ取込';
  $('#drawer-title').textContent = '用意済みの3プロジェクトを取り込む';
  let preview = '<p role="status">用意済みの記録を読み込んでいます…</p>';
  if (migrationData?.prepared) {
    try {
      const plan = store.migrationPlan(migrationData.workspace);
      preview = `<p>新規 ${plan.added.length}プロジェクト · 同じ内容 ${plan.skipped.length}プロジェクト</p><ul class="migration-projects">${migrationData.workspace.projects.map(project => `<li><strong>${escape(project.name)}</strong><span>${escape(project.repositoryUrl || 'repository未登録')}</span><small>${project.data.tasks.length}作業 · ${plan.added.includes(project.id) ? '追加' : '同じ内容を保持'}</small></li>`).join('')}</ul>${plan.added.length ? '<form data-form="migrate-prepared"><button class="button primary" type="submit">確認してクラウドに追加</button></form>' : '<p role="status">用意済みの記録はすべて取込済みです。追加・上書きは行いません。</p>'}`;
    } catch (e) { preview = `<p class="inline-error" role="alert">${escape(e.message)}</p>`; }
  }
  $('#drawer-body').innerHTML = `<p class="snapshot-note">2026年10月4日 12:22（日本時間）時点で用意した記録です。取込後の変更は同じアカウントで保存され、毎回の登録は不要です。現在のGitHub状態への自動更新は行いません。</p>${preview}<p class="snapshot-note">既存のプロジェクトは変更せず、足りないものだけ追加します。同じIDで内容が異なる場合は全件停止します。原本はこのサイトに保持され、保存前のクラウドデータも版履歴に残ります。ファイル操作は不要です。</p>`;
}
async function loadPreparedWorkspace() {
  if (!cloudMode || busy || store.status().readOnly) return;
  migrationData = null; migrationBackupWritten = false;
  openPanel('prepared-workspace');
  const origin = panel, sequence = ++migrationLoadSequence;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('./prepared-workspace.json', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('記録を読み込めません。閉じてからもう一度お試しください。');
    const incoming = await response.json();
    if (panel !== origin || sequence !== migrationLoadSequence || store.status().readOnly) return;
    migrationData = { workspace: incoming, prepared: true };
    renderPanel(); disableEditing();
  } catch (e) {
    if (panel === origin && sequence === migrationLoadSequence) {
      $('#drawer-body [role="status"]')?.remove();
      error(`クラウドの内容は変更していません。閉じてからもう一度お試しください。${e.message}`);
    }
  } finally { clearTimeout(timer); }
}

function renderMigration() {
  $('#drawer-project').textContent = '';
  $('#drawer-kicker').textContent = '保存データの移行';
  $('#drawer-title').textContent = 'ブラウザ保存からクラウドへ移行';
  let preview = '';
  if (migrationData) {
    try {
      const plan = store.migrationPlan(migrationData.workspace);
      preview = `<section class="detail-section"><h3>${escape(migrationData.name)}</h3><p>新規 ${plan.added.length}プロジェクト · 同じ内容 ${plan.skipped.length}プロジェクト</p><ul class="migration-projects">${migrationData.workspace.projects.map(project => `<li><strong>${escape(project.name)}</strong><span>${escape(project.repositoryUrl || 'repository未登録')}</span><small>ID：${escape(project.id)} · ${plan.added.includes(project.id) ? '追加' : '同じ内容を保持'}</small></li>`).join('')}</ul><p class="snapshot-note">同じrepositoryでもIDが違うプロジェクトは別々に保持します。IDが同じで内容が異なる場合は取込を停止します。</p>${button('移行元のバックアップを書き出す', 'migration-backup')}<form data-form="migrate-workspace"><label class="migration-confirm"><input id="migration-backup-confirmed" type="checkbox" required ${migrationBackupWritten ? '' : 'disabled'}><span>移行元のバックアップを保存し、追加するプロジェクトを確認した</span></label><button class="button primary" type="submit" ${migrationBackupWritten ? '' : 'disabled'}>確認したデータをクラウドに追加</button></form></section>`;
    } catch (error) { preview = `<p class="inline-error" role="alert">${escape(error.message)}</p>${button('移行元のバックアップを書き出す', 'migration-backup')}`; }
  }
  $('#drawer-body').innerHTML = `<p class="snapshot-note">既存のクラウドデータを保持し、確認したプロジェクトだけを追加します。元のブラウザ保存は削除・上書きしません。別のURLのデータは、以前の画面で「データを書き出す」を使って移してください。</p><div class="actions">${button('このブラウザの保存を確認', 'migration-local')}${button('このブラウザの保存データを退避', 'migration-local-backup')}</div><label class="field">以前の画面で書き出したworkspace JSON（12MiB以下）<input id="migration-file" type="file" accept="application/json,.json"></label>${preview}`;
}
function renderPanelContent() {
  const { type, id, goalId, owner } = panel;
  if (type === 'prepared-estimates') { renderPreparedEstimates(); return; }
  if (type === 'prepared-workspace') { renderPreparedWorkspace(); return; }
  if (type === 'migrate-workspace') { renderMigration(); return; }
  if (type === 'import-snapshot') { renderSnapshotImport(); return; }
  if (type === 'manage') {
    const project = panel.projectId ? findProject(workspace, panel.projectId) : null;
    $('#drawer-kicker').textContent = 'データの登録と取込';
    $('#drawer-title').textContent = '登録・取込';
    $('#drawer-project').textContent = project ? `${project.name} · ${project.repositoryUrl || 'repository未登録'}` : '';
    $('#drawer-body').innerHTML = `<section class="detail-section"><h3>プロジェクトとGitHub snapshot</h3><div class="actions">${button('プロジェクトを登録', 'add-project')}${button('GitHub snapshotを読み込む', 'import-snapshot')}</div></section>${project ? `<section class="detail-section"><h3>このプロジェクトの目標・作業</h3><div class="actions">${button('目標を登録', 'add-goal')}<button class="button secondary" id="add-task" data-action="add-task">作業を登録</button></div></section><section id="github-snapshot" class="github-snapshot" aria-label="GitHub snapshot">${renderGithubSnapshot(project)}</section>` : ''}`;
    return;
  }
  $('#drawer-project').textContent = type === 'add-project' ? '' : `${findProject(workspace, panel.projectId).name} · ${findProject(workspace, panel.projectId).repositoryUrl || 'repository未登録'}`;
  if (type !== 'add-project' && panel.projectId !== workspace.selectedProjectId) throw new Error('プロジェクトが変更されました。詳細を開き直してください。');
  if (['add-project', 'add-goal', 'add-task'].includes(type)) {
    $('#drawer-kicker').textContent = type === 'add-project' ? 'プロジェクトの登録' : '選択したプロジェクトに登録';
    $('#drawer-title').textContent = { 'add-project': 'プロジェクトを登録', 'add-goal': '目標を登録', 'add-task': '作業を登録' }[type];
    $('#drawer-body').innerHTML = `<form class="registration-form" data-form="${type}"><label class="field">${type === 'add-project' ? 'プロジェクト名' : type === 'add-goal' ? '目標名' : '作業名'}<input id="registration-title" name="title" maxlength="${type === 'add-project' ? '100' : '500'}" required ${type === 'add-project' ? 'list="project-names"' : ''}></label>${type === 'add-project' ? '<datalist id="project-names"></datalist><label class="field">repository URL（任意）<input id="registration-repository" name="repositoryUrl" type="url" maxlength="500" placeholder="https://github.com/owner/repository"></label><p class="footnote">不明なら空欄で登録できます。固定の対象repositoryは、ローカル起動時に既存ghで自動取得します。</p>' : '<label class="field">Issue番号（任意）<input id="registration-issue-number" name="issueNumber" type="number" min="1" step="1" placeholder="未登録"></label>'}${type === 'add-task' ? `<label class="field">目標<select id="registration-goal" name="goalId" aria-label="目標" required>${state.goals.map(goal => `<option value="${escape(goal.id)}">${escape(goal.title)}</option>`).join('')}</select></label><label class="field">状態<select id="registration-status" name="status" aria-label="状態"><option value="unknown">未確認</option><option value="todo">未着手</option></select></label><label class="field">完了条件（任意・1行に1件）<textarea id="registration-criteria" name="criteria"></textarea></label><p class="footnote">Estimateと期限は未設定で登録します。前提や成果の根拠は作業の詳細で入力できます。</p>` : ''}<div class="form-actions"><button class="button primary" type="submit" ${store.status().readOnly ? 'disabled' : ''}>登録して保存</button></div></form>`;
    return;
  }
  if (type === 'approval-limit') {
    const project = findProject(workspace, panel.projectId), limit = projectApprovalLimit(project);
    $('#drawer-kicker').textContent = '承認待ちのPR';
    $('#drawer-title').textContent = '承認待ちの上限';
    $('#drawer-body').innerHTML = `<section class="detail-section"><p>開いているReadyのPR（承認待ちのPR）が上限に達している間、AIは新しくPRをReadyにせず、承認を待ちます。上限はこのプロジェクトだけに適用し、設定しなければ${APPROVAL_LIMIT}件です。</p><div class="approval-limit-form"><label class="field">上限（件）<input id="approval-limit" type="number" inputmode="numeric" min="1" max="${APPROVAL_LIMIT_MAX}" step="1" value="${limit}"></label>${button('上限を保存', 'save-approval-limit')}</div><p class="approval-limit-caption">現在の上限：${limit}件。1〜${APPROVAL_LIMIT_MAX}の整数で指定します。</p></section><section class="detail-section"><h3>AIに伝える</h3><p>画面の上限はAIが直接読めません。保存した上限をAIへの指示に貼って伝えてください。AIはPRをReadyにするとき、適用した上限をPRに書きます。</p><p class="approval-limit-message"><code>${escape(approvalLimitMessage(project))}</code></p>${button('伝える文をコピー', 'copy-approval-limit')}<p class="approval-limit-caption" id="approval-limit-copy-status" role="status"></p></section>`;
    return;
  }
  if (type === 'github-goals') {
    const snapshot = findProject(workspace, panel.projectId).githubSnapshot;
    $('#drawer-kicker').textContent = 'GitHubの親子Issue · 読み取り専用';
    $('#drawer-title').textContent = '目標と作業のツリー';
    $('#drawer-body').innerHTML = githubGoalTree(snapshot);
    return;
  }
  $('#drawer-kicker').textContent = { workload: '担当別の負荷', overview: '親子Issueのツリー', overdue: '期限超過の確認', iteration: 'イテレーションの対象', issue: '子Issueの内訳', reason: '着手・継続の判断と前提', task: '作業Issueの詳細', decision: '判断待ち', order: '人間が決める優先順', blockers: '前提と待っている作業', blocker: '進行を止めている作業' }[type];
  const body = $('#drawer-body');
  if (type === 'github-item') {
    const snapshot = findProject(workspace, panel.projectId).githubSnapshot;
    const item = snapshot?.items.find(item => `${item.kind}:${item.number}` === id);
    $('#drawer-kicker').textContent = 'GitHub snapshot · 読み取り専用';
    if (!item) {
      const [kind, number] = id.split(':');
      $('#drawer-title').textContent = `${kind === 'issue' ? 'Issue' : 'PR'} #${number}`;
      body.innerHTML = '<p class="empty-message">最新snapshotにこのIssue・PRは含まれていません。</p>';
      return;
    }
    $('#drawer-title').textContent = `${item.kind === 'issue' ? 'Issue' : 'PR'} #${item.number} ${item.title}`;
    body.innerHTML = `<div class="detail-meta"><span class="github-state">${escape(githubStateLabel(item))}</span>${snapshotAgeMarkup(snapshot)}</div><dl class="snapshot-facts"><dt>出典</dt><dd>${sourceLink(item.url, item.url)}</dd><dt>取得日時</dt><dd>${escape(utcTime(snapshot.fetchedAt))}</dd><dt>GitHub更新日時</dt><dd>${escape(utcTime(item.updatedAt))}</dd><dt>Closed日時</dt><dd>${item.closedAt ? escape(utcTime(item.closedAt)) : 'なし'}</dd>${item.kind === 'pull_request' ? `<dt>merge日時</dt><dd>${item.mergedAt ? escape(utcTime(item.mergedAt)) : 'なし'}</dd>` : ''}<dt>受入完了・完了条件</dt><dd>未確認</dd></dl>${item.kind === 'issue' ? githubItemPlanning(snapshot, item.number) : ''}<p class="snapshot-note">${item.kind === 'pull_request' ? 'PRのmergeは作業の受入完了を表しません。' : 'IssueのClosedは完了条件の達成を表しません。'} 成果と完了条件の確認は、手動の作業で別に記録します。</p><details class="panel-note"><summary>取得元のcollection URL</summary>${Object.values(snapshot.sources).flatMap(source => source.urls).map(url => `<p>${sourceLink(url, url)}</p>`).join('')}</details>`;
    return;
  }
  if (type === 'workload') {
    const period = state.iterations.find(i => i.id === id);
    const rows = period ? iterationWorkload(state, id, goalId || undefined) : workloadForTasks(state, orderedTasks(state, goalId || undefined).filter(t => !state.iterations.some(i => i.id === t.iterationId)));
    const row = rows.find(item => item.owner === owner);
    $('#drawer-title').textContent = `${owner || '未担当'}の未完了作業`;
    body.innerHTML = `<p class="panel-goal">${escape(period ? iterationLabel(period) : '未割当・割当未確認')}${goalId ? ` · ${escape(findGoal(state, goalId).shortTitle || findGoal(state, goalId).title)}` : ''}</p><p class="workload-detail-total">${row ? workloadPoints(row) : '0pt'}<small>残り ${row?.tasks.length || 0}件</small></p>${workloadLimitMarkup(row?.load)}${row?.tasks.length ? [['active', '作業中'], ['ready', '着手可能'], ['waiting', '待ち・確認']].filter(([key]) => row[key].tasks.length).map(([key, label]) => `<section class="detail-section workload-detail-section"><h3>${label} <span class="muted-count">${workloadPoints(row[key])}</span></h3><ul class="compact-task-list">${row[key].tasks.map(task => workloadTaskRow(task, !goalId)).join('')}</ul></section>`).join('') : '<p class="empty-message">未完了の作業はありません。</p>'}<details class="panel-note"><summary>ポイントの集計方法</summary><p>未完了のEstimate合計。作業中も全額を含みます。上限は1日1ptの目安で、実際の稼働時間や不在は表しません。</p></details>`;
    return;
  }
  if (type === 'overdue') {
    const tasks = overdueTasks(state, id || undefined);
    $('#drawer-title').textContent = '前の期間の未完了';
    body.innerHTML = `<p class="panel-goal">${tasks.length}件 · 作業を開いて、完了の確認か期間の変更を行います。</p>${tasks.length ? `<ul class="iteration-task-list">${tasks.map(t => iterationTaskRow(t, !id)).join('')}</ul>` : '<p class="empty-message">期限を超過した未完了の作業はありません。</p>'}<div class="actions">${button('期間の内訳を確認', 'iteration', id)}</div><details class="panel-note"><summary>期間を変更したときの扱い</summary><p>状態・Estimate・完了条件・優先順を保持し、割当の変更記録を残します。自動では繰り越しません。</p></details>`;
    return;
  }
  if (type === 'iteration') {
    $('#drawer-title').textContent = 'イテレーションの一覧';
    body.innerHTML = `<p class="panel-goal">${escape(id ? findGoal(state, id).title : 'すべての親Issue')}</p>${renderIterations(`drawer:${id}`, id)}<div class="actions">${button(id ? '親Issueの全体を確認' : 'すべての親Issueを確認', 'overview', id)}</div>`;
    return;
  }
  if (type === 'issue') {
    const issue = findParentIssue(state, id);
    const progress = issueProgress(state, id);
    $('#drawer-title').textContent = issue.title;
    body.innerHTML = `${issueBreadcrumbs(id)}<div class="detail-meta">${parentIssueBadge(issue)}<span>配下の作業Issue ${progress.complete}/${progress.total}件 完了</span></div><div class="overview-progress">${goalProgressMetric(progress, '登録計画の見積完了率', false, hasProvisional(orderedTasks(state).filter(task => issuePath(state, task.id).some(parent => parent.id === id))))}</div><p class="hierarchy-explanation">完了率は配下の作業IssueのEstimateから集計します。集約用のIssue自身のEstimateは加算しません。</p>${parentProgressNote(issue, progress)}<section class="detail-section"><h3>子Issue</h3>${issueTree(id)}</section><div class="actions">${button('親Issueの全体へ戻る', 'overview', issue.goalId || issue.id)}</div>`;
    return;
  }
  if (type === 'blockers' || type === 'blocker') {
    const scopeId = type === 'blockers' ? id : goalId;
    const goal = findGoal(state, scopeId);
    const rows = blockingTasks(state, scopeId);
    if (type === 'blocker') {
      const row = rows.find(r => r.id === id);
      $('#drawer-title').textContent = row?.task?.title || (row ? `未確認の前提（${id}）` : '待ちは解消されています');
      body.innerHTML = `<p class="panel-goal">${escape(goal.title)}</p>${row ? blockingDetail(row, scopeId) : '<p>この作業による前提・待ちはありません。</p>'}<div class="actions">${button('すべてのつながりへ戻る', 'blockers', scopeId)}</div>`;
    } else {
      $('#drawer-title').textContent = '進行を止めている作業のつながり';
      body.innerHTML = `<p class="panel-goal">${escape(goal.title)}</p><p class="empty-message">前提の連鎖を、途中の作業も含めて表示します。作業名を押すと、解除に必要な対応とその先で待っている作業を確認できます。</p>${rows.length ? `<ul class="blocking-overview">${rows.map(row => blockerCardRow(row, scopeId, true)).join('')}</ul>` : '<p>未完了の前提・待ちはありません。</p>'}<p class="blocking-explanation">後続の件数だけでは優先順を変えません。</p><div class="actions">${button('目標の全体を確認', 'overview', scopeId)}</div>`;
    }
    return;
  }
  if (type === 'overview') {
    const goals = id ? [findGoal(state, id)] : state.goals;
    const tasks = state.tasks.filter(t => goals.some(g => g.id === t.goalId));
    const history = state.history.filter(h => !id || h.goalId === id);
    $('#drawer-title').textContent = id ? goals[0].title : 'すべての目標';
    body.innerHTML = `${!id ? `<p class="panel-goal">${goals.length}目標 · 作業 ${tasks.length}件</p>` : ''}` + goals.map(goal => treeForGoal(goal, !id)).join('') + `<details class="panel-note"><summary>完了率の集計方法</summary><p>登録した計画作業の見積ベースの完了率であり、製品全体の成熟度ではありません。仮見積を含む割合は暫定です。全期間の作業IssueのEstimateで集計します。集約用のIssue自身のEstimateは加算しません。確認待ちは未完了です。</p></details><details class="panel-note"><summary>変更の記録 ${history.length}件</summary>${history.length ? `<ul class="history">${history.slice(0,10).map(h => `<li>${escape(h.text)}<time>${new Date(h.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</time></li>`).join('')}</ul>` : '<p>まだ変更はありません。</p>'}</details>${id ? `<div class="actions">${button('すべての親Issueを確認', 'overview')}</div>` : ''}`;
    return;
  }
  if (type === 'order') {
    const goal = findGoal(state, id); const tasks = orderedTasks(state, id);
    $('#drawer-title').textContent = '作業を進める順番';
    body.innerHTML = `<p class="panel-goal">${escape(goal.title)}</p><p class="empty-message">この目標で着手できる作業を、この順番で表示します。作業中の仕事は継続します。</p><label class="field">順番を変える理由<textarea id="order-reason" placeholder="優先順を変える根拠を記録します"></textarea></label><ul class="priority-list">${tasks.map((t,i) => `<li class="priority-row"><span>${i + 1}. ${escape(t.title)} ${badge(t)}</span><span class="priority-controls">${button('上へ', 'up', t.id, false, i === 0)}${button('下へ', 'down', t.id, false, i === tasks.length - 1)}</span></li>`).join('')}</ul>${button('目標の全体へ戻る', 'overview', id)}`;
    return;
  }
  if (type === 'decision') {
    const decision = state.decisions.find(d => d.id === id);
    const task = findTask(state, decision.taskId);
    $('#drawer-title').textContent = decision.resolved ? '判断結果' : decision.title;
    if (decision.resolved) $('#drawer-kicker').textContent = '判断結果';
    body.innerHTML = `<p class="panel-goal">${escape(findGoal(state, task.goalId).title)}</p><div class="detail-meta"><span class="badge ${decision.resolved ? 'done' : 'review'}">${decision.resolved ? '判断済み' : '判断待ち'}</span><span>担当：人間</span></div><section class="detail-section"><h3>${decision.resolved ? '判断に使った材料' : '判断材料'}</h3><p class="evidence">${escape(decision.evidence)}</p></section><section class="detail-section"><h3>${decision.resolved ? '関連する後続作業' : 'この判断を待っている作業'}</h3><ul class="dependency-list">${descendants(state, task.id).map(t => taskLink(t, t.goalId !== task.goalId)).join('') || '<li>未完了の後続作業はありません。</li>'}</ul></section>${decision.resolved ? `<section class="detail-section"><h3>判断結果</h3><p>${escape(decision.choice)}：${escape(decision.reason)}</p></section>` : `<form id="decision-form" class="detail-section"><label class="field">採用する内容<select id="decision-choice"><option value="">選択してください</option>${decision.options.map(o => `<option>${escape(o)}</option>`).join('')}</select></label><label class="field">選んだ理由<textarea id="decision-reason" placeholder="判断の根拠を記録します" required></textarea></label><div class="form-actions">${button('判断を記録して待ちを解除', 'resolve', id, true)}</div></form>`}<div class="actions">${button('目標の全体へ戻る', 'overview', task.goalId)}</div>`;
    return;
  }
  const task = findTask(state, id); const goal = findGoal(state, task.goalId);
  const block = blockers(state, task); const successors = directSuccessors(state, id);
  $('#drawer-title').textContent = task.title;
  const goalContext = issueBreadcrumbs(id) + `<p class="detail-deadline">${taskDeadline(task)}</p>`;
  if (type === 'reason') {
    const readiness = block.length ? '待ちの解消が必要' : task.status === 'active' ? '継続可能' : task.status === 'todo' ? '着手可能' : task.status === 'review' ? '成果の確認待ち' : task.status === 'done' ? '完了' : '状態未確認';
    const tasks = orderedTasks(state, goal.id);
    const otherWaits = block.filter(c => c.kind !== 'dependency' && !(c.kind === 'unknown' && task.deps.includes(c.id)));
    const decision = state.decisions.find(d => d.id === task.decisionId && !d.resolved);
    body.innerHTML = `${goalContext}<div class="detail-meta">${badge(task)}<span>${escape(readiness)}</span></div><section class="detail-section"><h3>前提作業 <span class="muted-count">${task.deps.length}件</span></h3>${task.deps.length ? `<ul class="dependency-list">${task.deps.map(dep => { const t = state.tasks.find(t => t.id === dep); return t ? taskLink(t, t.goalId !== goal.id) : `<li>前提 ${escape(dep)}：情報未確認</li>`; }).join('')}</ul>` : '<p class="empty-message">なし</p>'}</section>${otherWaits.length ? `<section class="detail-section"><h3>解消する待ち</h3><ul class="dependency-list">${otherWaits.map(c => `<li>${escape(c.text)}</li>`).join('')}</ul>${decision ? `<div class="actions">${button('判断材料を確認', 'decision', decision.id, true)}</div>` : ''}</section>` : ''}<section class="detail-section"><h3>完了すると進む作業 <span class="muted-count">${successors.length}件</span></h3>${successors.length ? `<ul class="dependency-list">${successors.map(t => taskLink(t, t.goalId !== goal.id)).join('')}</ul>` : '<p class="empty-message">なし</p>'}</section><div class="actions">${button('作業を開く', 'task', id, true)}</div><details class="panel-note"><summary>目標内の優先順 ${tasks.findIndex(t => t.id === id) + 1} / ${tasks.length}</summary><p>着手できる仕事をこの順に選びます。後続件数だけでは順番を変更しません。</p>${button('優先順を変更', 'order', goal.id)}</details>`;
    return;
  }
  const dependencyForm = `<section class="detail-section"><h3>前提作業</h3><label class="field">このプロジェクトの作業（複数選択可）<select id="task-deps" multiple class="dependency-select">${state.tasks.filter(candidate => candidate.id !== task.id).map(candidate => `<option value="${escape(candidate.id)}" ${task.deps.includes(candidate.id) ? 'selected' : ''}>${escape(candidate.title)}</option>`).join('')}</select></label>${button('前提を更新', 'dependencies', task.id)}<p class="footnote">未選択で前提なし。循環する依存関係は保存しません。</p></section>`;
  const decisionForm = task.status === 'done' || task.decisionId ? '' : `<section class="detail-section"><h3>判断待ちの登録</h3><p>仕様などが決まらず進められないときに使います。判断作業を作ってこの作業の前提にします。作業中・確認待ちの作業は未着手に戻ります。判断を記録すると判断作業が完了し、この作業の前提が解けます。</p><label class="field">判断の名前<input id="decision-title" maxlength="200" placeholder="例：保存方式を決める"></label><label class="field">選択肢（1行に1件・2件以上）<textarea id="decision-options" placeholder="例：ブラウザに保存&#10;サーバーに保存"></textarea></label><label class="field">判断材料（任意）<textarea id="decision-evidence" placeholder="比べている点、確認したこと"></textarea></label><label class="field">判断する人<input id="decision-decider" list="owner-options" maxlength="60" placeholder="未担当"></label><label class="field">判断作業のEstimate（任意）<input id="decision-estimate" type="number" inputmode="decimal" min="0" step="any" placeholder="例：0.5"></label>${button('判断待ちを登録', 'add-decision', task.id)}<p class="footnote">判断作業の担当者が判断する人になり、「自分の作業」でその人の要対応に出ます。</p></section>`;
  const estimateForm = ownerAssignment(task) + iterationAssignment(task) + `<section class="detail-section estimate-section"><h3>Estimate（ポイント）</h3><p>1ポイント＝1日を目安に、作業量を入力します。0.5などの小数も使えます。</p><div class="estimate-form"><label class="field">Estimate<input id="task-estimate" type="number" inputmode="decimal" min="0" step="any" value="${task.estimatePoints ?? ''}" placeholder="例：0.5"></label>${button('Estimateを更新', 'estimate', task.id)}</div><p class="estimate-caption">現在のEstimate：${formatEstimate(task.estimatePoints)}${estimateTag(task)}</p>${estimateRationale(task)}</section>`;
  const decision = state.decisions.find(d => d.id === task.decisionId && !d.resolved);
  body.innerHTML = `${goalContext}<div class="detail-meta">${badge(task)}<span>作業Issue · ${escape(issueReference(task))}</span><span>担当：${escape(taskOwner(task) || "未担当")}</span></div>${block.length ? `<div class="notice">${block.map(b => escape(b.text)).join('<br>')}</div>` : ''}<section class="detail-section"><h3>完了条件 <span class="criteria-progress-detail" id="criteria-progress-detail">${criteriaProgressText(task)}</span></h3><div class="criteria">${task.criteria.map((c,i) => `<label class="criterion"><input type="checkbox" data-criterion="${i}" data-id="${task.id}" ${c.checked ? 'checked' : ''} ${task.status === 'done' ? 'disabled' : ''}><span>${escape(c.text)}</span></label>`).join('')}</div>${task.status !== 'done' ? `<label class="field">完了条件の編集（1行に1件）<textarea id="task-criteria">${escape(task.criteria.map(criterion => criterion.text).join('\n'))}</textarea></label>${button('完了条件を更新', 'criteria', id)}` : ''}<p style="margin-top:10px">条件をすべて満たしたら確認待ちにし、成果を確認してから完了にします。</p></section><section class="detail-section"><h3>成果・確認の根拠</h3><p class="evidence">${escape(task.evidence || '成果の記録はまだありません。')}</p>${task.status !== 'done' ? `<label class="field">成果の記録<textarea id="task-evidence" placeholder="確認した内容や成果物の場所">${escape(task.evidence)}</textarea></label>${button('根拠を記録', 'evidence', id)}` : ''}</section><div class="actions">${decision ? button('判断材料を確認する', 'decision', decision.id, true) : task.status === 'unknown' ? button('未着手として確認', 'pause', id, true) : task.status === 'todo' ? button('作業を開始', 'start', id, true, !!block.length) : task.status === 'active' ? button('確認待ちにする', 'review', id, true, !!block.length || !task.criteria.length || !task.criteria.every(c => c.checked)) + button('作業を中断', 'pause', id) : task.status === 'review' ? button('確認して完了', 'complete', id, true, !!block.length || !task.criteria.length || !task.criteria.every(c => c.checked)) + button('作業へ戻す', 'start', id, false, !!block.length) : button('未完了に戻す', 'reopen', id)}${button('理由・前提を確認', 'reason', id)}</div>${estimateForm}${dependencyForm}${decisionForm}${task.status !== 'done' ? `<section class="detail-section"><h3>待ちの登録</h3><p>止まっている理由と、解除に必要な対応を記録します。</p><label class="field">待ちの理由<textarea id="wait-reason" placeholder="例：確認画面の表示を確かめる必要がある">${escape(task.waitReason)}</textarea></label><div class="form-actions">${button('待ちを登録', 'wait', id)}${task.waitReason ? button('待ちを解除', 'clear-wait', id) : ''}</div></section>` : ''}<div class="actions">${button('親Issueの全体へ戻る', 'overview', goal.id)}</div>`;
}
document.addEventListener('click', async event => {
  if (busy) return;
  const goalSummary = event.target.closest('.period-goal-summary');
  if (goalSummary && !event.target.closest("[data-action]")) {
    const group = goalSummary.parentElement;
    if (group.open) collapsedPeriodGoals.add(group.dataset.periodGoalKey); else collapsedPeriodGoals.delete(group.dataset.periodGoalKey);
    return;
  }
  const summary = event.target.closest('.period-summary');
  if (summary) {
    const group = summary.parentElement;
    const expanded = expandedIterations.get(group.dataset.periodScope);
    if (group.open) expanded.delete(group.dataset.periodId); else expanded.add(group.dataset.periodId);
    if (group.dataset.periodScope === 'main') updateIterationExpandButton();
    return;
  }
  const element = event.target.closest('[data-action]'); if (!element || element.disabled) return;
  const { action, id } = element.dataset;
  if (action === 'export-pending-inputs') { await exportSavedData(); return; }
  if (action === 'prepared-estimates') { await loadPreparedEstimates(); return; }
  if (action === 'prepared-workspace') { await loadPreparedWorkspace(); return; }
  if (action === 'migrate-workspace') { if (cloudMode && !store.status().readOnly) openPanel(action); return; }
  if (action.startsWith('migration-')) {
    if (!cloudMode || panel?.type !== 'migrate-workspace') return;
    try {
      if (action === 'migration-local') {
        migrationLoadSequence++; migrationData = null; migrationBackupWritten = false; renderPanel();
        migrationData = { ...store.localMigration(), name: 'このブラウザの保存' }; renderPanel();
      }
      if (action === 'migration-local-backup') downloadJson(store.localRaw(), 'progress-tool-browser-original.json');
      if (action === 'migration-backup' && migrationData) { downloadJson(migrationData.raw || migrationData.workspace, 'progress-tool-migration-original.json'); migrationBackupWritten = true; renderPanel(); }
    } catch (e) { error(`移行元を確認できません。元データは保持しています。${e.message}`); }
    return;
  }
  if (goalSummary) event.preventDefault();
  if (['manage', 'github-item', 'github-goals', 'task', 'reason', 'decision', 'overview', 'issue', 'iteration', 'overdue', 'order', 'blockers', 'blocker', 'workload', 'approval-limit'].includes(action)) { openPanel(action, id, element.dataset.goalId, element.dataset.owner || null); return; }
  if (action === 'github-owner') {
    const filter = element.dataset.githubOwnerFilter === 'all' ? { all: true } : { owner: element.dataset.githubOwnerFilter === 'none' ? null : element.dataset.ownerName };
    githubOwnerFilters.set(workspace.selectedProjectId, filter);
    writeView({ githubOwners: Object.fromEntries(githubOwnerFilters) }); render(); return;
  }
  if (action === 'import-snapshot') { if (!store.status().readOnly) openPanel(action); return; }
  if (action === 'refresh-local-github') { await localGithub.refresh({ force: true }); return; }
  if (action === 'copy-approval-limit') {
    const message = approvalLimitMessage(findProject(workspace, panel.projectId));
    // 結果は詳細の中に示す。トーストは詳細（モーダル）の背後に隠れる。
    const status = text => { const element = $('#approval-limit-copy-status'); if (element) element.textContent = text; };
    try { await navigator.clipboard.writeText(message); status('コピーしました。AIへの指示に貼ってください。'); }
    catch {
      // クリップボードの書き込みを拒否する環境では、文を選択状態にして手動のコピーを案内する。
      const sentence = $('#drawer-body .approval-limit-message code');
      if (sentence) { const range = document.createRange(); range.selectNodeContents(sentence); getSelection().removeAllRanges(); getSelection().addRange(range); }
      status('コピーできませんでした。選んだ文をCtrl+Cでコピーしてください。');
    }
    return;
  }
  if (action === 'load-bundled-snapshot') {
    if (panel?.type === 'import-snapshot' && !store.status().readOnly) await loadSnapshot(async () => {
      const response = await fetch('./github-snapshot.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('取得済みsnapshotファイルを読み込めません。');
      return response.text();
    });
    return;
  }
  if (action === 'select-project') { await switchProject(id); return; }
  if (['add-project', 'add-goal', 'add-task'].includes(action)) { if (store.status().readOnly || (action === 'add-task' && !state?.goals.length)) return; openPanel(action); return; }
  if (editingActions.has(action) && store.status().readOnly) { error(store.status().problem); return; }
  if (action === 'save-approval-limit') {
    const projectId = panel?.projectId, raw = $('#approval-limit').value.trim();
    if (!projectId || projectId !== workspace.selectedProjectId) { error('対象のプロジェクトを開き直してください。'); return; }
    await commitWorkspace(draft => setApprovalLimit(draft, projectId, /^\d+$/.test(raw) ? Number(raw) : null), '承認待ちの上限を保存しました', null, true, ['approval-limit']); return;
  }
  if (action === 'assign-owner') { const value = $('#task-owner').value; await mutate(data => setOwner(data, id, value), '担当者を保存しました', true, ['task-owner']); return; }
  if (action === 'assign-iteration') { const value = $('#task-iteration').value || null; await mutate(data => setIteration(data, id, value), 'イテレーションの割当を保存しました', true, ['task-iteration']); return; }
  if (action === 'estimate') { const input = $('#task-estimate').value.trim(); await mutate(data => setEstimate(data, id, input ? Number(input) : null), 'Estimateを保存しました', true, ['task-estimate']); return; }
  if (action === 'evidence') { const value = $('#task-evidence').value.trim(); await mutate(data => { findTask(data, id).evidence = value; }, '成果の根拠を保存しました', true, ['task-evidence']); return; }
  if (action === 'criteria') { const lines = $('#task-criteria').value.split('\n').map(line => line.trim()).filter(Boolean); await mutate(data => setTaskCriteria(data, id, lines), '完了条件を保存しました', true, ['task-criteria']); return; }
  if (action === 'dependencies') {
    const deps = [...$('#task-deps').selectedOptions].map(option => option.value);
    await mutate(data => { const task = findTask(data, id); task.deps = deps; data.history.unshift({ goalId: task.goalId, text: `${task.title}：前提作業を更新`, at: new Date().toISOString() }); }, '前提作業を保存しました', true, ['task-deps']); return;
  }
  if (action === 'resolve') { const choice = $('#decision-choice').value, reason = $('#decision-reason').value; await mutate(data => resolveDecision(data, id, choice, reason), '判断を保存しました', true, ['decision-choice', 'decision-reason']); return; }
  if (action === 'add-decision') {
    const projectId = workspace.selectedProjectId, estimate = $('#decision-estimate').value.trim();
    const input = { title: $('#decision-title').value, options: $('#decision-options').value.split('\n').map(line => line.trim()).filter(Boolean), evidence: $('#decision-evidence').value, decider: $('#decision-decider').value.trim() || null, estimatePoints: estimate ? Number(estimate) : null };
    await mutate(data => addDecision(data, projectId, id, input), '判断待ちを登録しました', true, ['decision-title', 'decision-options', 'decision-evidence', 'decision-decider', 'decision-estimate']); return;
  }
  if (action === 'wait') { const reason = $('#wait-reason').value.trim(); if (!reason) { error('待ちの理由を入力してください。'); return; } await mutate(data => setWait(data, id, reason), '待ちを保存しました', true, ['wait-reason']); return; }
  if (action === 'clear-wait') { await mutate(data => setWait(data, id, ''), '待ちの解除を保存しました', true, ['wait-reason']); return; }
  if (action === 'up' || action === 'down') {
    const reason = $('#order-reason').value; await mutate(data => reorder(data, id, action === 'up' ? -1 : 1, reason), '理由を残して優先順を保存しました');
    return;
  }
  const transitions = { start: 'active', review: 'review', complete: 'done', pause: 'todo', reopen: 'todo' };
  if (transitions[action]) await mutate(data => transition(data, id, transitions[action]), `${statusLabel(transitions[action])}として保存しました`);
});
document.addEventListener('change', async event => {
  if (!event.target.matches('[data-criterion]') || busy) return;
  const { id, criterion } = event.target.dataset;
  const checked = event.target.checked;
  if (!await mutate(data => setCriterion(data, id, Number(criterion), checked), '完了条件を保存しました') && panel) { renderPanel(); disableEditing(); error(store.status().problem); }
});
document.addEventListener('toggle', event => {
  if (event.target.matches('.period-goal-group')) {
    const group = event.target;
    if (group.open) collapsedPeriodGoals.delete(group.dataset.periodGoalKey); else collapsedPeriodGoals.add(group.dataset.periodGoalKey);
    return;
  }
  if (!event.target.matches('.period-group')) return;
  const group = event.target;
  const expanded = expandedIterations.get(group.dataset.periodScope);
  if (!expanded) return;
  if (group.open) expanded.add(group.dataset.periodId); else expanded.delete(group.dataset.periodId);
  if (group.dataset.periodScope === 'main') updateIterationExpandButton();
}, true);
$('#open-overview').addEventListener('click', () => { if (!busy && state) openPanel(githubPlan(findProject(workspace, workspace.selectedProjectId).githubSnapshot) ? 'github-goals' : 'overview'); });
$('#expand-iterations').addEventListener('click', () => {
  if (busy || !state) return;
  const expanded = expandedIterations.get('main');
  const closeAll = state.iterations.every(i => expanded.has(i.id));
  expandedIterations.set('main', new Set(closeAll ? [] : state.iterations.map(i => i.id)));
  render();
  $('#expand-iterations').focus();
});
$('#open-overdue').addEventListener('click', () => openPanel('overdue'));
$('#back-workload').addEventListener('click', () => {
  if (!busy && workloadPanel?.projectId === workspace.selectedProjectId) openPanel('workload', workloadPanel.id, workloadPanel.goalId, workloadPanel.owner);
});
$('#back-manage').addEventListener('click', () => {
  if (!busy && managementPanel?.projectId === workspace.selectedProjectId) openPanel('manage');
});
$('#close-dialog').addEventListener('click', () => { $('#detail-dialog').close(); clearPanelSession(); });
$('#detail-dialog').addEventListener('close', clearPanelSession);
$('#detail-dialog').addEventListener('click', event => { if (event.target === $('#detail-dialog') && event.offsetX < 0) $('#detail-dialog').close(); });
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.matches('[data-form]')) return;
  event.preventDefault();
  if (busy || store.status().readOnly) return;
  const fields = new FormData(form), type = form.dataset.form;
  if (type === 'apply-prepared-estimates') {
    if (!cloudMode || panel?.type !== 'prepared-estimates' || !estimateData?.confirmedChanges?.length) return;
    const { baseline, proposal, confirmedChanges } = structuredClone(estimateData);
    await commitWorkspace(draft => applyPreparedEstimates(draft, baseline, proposal, confirmedChanges), '未入力の作業に仮見積を登録しました', closePanel);
    return;
  }
  if (type === 'migrate-prepared') {
    if (!cloudMode || panel?.type !== 'prepared-workspace' || !migrationData?.prepared) return;
    const incoming = structuredClone(migrationData.workspace);
    try {
      if (!store.migrationPlan(incoming).added.length) { notify('取込済みです。追加・上書きは行いません'); closePanel(); return; }
    } catch (e) { error(e.message); return; }
    await commitWorkspace(draft => Object.assign(draft, store.migrationPlan(incoming).workspace), '3プロジェクトの記録を確認し、必要な分をクラウドに追加しました', closePanel);
    return;
  }
  if (type === 'migrate-workspace') {
    if (!cloudMode || !migrationData || !migrationBackupWritten || !$('#migration-backup-confirmed')?.checked) { error('移行元のバックアップと取込先を確認してください。'); return; }
    const incoming = structuredClone(migrationData.workspace);
    try {
      if (!store.migrationPlan(incoming).added.length) { notify('すべて同じ内容のため、追加するデータはありません'); closePanel(); return; }
    } catch (e) { error(e.message); return; }
    await commitWorkspace(draft => Object.assign(draft, store.migrationPlan(incoming).workspace), '元データを保持し、クラウドに追加しました', closePanel);
    return;
  }
  if (type === 'import-snapshot') {
    if (!snapshotCandidates) { error('snapshotファイルを読み込んでください。'); return; }
    const snapshots = structuredClone(snapshotCandidates);
    const targets = snapshots.map((_, index) => ({ projectId: fields.get(`target-${index}`) === 'new' ? null : fields.get(`target-${index}`), name: String(fields.get(`name-${index}`) || '').trim() }));
    await commitWorkspace(draft => importSnapshots(draft, snapshots, targets), 'GitHub snapshotを保存しました', finishRegistration);
    return;
  }
  const title = String(fields.get('title')).trim();
  const projectId = panel?.projectId;
  const number = fields.get('issueNumber') ? Number(fields.get('issueNumber')) : null;
  if (type === 'add-project') {
    await commitWorkspace(draft => registerProject(draft, { name: title, repositoryUrl: String(fields.get('repositoryUrl') || '').trim() || null }), 'プロジェクトを保存しました', () => { finishRegistration(); expandedIterations.clear(); collapsedPeriodGoals.clear(); });
  } else if (projectId && projectId === workspace.selectedProjectId) {
    const input = { title, issueNumber: number, goalId: fields.get('goalId'), status: fields.get('status'), criteria: String(fields.get('criteria') || '').split('\n').map(line => line.trim()).filter(Boolean) };
    await commitWorkspace(draft => updateProject(draft, projectId, data => {
      if (type === 'add-goal') addGoal(data, projectId, input);
      else if (type === 'add-task') addTask(data, projectId, input);
    }), type === 'add-goal' ? '目標を保存しました' : '作業を保存しました', finishRegistration);
  }
});
$('#project-switch').addEventListener('change', async event => {
  if (busy) { event.target.value = workspace.selectedProjectId || ''; return; }
  await switchProject(event.target.value || null);
});
async function loadSnapshot(read) {
  const origin = panel, sequence = ++snapshotLoadSequence;
  snapshotCandidates = null;
  try {
    const raw = await read();
    if (panel !== origin || sequence !== snapshotLoadSequence || store.status().readOnly) return;
    snapshotCandidates = parseSnapshotImport(raw);
    renderPanel(); disableEditing();
  } catch (e) {
    if (panel === origin && sequence === snapshotLoadSequence) { renderPanel(); disableEditing(); error(`snapshotを取り込めません。${e.message}`); }
  }
}
document.addEventListener('change', async event => {
  if (event.target.id !== 'snapshot-file' || busy || store.status().readOnly) return;
  const file = event.target.files[0];
  if (!file) { snapshotCandidates = null; renderPanel(); return; }
  await loadSnapshot(() => {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('snapshotファイルは5MiB以下にしてください。');
    return file.text();
  });
});
function downloadJson(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#export-workspace').addEventListener('click', () => downloadJson(store.snapshot(), 'progress-tool-workspace.json'));
async function exportSavedData() {
  try {
    let browserUnsavedInputs;
    if (cloudMode) {
      capturePanelDrafts();
      browserUnsavedInputs = structuredClone({
        panel, drafts: [...panelDrafts].map(([key, values]) => ({ panel: JSON.parse(key), values: Object.fromEntries(values) })),
        visibleInputs: [...$('#drawer-body').querySelectorAll('input:not([type="file"]), textarea, select')].map(input => ({ id: input.id, name: input.name, value: input.multiple ? [...input.selectedOptions].map(option => option.value) : input.value, ...(input.type === 'checkbox' ? { checked: input.checked } : {}) }))
      });
    }
    const raw = await store.raw();
    if (cloudMode) raw.browserUnsavedInputs = browserUnsavedInputs;
    downloadJson(raw, cloudMode ? 'progress-tool-cloud-backup-and-pending.json' : 'progress-tool-saved-data.json');
  } catch (e) { error(e.message); }
}
$('#export-raw').addEventListener('click', exportSavedData);
$('#export-cloud-backup').addEventListener('click', exportSavedData);
function reloadWorkspace() {
  if (busy) return;
  if (cloudMode && ($('#detail-dialog').open || store.status().hasPending) && !window.confirm('変更候補・未保存入力を退避してください。再読み込みすると、端末に残る変更候補と未保存入力を破棄します。続けますか？')) return;
  location.reload();
}
$('#refresh-cloud').addEventListener('click', reloadWorkspace);
$('#reload-workspace').addEventListener('click', reloadWorkspace);
async function recover(replacement) {
  if (busy) return;
  busy = true;
  try {
    await exclusive(() => store.recover(replacement));
    viewProjectId = undefined; closePanel(); expandedIterations.clear(); collapsedPeriodGoals.clear(); render(); notify('元データを退避し、復旧しました');
  } catch (e) { render(); error(e.message); }
  finally { busy = false; }
}
$('#recover-backup').addEventListener('click', () => recover());
$('#recovery-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (file) { try { await recover(JSON.parse(await file.text())); } catch (e) { error(`復旧用JSONを確認してください。${e.message}`); } }
  event.target.value = '';
});
window.addEventListener('storage', event => {
  if (cloudMode) return;
  if (event.storageArea === storage && (event.key === STORAGE_KEY || event.key === null)) { store.markStale(); render(); disableEditing(); error(store.status().problem); }
});
const localGithub = createLocalGithubClient({
  getWorkspace: () => store.snapshot(),
  canRefresh: () => !cloudMode && !busy && !store.status().readOnly && document.visibilityState === 'visible',
  onState: renderLocalGithubStatus,
  saveSnapshot: (snapshot, targets) => exclusive(() => {
    if (cloudMode || busy || store.status().readOnly) return null;
    try {
      // Re-read after gh finishes; concurrent manual edits must be preserved.
      const count = applyRefreshedSnapshot(store.snapshot(), snapshot, targets);
      if (count) {
        store.transact(draft => applyRefreshedSnapshot(draft, snapshot, targets));
        // Refresh read-only GitHub views; preserve manual drawers and drafts.
        render();
        if (['github-item', 'github-goals', 'manage'].includes(panel?.type) && targets.includes(panel.projectId)) { renderPanel(); disableEditing(); }
      }
      return count;
    } catch (error) { render(); disableEditing(); throw error; }
  }),
});
document.querySelector('.view-tabs').addEventListener('click', event => {
  const tab = event.target.closest('.view-tab'); if (tab && !busy && state) selectView(tab.dataset.view);
});
document.querySelector('.view-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy || !state) return;
  const tabs = [...document.querySelectorAll('.view-tab:not([hidden])')], index = tabs.findIndex(tab => tab.dataset.view === viewTab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault(); selectView(tabs[next].dataset.view, true);
});
$('#release-panel').addEventListener('click', event => {
  const go = event.target.closest('[data-view-go]'); if (go && !busy && state) selectView(go.dataset.viewGo);
});
$('#attention-panel').addEventListener('click', event => {
  const choice = event.target.closest('[data-attention-me]'); if (!choice || busy || !state) return;
  const owner = choice.dataset.attentionMe, id = workspace.selectedProjectId;
  if (attentionMe.get(id) === owner) attentionMe.delete(id); else attentionMe.set(id, owner);
  writeView({ attentionMe: Object.fromEntries(attentionMe) }); render();
  [...document.querySelectorAll('[data-attention-me]')].find(button => button.dataset.attentionMe === owner)?.focus();
});
$('#my-work-panel').addEventListener('click', event => {
  const choice = event.target.closest('[data-owner-filter]'); if (!choice || busy || !state) return;
  const selected = ownerFilterFromButton(choice);
  ownerFilters.set(workspace.selectedProjectId, selected);
  writeView({ owners: Object.fromEntries(ownerFilters) }); render();
  [...document.querySelectorAll('[data-owner-filter]')].find(button => sameOwnerFilter(ownerFilterFromButton(button), selected))?.focus();
});
render();
registerProgressTools(document.modelContext, store);
if (cloudMode) store.initialize().then(() => render());
document.addEventListener('change', async event => {
  if (event.target.id !== 'migration-file' || busy || !cloudMode || store.status().readOnly) return;
  const file = event.target.files[0], origin = panel, sequence = ++migrationLoadSequence;
  migrationData = null; migrationBackupWritten = false; renderPanel();
  if (!file) return;
  try {
    if (file.size > MAX_CLOUD_BYTES * 2) throw new Error('移行元ファイルは12MiB以下にしてください。');
    const parsed = JSON.parse(await file.text());
    if (panel !== origin || panel?.type !== 'migrate-workspace' || sequence !== migrationLoadSequence || store.status().readOnly) return;
    const raw = typeof parsed?.primary === 'string' ? parsed : null;
    migrationData = { workspace: raw ? JSON.parse(raw.primary) : parsed, raw, name: file.name };
    migrationBackupWritten = false; renderPanel();
  } catch (e) { if (panel === origin && sequence === migrationLoadSequence) error(`移行元JSONを確認してください。${e.message}`); }
});
if (!cloudMode && isLocalRuntime(location)) {
  localGithub.connect().then(connected => { if (connected) { render(); localGithub.refresh(); } });
  setInterval(() => localGithub.refresh({ force: true }), REFRESH_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') localGithub.refresh(); });
}
setInterval(() => document.querySelectorAll('.snapshot-age[data-fetched-at]').forEach(element => {
  const age = snapshotAge({ fetchedAt: element.dataset.fetchedAt });
  element.textContent = age.label; element.classList.toggle('stale', age.stale);
}), 60000);
