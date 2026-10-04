export function createSample() {
  const sampleEstimates = { read: 0.5, timeline: 1, preview: 2, move: 3, multi: 1, delete: 1, format: 0.5, save: 2, restore: 1, check: 1,
    'notice-sort': 0.5, 'notice-format': 1.5, 'notice-register': 0.5, 'notice-check': 0.5, 'guide-check': 0.5, 'guide-write': 1, 'guide-review': 0.5 };
  const sampleParents = { read: 'ui-design', timeline: 'ui-design', preview: 'ui-design', move: 'ui-layout', multi: 'ui-layout', delete: 'ui-tools',
    format: 'ui-export', save: 'ui-export', restore: 'ui-export', check: 'ui-export', 'notice-sort': 'notice-style', 'notice-format': 'notice-settings',
    'notice-register': 'notice-settings', 'notice-check': 'notice-settings', 'guide-check': 'guide', 'guide-write': 'guide-content', 'guide-review': 'guide-content' };
  const sampleNumbers = { read: 1002, timeline: 1003, preview: 1004, move: 1005, multi: 1006, delete: 1007, format: 1008, save: 1009, restore: 1010, check: 1011,
    'notice-sort': 1102, 'notice-format': 1103, 'notice-register': 1104, 'notice-check': 1105, 'guide-check': 1202, 'guide-write': 1203, 'guide-review': 1204 };
  const sampleIterations = { read: 'i4', timeline: 'i4', preview: 'i4', move: 'i5', multi: 'i5', delete: 'i4', format: 'i5', save: 'i6', restore: 'i6', check: 'i6',
    'notice-sort': 'i4', 'notice-format': 'i5', 'notice-register': 'i5', 'notice-check': 'i6', 'guide-check': 'i5', 'guide-write': 'i5', 'guide-review': 'i6' };
  const task = (id, title, group, status, deps, conditions, extra = {}) => ({
    id, title, group, status, deps, goalId: 'ui', owner: extra.goalId === 'notice' ? '協力者A' : extra.goalId === 'guide' || id === 'check' ? '協力者B' : '自分', waitReason: '', evidence: '', estimatePoints: sampleEstimates[id] ?? null,
    parentId: sampleParents[id], issueNumber: sampleNumbers[id],
    iterationId: sampleIterations[id],
    criteria: conditions.map((text, i) => ({ text, checked: status === 'done' || status === 'review' || (status === 'active' && i === 0) })), ...extra
  });
  return {
    project: '予約管理アプリ（集計用サンプル）',
    iterations: [
      { id: 'i4', title: 'I4', startDate: '2026-09-14', durationDays: 14 },
      { id: 'i5', title: 'I5', startDate: '2026-09-28', durationDays: 14 },
      { id: 'i6', title: 'I6', startDate: '2026-10-12', durationDays: 14 }
    ],
    goals: [
      { id: 'ui', shortTitle: '予約フォーム', title: '予約フォームを利用者が使えるようにする', issueNumber: 1001, issueState: 'open' },
      { id: 'notice', shortTitle: '通知', title: '予約の変更を利用者へ通知できるようにする', issueNumber: 1101, issueState: 'open' },
      { id: 'guide', shortTitle: '導入手順', title: '配布用の導入手順を整える', issueNumber: 1201, issueState: 'open' }
    ],
    parentIssues: [
      { id: 'ui-design', goalId: 'ui', parentId: 'ui', title: '入力項目', issueNumber: 1020, issueState: 'closed' },
      { id: 'ui-tools', goalId: 'ui', parentId: 'ui', title: '入力画面', issueNumber: 1021, issueState: 'open' },
      { id: 'ui-layout', goalId: 'ui', parentId: 'ui-tools', title: '配置を調整して保存する', issueNumber: 1022, issueState: 'open' },
      { id: 'ui-export', goalId: 'ui', parentId: 'ui', title: 'データ出力', issueNumber: 1023, issueState: 'open' },
      { id: 'notice-style', goalId: 'notice', parentId: 'notice', title: '通知文の準備', issueNumber: 1120, issueState: 'closed' },
      { id: 'notice-settings', goalId: 'notice', parentId: 'notice', title: '通知の設定', issueNumber: 1121, issueState: 'open' },
      { id: 'guide-content', goalId: 'guide', parentId: 'guide', title: '執筆・確認', issueNumber: 1220, issueState: 'open' }
    ],
    tasks: [
      task('read', '入力項目の読み込み', '入力項目', 'done', [], ['入力項目を読み込める', '項目名と入力形式を確認できる'], { evidence: '架空の予約項目で読み込みを確認済み。' }),
      task('timeline', '入力領域の整理', '入力項目', 'done', ['read'], ['入力欄と案内文の領域を決める', '画面内に収まる寸法を決める'], { evidence: '入力欄と案内文の配置案を確認済み。' }),
      task('preview', '確認画面の表示', '入力項目', 'done', ['timeline'], ['予約項目を表示できる', '入力欄と案内文の仮配置を表示できる'], { evidence: '架空の予約項目と案内文で表示を確認済み。' }),
      task('move', '入力欄の配置を調整する', '入力画面', 'active', ['preview'], ['画面上で入力欄の位置を変えられる', '位置を変えても案内文がずれない'], { evidence: '入力欄の移動は動作済み。案内文の追従を確認中。' }),
      task('multi', '入力設定の保存', '入力画面', 'todo', ['move'], ['調整した位置を保存できる', '開き直して同じ配置を再現できる']),
      task('delete', '案内文の見え方の調整', '入力画面', 'review', ['preview'], ['長い案内文が表示領域に収まる', '背景に重なっても文字を読める'], { evidence: '短文・長文のサンプルで調整済み。見た目の確認を待っている。' }),
      task('format', '出力形式を決める', 'データ出力', 'todo', [], ['書き出す項目を決める', '形式を選んだ理由を記録する'], { decisionId: 'save-format' }),
      task('save', '予約データの出力', 'データ出力', 'todo', ['format', 'multi'], ['入力内容と項目名を出力できる', '出力に不足する情報がない']),
      task('restore', '管理画面への組み込み', 'データ出力', 'todo', ['save'], ['管理画面で予約情報を表示できる', '確認画面と表示内容が一致する']),
      task('check', '予約手順の通し確認', 'データ出力', 'todo', ['restore', 'delete'], ['入力・確認・送信の切り替えを確認する', '残っている不具合を記録する']),
      task('notice-sort', '通知文の整理', '通知文の準備', 'done', [], ['使う通知文を一覧にする', '通知を送る条件を確認する'], { goalId: 'notice', evidence: '受付・変更・取消の通知文を整理した架空の例。' }),
      task('notice-format', '通知の見え方を揃える', '通知の設定', 'active', ['notice-sort'], ['通知ごとの表記の差を抑える', 'ほかの案内と重なっても読み取れる'], { goalId: 'notice', evidence: '受付と取消の通知は調整済み。ほかの案内と並べた表示を確認中。' }),
      task('notice-register', '通知文を登録する', '通知の設定', 'todo', ['notice-format'], ['整理した通知文を登録する', '予約の状態から指定できる'], { goalId: 'notice' }),
      task('notice-check', '通知の表示を確認する', '通知の設定', 'todo', ['notice-register'], ['状態に合った通知が表示される', '連続表示でも案内を読める'], { goalId: 'notice' }),
      task('guide-check', '起動手順の確認', '手順の確認', 'done', [], ['必要なファイルを確認する', '初回起動の手順を実行する'], { goalId: 'guide', evidence: '試作用の環境で起動手順を確認した架空の例。' }),
      task('guide-write', '導入手順を書く', '執筆・確認', 'todo', ['guide-check'], ['準備から起動までの操作を書く', '困ったときの確認方法を書く'], { goalId: 'guide' }),
      task('guide-review', '初めて使う人に確認してもらう', '執筆・確認', 'todo', ['guide-write'], ['手順だけで起動まで進められる', '分かりにくい説明を直す'], { goalId: 'guide' })
    ],
    order: ['read', 'timeline', 'preview', 'move', 'multi', 'delete', 'format', 'save', 'restore', 'check', 'notice-sort', 'notice-format', 'notice-register', 'notice-check', 'guide-check', 'guide-write', 'guide-review'],
    decisions: [{ id: 'save-format', title: '出力形式が未決定', taskId: 'format', resolved: false, choice: '', reason: '', evidence: 'CSVとJSONで予約データを書き出す案を比較中。項目の扱いを確認してから選ぶ。ここに示す判断材料は架空の例である。', options: ['CSV', 'JSON'] }],
    history: []
  };
}
export function findTask(state, id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) throw new Error('作業が見つかりません。');
  return task;
}
export function findGoal(state, id) {
  const goal = state.goals.find(g => g.id === id);
  if (!goal) throw new Error('目標が見つかりません。');
  return goal;
}
export function blockers(state, task) {
  const result = [];
  if (task.status === 'unknown') result.push({ kind: 'unknown', text: '作業の状態が未確認です。' });
  if (task.waitReason) result.push({ kind: 'wait', text: task.waitReason });
  for (const id of task.deps) {
    const dependency = state.tasks.find(t => t.id === id);
    if (!dependency || dependency.status !== 'done') {
      const goalName = dependency && dependency.goalId !== task.goalId ? `${findGoal(state, dependency.goalId).title} / ` : '';
      result.push({ kind: 'dependency', id, text: dependency ? `${goalName}${dependency.title}：${statusLabel(dependency.status)}` : '前提作業の情報が未確認です。' });
    }
  }
  const decision = state.decisions.find(d => d.id === task.decisionId && !d.resolved);
  if (decision) result.push({ kind: 'decision', id: decision.id, text: decision.title });
  return result;
}
export const statusLabel = status => ({ todo: '未着手', active: '作業中', review: '確認待ち', done: '完了', unknown: '未確認' }[status] || '未確認');
export function orderedTasks(state, goalId) {
  if (goalId !== undefined) findGoal(state, goalId);
  return state.order.map(id => state.tasks.find(t => t.id === id)).filter(t => t && (goalId === undefined || issuePath(state, t.id)[0].id === goalId));
}
const percentOf = (count, total) => {
  if (!total) return null;
  if (count === total) return 100;
  const ratio = count * 100 / total;
  return Math.floor(ratio + Number.EPSILON * Math.max(1, Math.abs(ratio)) * 4);
};
const hasEstimate = task => Number.isFinite(task.estimatePoints) && task.estimatePoints > 0;
function progressOf(tasks) {
  const completed = tasks.filter(t => t.status === 'done');
  const missingEstimates = tasks.filter(t => !hasEstimate(t)).length;
  const totalPoints = tasks.length && !missingEstimates ? tasks.reduce((sum, t) => sum + t.estimatePoints, 0) : null;
  const completePoints = completed.every(hasEstimate) ? completed.reduce((sum, t) => sum + t.estimatePoints, 0) : null;
  const percent = percentOf(completePoints, totalPoints);
  return { total: tasks.length, complete: completed.length, missingEstimates, totalPoints, completePoints,
    percent: percent === null || completed.length === tasks.length ? percent : Math.min(99, percent) };
}
export function goalProgress(state, goalId) {
  return progressOf(orderedTasks(state, goalId));
}
export function findParentIssue(state, id) {
  const issue = state.goals.find(g => g.id === id) || state.parentIssues?.find(p => p.id === id);
  if (!issue) throw new Error('親Issueが見つかりません。');
  return issue;
}
export function issueChildren(state, id) {
  findParentIssue(state, id);
  return [
    ...(state.parentIssues || []).filter(p => p.parentId === id).map(issue => ({ kind: 'parent', issue })),
    ...orderedTasks(state).filter(t => (t.parentId ?? t.goalId) === id).map(issue => ({ kind: 'task', issue }))
  ];
}
export function issuePath(state, id) {
  let issue = state.tasks.find(t => t.id === id) || findParentIssue(state, id);
  const path = [];
  const seen = new Set();
  while (issue) {
    if (seen.has(issue.id)) throw new Error('親子Issueの関係が循環しています。');
    seen.add(issue.id); path.unshift(issue);
    if (state.goals.some(g => g.id === issue.id)) break;
    issue = findParentIssue(state, issue.parentId ?? issue.goalId);
  }
  return path;
}
export function issueProgress(state, id) {
  const issue = findParentIssue(state, id);
  if (state.goals.some(g => g.id === id)) return goalProgress(state, id);
  const tasks = orderedTasks(state).filter(t => issuePath(state, t.id).some(p => p.id === id));
  return progressOf(tasks);
}
const dayMilliseconds = 86400000;
function dateIndex(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) return null;
  return milliseconds / dayMilliseconds;
}
export function todayInTokyo(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function iterationTiming(iteration, today = todayInTokyo()) {
  const start = dateIndex(iteration?.startDate);
  const current = dateIndex(today);
  const duration = iteration?.durationDays;
  if (start === null || current === null || !Number.isSafeInteger(duration) || duration <= 0) {
    return { startDate: null, endDate: null, daysLeft: null, phase: 'unknown' };
  }
  const end = start + duration - 1;
  const endMilliseconds = end * dayMilliseconds;
  if (!Number.isFinite(endMilliseconds) || !Number.isFinite(new Date(endMilliseconds).getTime())) {
    return { startDate: null, endDate: null, daysLeft: null, phase: 'unknown' };
  }
  const endDate = new Date(endMilliseconds).toISOString().slice(0, 10);
  if (dateIndex(endDate) === null) return { startDate: null, endDate: null, daysLeft: null, phase: 'unknown' };
  return { startDate: iteration.startDate, endDate, daysLeft: end - current,
    phase: current < start ? 'upcoming' : current > end ? 'past' : 'active' };
}
export function taskTiming(state, task, today = todayInTokyo()) {
  const iteration = state.iterations?.find(i => i.id === task.iterationId);
  if (!iteration) return { iteration: null, startDate: null, endDate: null, daysLeft: null, phase: task.iterationId ? 'unknown' : 'unassigned' };
  return { iteration, ...iterationTiming(iteration, today) };
}
export function periodGoalDeadline(state, tasks, today = todayInTokyo()) {
  if (!tasks.length) return null;
  const timings = tasks.map(task => ({ task, timing: taskTiming(state, task, today) }));
  const endDate = timings.every(({ timing }) => timing.endDate)
    ? timings.map(({ timing }) => timing.endDate).sort().at(-1) : null;
  const overdue = timings.some(({ task, timing }) => task.status !== 'done' && timing.phase === 'past');
  return endDate && !overdue ? null : { endDate, overdue };
}
export function overdueTasks(state, goalId, today = todayInTokyo()) {
  return orderedTasks(state, goalId).filter(task => task.status !== 'done' && taskTiming(state, task, today).phase === 'past');
}
function workSummary(tasks) {
  const remainingTasks = tasks.filter(t => t.status !== 'done');
  const remainingPoints = remainingTasks.every(hasEstimate) ? remainingTasks.reduce((sum, t) => sum + t.estimatePoints, 0) : null;
  return { tasks, remainingTasks, remainingPoints, progress: progressOf(tasks) };
}
export function iterationWork(state, iterationId, goalId) {
  const iteration = state.iterations?.find(i => i.id === iterationId);
  if (!iteration) throw new Error('イテレーションが見つかりません。');
  const tasks = orderedTasks(state, goalId).filter(t => t.iterationId === iterationId);
  return { iteration, ...workSummary(tasks) };
}
export function groupTasksByGoal(state, tasks) {
  const byGoal = new Map();
  for (const task of tasks) {
    const goalId = issuePath(state, task.id)[0].id;
    if (!byGoal.has(goalId)) byGoal.set(goalId, []);
    byGoal.get(goalId).push(task);
  }
  return state.goals.filter(goal => byGoal.has(goal.id)).map(goal => ({ goal, ...workSummary(byGoal.get(goal.id)) }));
}
export function taskOwner(task) {
  return typeof task.owner === 'string' && task.owner.trim() ? task.owner.trim() : null;
}
function workloadBucket(tasks) {
  const missingEstimates = tasks.filter(t => !hasEstimate(t)).length;
  const knownPoints = tasks.filter(hasEstimate).reduce((sum, t) => sum + t.estimatePoints, 0);
  return { tasks, missingEstimates, knownPoints, points: missingEstimates ? null : knownPoints };
}
export function workloadForTasks(state, tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const owner = taskOwner(task);
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(task);
  }
  return [...groups].map(([owner, assigned]) => {
    const remaining = assigned.filter(t => t.status !== 'done');
    const active = [], ready = [], waiting = [];
    for (const task of remaining) {
      if (blockers(state, task).length) waiting.push(task);
      else if (task.status === 'active') active.push(task);
      else if (task.status === 'todo') ready.push(task);
      else waiting.push(task);
    }
    return { owner, assigned, ...workloadBucket(remaining), active: workloadBucket(active), ready: workloadBucket(ready), waiting: workloadBucket(waiting) };
  });
}
export function iterationWorkload(state, iterationId, goalId) {
  return workloadForTasks(state, iterationWork(state, iterationId, goalId).tasks);
}
export function criteriaProgress(task) {
  const achieved = task.criteria.filter(c => c.checked === true).length;
  return { total: task.criteria.length, achieved, percent: percentOf(achieved, task.criteria.length) };
}
export function availableTasks(state, goalId) { return orderedTasks(state, goalId).filter(t => t.status === 'todo' && !blockers(state, t).length); }
export function nextWork(state, goalId = state.goals[0]?.id) {
  const tasks = orderedTasks(state, goalId);
  const active = tasks.filter(t => t.status === 'active');
  const ready = availableTasks(state, goalId);
  if (active.length) return { task: active[0], active, ready, reason: 'この目標で作業中の仕事を継続します。優先順を変えても作業中の仕事は切り替えません。', mode: 'active' };
  if (ready.length) return { task: ready[0], active, ready, reason: '前提が完了していて、待ちがありません。この目標で着手できる作業の中で、設定した優先順が最も上です。', mode: 'ready' };
  if (!tasks.length) return { task: null, active, ready, reason: 'この目標には作業が登録されていません。', mode: 'empty' };
  if (tasks.every(t => t.status === 'done')) return { task: null, active, ready, reason: 'この目標のすべての完了条件を確認しました。', mode: 'complete' };
  return { task: null, active, ready, reason: 'この目標で着手できる作業がありません。確認待ちと未完了の前提を確認してください。', mode: 'blocked' };
}
export function descendants(state, id) {
  const found = new Set();
  const visit = parent => { for (const task of state.tasks) if (task.deps.includes(parent) && task.id !== id && !found.has(task.id)) { found.add(task.id); visit(task.id); } };
  visit(id);
  return state.tasks.filter(t => found.has(t.id) && t.status !== 'done');
}
export function directSuccessors(state, id) { return state.tasks.filter(t => t.deps.includes(id) && t.status !== 'done'); }
export function blockingTasks(state, goalId) {
  findGoal(state, goalId);
  const pending = state.tasks.filter(t => t.status !== 'done');
  const downstream = id => {
    const found = new Set([id]);
    const visit = parent => {
      for (const task of pending) if (task.deps.includes(parent) && !found.has(task.id)) {
        found.add(task.id); visit(task.id);
      }
    };
    visit(id); found.delete(id);
    return pending.filter(t => found.has(t.id));
  };
  const candidates = orderedTasks(state).filter(t => t.status !== 'done').map(task => ({ id: task.id, task }));
  const missing = [...new Set(pending.flatMap(t => t.deps).filter(id => !state.tasks.some(t => t.id === id)))];
  candidates.push(...missing.map(id => ({ id, task: null })));
  return candidates.flatMap(({ id, task }) => {
    const causes = task ? blockers(state, task) : [{ kind: 'unknown', text: '前提作業の情報が未確認です。' }];
    const ownWait = causes.some(c => c.kind !== 'dependency');
    const all = downstream(id);
    const affected = all.filter(t => t.goalId === goalId);
    if (!affected.length && !(task?.goalId === goalId && ownWait)) return [];
    const direct = all.filter(t => t.deps.includes(id));
    return [{ id, task, causes, direct, indirect: all.filter(t => !t.deps.includes(id)), affected,
      root: ownWait || !causes.some(c => c.kind === 'dependency') }];
  });
}
function record(state, text, goalId) { state.history.unshift({ text, goalId, at: new Date().toISOString() }); }
export function setOwner(state, id, owner) {
  const task = findTask(state, id);
  if (owner !== null && typeof owner !== 'string') throw new Error('担当者名を確認してください。');
  const next = owner?.trim() || null;
  if (next?.length > 60) throw new Error('担当者名は60文字以内で入力してください。');
  const previous = taskOwner(task);
  if (previous === next) return;
  task.owner = next;
  record(state, `${task.title}：担当を変更（${previous || '未担当'} → ${next || '未担当'}）`, task.goalId);
}
export function setIteration(state, id, iterationId) {
  const task = findTask(state, id);
  const iteration = state.iterations?.find(i => i.id === iterationId);
  if (iterationId !== null && !iteration) throw new Error('割り当てるイテレーションを確認してください。');
  if ((task.iterationId ?? null) === iterationId) return;
  const previous = state.iterations?.find(i => i.id === task.iterationId);
  task.iterationId = iterationId;
  record(state, `${task.title}：イテレーションの割当を変更（${previous?.title || '未割当'} → ${iteration?.title || '未割当'}）`, task.goalId);
}
export function setEstimate(state, id, points) {
  const task = findTask(state, id);
  if (points !== null && (!Number.isFinite(points) || points <= 0)) throw new Error('Estimateは0より大きい数値で入力してください。0.5などの小数も使えます。');
  if (task.estimatePoints === points) return;
  const previous = task.estimatePoints;
  task.estimatePoints = points;
  if (task.estimateProvenance?.source === 'prepared-estimates-2026-10-04-v1') delete task.estimateProvenance;
  record(state, `${task.title}：Estimateを変更（${previous == null ? '未入力' : `${previous}pt`} → ${points === null ? '未入力' : `${points}pt`}）`, task.goalId);
}
export function transition(state, id, status) {
  const task = findTask(state, id);
  if (!['todo', 'active', 'review', 'done'].includes(status)) throw new Error('状態を確認してください。');
  if (status === task.status) return;
  if (status !== 'todo' && blockers(state, task).length) throw new Error('未完了の前提・待ちを先に解消してください。');
  if (status === 'review' && task.status !== 'active') throw new Error('作業を開始してから確認待ちにしてください。');
  if (status === 'done' && task.status !== 'review') throw new Error('確認待ちにしてから完了を確認してください。');
  if (status === 'done' && !task.criteria.every(c => c.checked)) throw new Error('すべての完了条件を確認してください。');
  const previous = statusLabel(task.status);
  task.status = status;
  if (status === 'todo' && previous === '完了') task.criteria.forEach(c => { c.checked = false; });
  record(state, `${task.title}：${previous} → ${statusLabel(status)}`, task.goalId);
}
export function setCriterion(state, id, index, checked) {
  const task = findTask(state, id);
  if (task.status === 'done') throw new Error('完了した作業は、未完了に戻してから条件を変更してください。');
  if (!task.criteria[index] || typeof checked !== 'boolean') throw new Error('完了条件を確認してください。');
  task.criteria[index].checked = checked;
}
export function setWait(state, id, reason) {
  const task = findTask(state, id);
  if (task.status === 'done') throw new Error('完了した作業には待ちを登録できません。');
  if (typeof reason !== 'string') throw new Error('待ちの理由を確認してください。');
  task.waitReason = reason.trim();
  record(state, `${task.title}：${task.waitReason ? `待ちを登録（${task.waitReason}）` : '待ちを解除'}`, task.goalId);
}
export function reorder(state, id, delta, reason) {
  if (!reason?.trim()) throw new Error('順番を変える理由を入力してください。');
  const task = findTask(state, id);
  const ids = orderedTasks(state, task.goalId).map(t => t.id);
  const index = ids.indexOf(id);
  const target = index + delta;
  if (![-1, 1].includes(delta) || index < 0 || target < 0 || target >= ids.length) throw new Error('移動先を確認してください。');
  const sourceIndex = state.order.indexOf(id);
  const targetIndex = state.order.indexOf(ids[target]);
  [state.order[sourceIndex], state.order[targetIndex]] = [state.order[targetIndex], state.order[sourceIndex]];
  record(state, `優先順を変更：${task.title}（${reason.trim()}）`, task.goalId);
}
export function resolveDecision(state, id, choice, reason) {
  const decision = state.decisions.find(d => d.id === id);
  if (!decision || decision.resolved || !decision.options.includes(choice)) throw new Error('判断する項目を確認してください。');
  if (!reason?.trim()) throw new Error('選んだ理由を入力してください。');
  const task = findTask(state, decision.taskId);
  if (task.waitReason || task.deps.some(id => state.tasks.find(t => t.id === id)?.status !== 'done')) throw new Error('判断作業の前提・待ちを先に解消してください。');
  decision.resolved = true; decision.choice = choice; decision.reason = reason.trim();
  task.criteria.forEach(c => { c.checked = true; }); task.status = 'done';
  task.evidence = `${choice}を採用。理由：${reason.trim()}`;
  record(state, `${task.title}：${choice}（${reason.trim()}）`, task.goalId);
}
// 自分の作業：一つの作業を要対応 → 確認待ち → 作業中 → 前提待ち → 着手可能の順に判定し、最初に当たったまとまりへ入れる。
export const workGroupLabel = group => ({ action: '要対応', review: '確認待ち', active: '作業中', waiting: '前提待ち', ready: '着手可能' }[group]);
export function currentIterations(state, today = todayInTokyo()) {
  const dated = state.iterations.map(iteration => ({ iteration, timing: iterationTiming(iteration, today) }));
  const active = dated.filter(({ timing }) => timing.phase === 'active');
  if (active.length) return active.map(({ iteration }) => iteration);
  const next = dated.filter(({ timing }) => timing.phase === 'upcoming').sort((a, b) => a.timing.startDate.localeCompare(b.timing.startDate))[0];
  return next ? [next.iteration] : [];
}
export function currentIteration(state, today = todayInTokyo()) {
  return currentIterations(state, today)[0] || null;
}
export function workCategory(state, task, today = todayInTokyo()) {
  if (task.status === 'done') return null;
  const openDeps = task.deps.map(id => state.tasks.find(t => t.id === id)).filter(dep => !dep || dep.status !== 'done');
  const depName = dep => dep ? dep.title : '前提作業の情報が未確認';
  const reasons = [];
  if (task.status === 'unknown') reasons.push('状態が未確認');
  if (task.waitReason) reasons.push(`待ち：${task.waitReason}`);
  const decision = state.decisions.find(d => d.id === task.decisionId && !d.resolved);
  if (decision) reasons.push(`判断待ち：${decision.title}`);
  const timing = taskTiming(state, task, today);
  if (timing.phase === 'past') reasons.push(`期限超過（${-timing.daysLeft}日）`);
  for (const dep of openDeps) if (!dep || taskTiming(state, dep, today).phase === 'past') reasons.push(`前提が期限超過：${depName(dep)}`);
  if (task.status === 'active' && !taskOwner(task)) reasons.push('作業中なのに担当者がいない');
  if (task.status === 'active') for (const dep of openDeps) reasons.push(`作業中なのに前提が未完了：${depName(dep)}`);
  if (reasons.length) return { group: 'action', reasons };
  if (task.status === 'review') return { group: 'review', reasons: [] };
  if (task.status === 'active') return { group: 'active', reasons: [] };
  if (openDeps.length) return { group: 'waiting', reasons: openDeps.map(dep => `前提：${depName(dep)}（${statusLabel(dep.status)}）`) };
  return { group: 'ready', reasons: [] };
}
// owner: undefined は全員、null は未担当、文字列はその担当者。表示順は作業中を先頭に置く。
export function myWork(state, owner, today = todayInTokyo()) {
  const current = currentIteration(state, today);
  const sections = [['active', '作業中'], ['action', '要対応'], ['review', '確認待ち'], ['ready-now', '着手可能（今の期間）'], ['ready-later', '着手可能（先の期間・未割当・期間不明）'], ['waiting', '前提待ち']]
    .map(([id, title]) => ({ id, title, tasks: [] }));
  const byId = new Map(sections.map(section => [section.id, section]));
  for (const task of orderedTasks(state)) {
    if (owner !== undefined && taskOwner(task) !== owner) continue;
    const category = workCategory(state, task, today);
    if (!category) continue;
    const id = category.group !== 'ready' ? category.group : current && task.iterationId === current.id ? 'ready-now' : 'ready-later';
    byId.get(id).tasks.push({ task, reasons: category.reasons });
  }
  return { current, sections: sections.filter(section => section.tasks.length) };
}
export function needsAction(state, today = todayInTokyo()) {
  return orderedTasks(state).filter(task => workCategory(state, task, today)?.group === 'action');
}
