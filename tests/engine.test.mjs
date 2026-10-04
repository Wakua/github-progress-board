import test from 'node:test';
import assert from 'node:assert/strict';
import { iterationWorkload, workloadForTasks, taskOwner, setOwner, groupTasksByGoal, periodGoalDeadline, currentIterations } from '../dist/engine.mjs';
import { createSample, nextWork, orderedTasks, goalProgress, criteriaProgress, issueChildren, issuePath, issueProgress, iterationTiming, taskTiming, iterationWork, overdueTasks, todayInTokyo, setIteration, availableTasks, blockers, blockingTasks, transition, setWait, setEstimate, reorder, resolveDecision, setCriterion, descendants } from '../dist/engine.mjs';

test('期間と同日の作業期限は今日までを含めて隠し、未完了の超過時だけ残す', () => {
  const state = createSample();
  const tasks = iterationWork(state, 'i5').tasks;
  assert.equal(periodGoalDeadline(state, tasks, '2026-10-04'), null);
  assert.equal(periodGoalDeadline(state, tasks, '2026-10-11'), null);
  assert.deepEqual(periodGoalDeadline(state, tasks, '2026-10-12'), { endDate: '2026-10-11', overdue: true });
  tasks.forEach(task => { task.status = 'done'; });
  assert.equal(periodGoalDeadline(state, tasks, '2026-10-12'), null);
});

test('未割当と日付不明の作業は目標見出しに要確認を残す', () => {
  const state = createSample();
  const task = state.tasks.find(t => t.iterationId === 'i6');
  task.iterationId = null;
  assert.deepEqual(periodGoalDeadline(state, [task], '2026-10-04'), { endDate: null, overdue: false });
  task.iterationId = 'missing';
  assert.deepEqual(periodGoalDeadline(state, [task], '2026-10-04'), { endDate: null, overdue: false });
  task.iterationId = 'i6'; state.iterations.find(i => i.id === 'i6').startDate = null;
  assert.deepEqual(periodGoalDeadline(state, [task], '2026-10-04'), { endDate: null, overdue: false });
  assert.equal(periodGoalDeadline(state, [], '2026-10-04'), null);
});

test('期間内の目標見出しはその期間の作業だけを集計し、全体の進捗と混同しない', () => {
  const state = createSample();
  const work = iterationWork(state, 'i5');
  const before = JSON.stringify(state);
  const groups = groupTasksByGoal(state, work.tasks);
  assert.deepEqual(groups.map(g => [g.goal.id, g.tasks.length, g.progress.percent, g.progress.totalPoints, g.remainingPoints]), [
    ['ui', 3, 0, 4.5, 4.5], ['notice', 2, 0, 2, 2], ['guide', 2, 33, 1.5, 1]
  ]);
  assert.notEqual(groups[0].progress.percent, goalProgress(state, 'ui').percent);
  assert.equal(groups.reduce((sum, g) => sum + g.remainingPoints, 0), work.remainingPoints);
  assert.equal(new Set(groups.flatMap(g => g.tasks.map(t => t.id))).size, work.tasks.length);
  assert.equal(JSON.stringify(state), before);
});

test('目標のまとまりは親子Issueの最上位に従い、集約IssueのEstimateを数えない', () => {
  const state = createSample();
  state.parentIssues.find(p => p.id === 'ui-layout').estimatePoints = 100;
  state.tasks.find(t => t.id === 'move').goalId = 'notice';
  const groups = groupTasksByGoal(state, iterationWork(state, 'i5').tasks);
  assert.equal(groups.find(g => g.goal.id === 'ui').remainingPoints, 4.5);
  assert.equal(groups.find(g => g.goal.id === 'notice').remainingPoints, 2);
  assert.deepEqual(groupTasksByGoal(state, []), []);
});

test('目標ごとの期間集計は不足するEstimateを未算出にし、確認待ちを残りに含める', () => {
  const state = createSample();
  setEstimate(state, 'move', null);
  const groups = groupTasksByGoal(state, iterationWork(state, 'i5').tasks);
  assert.equal(groups[0].progress.percent, null);
  assert.equal(groups[0].remainingPoints, null);
  assert.equal(groups[0].progress.missingEstimates, 1);
  assert.equal(groups[1].remainingPoints, 2);
  const past = groupTasksByGoal(state, iterationWork(state, 'i4').tasks);
  assert.equal(past.find(g => g.goal.id === 'ui').remainingPoints, 1);
});

test('割当変更後も目標グループを期間と未割当へ正しく分ける', () => {
  const state = createSample();
  setIteration(state, 'guide-write', null);
  const current = groupTasksByGoal(state, iterationWork(state, 'i5').tasks);
  assert.equal(current.find(g => g.goal.id === 'guide').progress.percent, 100);
  assert.equal(current.find(g => g.goal.id === 'guide').remainingPoints, 0);
  const orphaned = groupTasksByGoal(state, orderedTasks(state).filter(t => !t.iterationId));
  assert.deepEqual(orphaned.map(g => [g.goal.id, g.remainingPoints, g.progress.percent]), [['guide', 1, 0]]);
  setIteration(state, 'guide-write', 'i6');
  assert.equal(groupTasksByGoal(state, iterationWork(state, 'i6').tasks).find(g => g.goal.id === 'guide').remainingPoints, 1.5);
});

test('担当別の負荷は期間内の未完了Estimateを集計し、状態別の内訳と一致する', () => {
  const state = createSample();
  const rows = iterationWorkload(state, 'i5');
  assert.deepEqual(rows.map(row => [row.owner, row.points, row.active.points, row.ready.points, row.waiting.points]), [
    ['自分', 4.5, 3, 0, 1.5], ['協力者A', 2, 1.5, 0, 0.5], ['協力者B', 1, 0, 1, 0]
  ]);
  assert.equal(rows.reduce((sum, row) => sum + row.points, 0), iterationWork(state, 'i5').remainingPoints);
  for (const row of rows) {
    assert.equal(row.active.points + row.ready.points + row.waiting.points, row.points);
    assert.equal(new Set([...row.active.tasks, ...row.ready.tasks, ...row.waiting.tasks].map(t => t.id)).size, row.tasks.length);
  }
});

test('確認待ちと停止中の作業も負荷に含め、完了条件の達成率でEstimateを減らさない', () => {
  const state = createSample();
  const review = iterationWorkload(state, 'i4').find(row => row.owner === '自分');
  assert.equal(review.points, 1);
  assert.deepEqual(review.waiting.tasks.map(t => t.id), ['delete']);
  setCriterion(state, 'move', 1, true);
  setWait(state, 'move', '確認画面の評価を待つ');
  const stopped = iterationWorkload(state, 'i5').find(row => row.owner === '自分');
  assert.equal(stopped.points, 4.5);
  assert.equal(stopped.active.points, 0);
  assert.equal(stopped.waiting.points, 4.5);
  state.tasks.find(t => t.id === 'move').status = 'unknown';
  assert.equal(iterationWorkload(state, 'i5')[0].waiting.points, 4.5);
});

test('Estimate不足は担当の合計と該当する内訳を未算出にし、完了済みの不足は負荷に影響しない', () => {
  const state = createSample();
  setEstimate(state, 'move', null);
  setEstimate(state, 'guide-check', null);
  const rows = iterationWorkload(state, 'i5');
  assert.equal(rows[0].points, null);
  assert.equal(rows[0].missingEstimates, 1);
  assert.equal(rows[0].knownPoints, 1.5);
  assert.equal(rows[0].active.points, null);
  assert.equal(rows[0].waiting.points, 1.5);
  assert.equal(rows[2].points, 1);
});

test('未担当の作業を独立した負荷として表示し、担当変更で二重計上しない', () => {
  const state = createSample();
  const before = structuredClone(state.tasks.find(t => t.id === 'move'));
  const order = [...state.order];
  setOwner(state, 'move', '  協力者A  ');
  let rows = iterationWorkload(state, 'i5');
  assert.equal(rows.find(row => row.owner === '自分').points, 1.5);
  assert.equal(rows.find(row => row.owner === '協力者A').points, 5);
  assert.deepEqual(state.tasks.find(t => t.id === 'move'), { ...before, owner: '協力者A' });
  assert.deepEqual(state.order, order);
  assert.match(state.history[0].text, /自分 → 協力者A/);
  setOwner(state, 'move', '   ');
  rows = iterationWorkload(state, 'i5');
  assert.equal(rows.find(row => row.owner === null).points, 3);
  assert.equal(rows.reduce((sum, row) => sum + row.points, 0), 7.5);
  assert.equal(taskOwner(state.tasks.find(t => t.id === 'move')), null);
});

test('不正な担当者を保存せず、同じ担当への更新では履歴を増やさない', () => {
  const state = createSample();
  const before = structuredClone(state);
  for (const owner of [{}, 10, 'a'.repeat(61)]) assert.throws(() => setOwner(state, 'move', owner));
  setOwner(state, 'move', ' 自分 ');
  assert.deepEqual(state, before);
});

test('期間変更と完了が担当別の負荷に反映され、別期間へ重複して残らない', () => {
  const state = createSample();
  setIteration(state, 'delete', 'i5');
  assert.equal(iterationWorkload(state, 'i4').find(row => row.owner === '自分').points, 0);
  assert.equal(iterationWorkload(state, 'i5').find(row => row.owner === '自分').points, 5.5);
  transition(state, 'delete', 'done');
  assert.equal(iterationWorkload(state, 'i5').find(row => row.owner === '自分').points, 4.5);
});

test('目標別の負荷は最下位の作業だけを数え、未割当の仕事も別途集計できる', () => {
  const state = createSample();
  state.parentIssues.forEach(issue => { issue.owner = '自分'; issue.estimatePoints = 100; });
  assert.deepEqual(iterationWorkload(state, 'i5', 'notice').map(row => [row.owner, row.points]), [['協力者A', 2]]);
  setIteration(state, 'move', null);
  const orphaned = orderedTasks(state).filter(t => !state.iterations.some(i => i.id === t.iterationId));
  assert.equal(workloadForTasks(state, orphaned)[0].points, 3);
  assert.equal(iterationWorkload(state, 'i5').reduce((sum, row) => sum + row.points, 0), 4.5);
});

test('作業中を継続し、優先順変更だけでは切り替えない', () => {
  const state = createSample();
  for (let i = 0; i < 5; i++) reorder(state, 'delete', -1, '見た目を先に確認する');
  assert.equal(nextWork(state).task.id, 'move');
  assert.match(state.history[0].text, /見た目を先に確認する/);
});
test('確認待ちは前提の完了として扱わない', () => {
  const state = createSample();
  setCriterion(state, 'move', 1, true); transition(state, 'move', 'review');
  assert.ok(blockers(state, state.tasks.find(t => t.id === 'multi')).length);
  assert.ok(!availableTasks(state).some(t => t.id === 'multi'));
  transition(state, 'move', 'done');
  assert.equal(nextWork(state).task.id, 'multi');
});
test('完了条件を満たしていない作業は完了にできない', () => {
  const state = createSample(); transition(state, 'move', 'review');
  assert.throws(() => transition(state, 'move', 'done'), /完了条件/);
  assert.equal(state.tasks.find(t => t.id === 'move').status, 'review');
});
test('作業中に待ちを登録しても表示を維持し、開始と完了は止める', () => {
  const state = createSample(); setWait(state, 'move', '確認画面の表示を確かめる');
  assert.equal(nextWork(state).task.id, 'move');
  assert.throws(() => transition(state, 'move', 'review'), /待ち/);
  setWait(state, 'move', ''); assert.equal(blockers(state, state.tasks.find(t => t.id === 'move')).length, 0);
});
test('着手できない場合は停止状態にする', () => {
  const state = createSample(); transition(state, 'move', 'todo'); setWait(state, 'move', '仕様の確認待ち');
  assert.equal(nextWork(state).mode, 'blocked'); assert.equal(nextWork(state).task, null);
});
test('判断は選択と理由を必要とし、解除後も別の前提を無視しない', () => {
  const state = createSample();
  assert.throws(() => resolveDecision(state, 'save-format', 'CSV', ''), /理由/);
  assert.equal(state.decisions[0].resolved, false);
  resolveDecision(state, 'save-format', 'CSV', '既存のプラグインへ渡せるため');
  assert.equal(state.tasks.find(t => t.id === 'format').status, 'done');
  assert.equal(blockers(state, state.tasks.find(t => t.id === 'save')).length, 1);
  assert.equal(nextWork(state).task.id, 'move');
});
test('不明な状態と存在しない前提は着手できるものとして扱わない', () => {
  const state = createSample(); transition(state, 'move', 'todo');
  state.tasks.find(t => t.id === 'move').status = 'unknown';
  assert.equal(nextWork(state).mode, 'blocked');
  state.tasks.find(t => t.id === 'multi').deps = ['missing'];
  assert.match(blockers(state, state.tasks.find(t => t.id === 'multi'))[0].text, /未確認/);
});
test('後続の多さより人間の優先順で選ぶ', () => {
  const state = createSample(); transition(state, 'move', 'todo'); transition(state, 'delete', 'todo');
  for (let i = 0; i < 5; i++) reorder(state, 'delete', -1, '成果の確認を先に行う');
  assert.ok(descendants(state, 'move').length > descendants(state, 'delete').length);
  assert.equal(nextWork(state).task.id, 'delete');
});
test('前提を未完了に戻した場合、作業中の表示を維持して停止理由を示す', () => {
  const state = createSample(); transition(state, 'preview', 'todo');
  assert.equal(nextWork(state).task.id, 'move');
  assert.ok(blockers(state, nextWork(state).task).length);
});
test('順番の変更に理由がない場合と範囲外の移動は状態を変えない', () => {
  const state = createSample(); const before = [...state.order];
  assert.throws(() => reorder(state, 'move', -1, ''), /理由/);
  assert.throws(() => reorder(state, 'read', -1, '試験'), /移動先/);
  assert.deepEqual(state.order, before);
});
test('すべての作業を条件確認後に完了すると目標達成を示す', () => {
  const state = createSample();
  for (const id of ['move', 'multi', 'delete', 'format', 'save', 'restore', 'check']) {
    const task = state.tasks.find(t => t.id === id);
    if (id === 'format') { resolveDecision(state, 'save-format', 'CSV', '試作で確認'); continue; }
    if (task.status === 'todo') transition(state, id, 'active');
    task.criteria.forEach((_, i) => setCriterion(state, id, i, true));
    if (task.status === 'active') transition(state, id, 'review');
    transition(state, id, 'done');
  }
  assert.equal(nextWork(state).mode, 'complete'); assert.equal(nextWork(state).task, null);
  assert.equal(nextWork(state, 'notice').mode, 'active');
  assert.equal(nextWork(state, 'guide').mode, 'ready');
});

test('目標ごとに作業中の仕事と着手候補を表示する', () => {
  const state = createSample();
  assert.equal(nextWork(state, 'ui').task.id, 'move');
  assert.equal(nextWork(state, 'notice').task.id, 'notice-format');
  assert.equal(nextWork(state, 'guide').task.id, 'guide-write');
  assert.deepEqual(availableTasks(state, 'guide').map(t => t.id), ['guide-write']);
});
test('他の目標で作業中でも、独立した作業を開始できる', () => {
  const state = createSample();
  transition(state, 'guide-write', 'active');
  assert.equal(nextWork(state, 'guide').mode, 'active');
  assert.equal(nextWork(state, 'guide').task.id, 'guide-write');
  assert.equal(nextWork(state, 'ui').task.id, 'move');
  assert.equal(nextWork(state, 'notice').task.id, 'notice-format');
});
test('同じ目標内でも独立した作業を並行し、作業中のすべてを表示する', () => {
  const state = createSample();
  transition(state, 'delete', 'active');
  assert.deepEqual(nextWork(state, 'ui').active.map(t => t.id), ['move', 'delete']);
  reorder(state, 'delete', -1, '文字の確認を先に進める');
  assert.equal(nextWork(state, 'ui').active.length, 2);
  assert.equal(state.tasks.find(t => t.id === 'move').status, 'active');
});
test('一つの目標の待ちが、ほかの独立した目標を止めない', () => {
  const state = createSample();
  transition(state, 'move', 'todo');
  setWait(state, 'move', '配置の確認待ち');
  assert.equal(nextWork(state, 'ui').mode, 'blocked');
  assert.equal(nextWork(state, 'notice').mode, 'active');
  assert.equal(nextWork(state, 'guide').mode, 'ready');
});
test('別の目標の未完了作業に依存する場合は、並行開始を止める', () => {
  const state = createSample();
  const task = state.tasks.find(t => t.id === 'guide-write');
  task.deps = ['move'];
  assert.equal(nextWork(state, 'guide').mode, 'blocked');
  assert.match(blockers(state, task)[0].text, /予約フォーム/);
  assert.throws(() => transition(state, 'guide-write', 'active'), /前提/);
  setCriterion(state, 'move', 1, true);
  transition(state, 'move', 'review');
  transition(state, 'move', 'done');
  assert.equal(nextWork(state, 'guide').mode, 'ready');
  transition(state, 'guide-write', 'active');
  assert.equal(nextWork(state, 'guide').mode, 'active');
});
test('優先順変更は対象の目標だけに適用し、ほかの目標を並べ替えない', () => {
  const state = createSample();
  state.order.splice(1, 0, state.order.splice(state.order.indexOf('notice-sort'), 1)[0]);
  const noticeBefore = orderedTasks(state, 'notice').map(t => t.id);
  reorder(state, 'timeline', -1, '表示の確認を先に行う');
  assert.deepEqual(orderedTasks(state, 'ui').slice(0, 2).map(t => t.id), ['timeline', 'read']);
  assert.deepEqual(orderedTasks(state, 'notice').map(t => t.id), noticeBefore);
  assert.equal(state.history[0].goalId, 'ui');
  assert.throws(() => reorder(state, 'notice-sort', -1, '他の目標へ移す'), /移動先/);
});
test('未登録の目標はエラーにし、作業がない目標を達成扱いにしない', () => {
  const state = createSample();
  assert.throws(() => nextWork(state, 'missing'), /目標/);
  state.goals.push({ id: 'empty', title: '作業を登録していない目標' });
  assert.equal(nextWork(state, 'empty').mode, 'empty');
});

test('前提の始点と判断・確認待ちを示し、直接と間接の後続を分ける', () => {
  const rows = blockingTasks(createSample(), 'ui');
  assert.deepEqual(rows.filter(r => r.root).map(r => r.id), ['move', 'delete', 'format']);
  const move = rows.find(r => r.id === 'move');
  assert.deepEqual(move.direct.map(t => t.id), ['multi']);
  assert.deepEqual(move.indirect.map(t => t.id), ['save', 'restore', 'check']);
  assert.deepEqual(move.affected.map(t => t.id), ['multi', 'save', 'restore', 'check']);
  assert.equal(rows.find(r => r.id === 'multi').root, false);
  assert.equal(rows.find(r => r.id === 'delete').task.status, 'review');
  assert.equal(rows.find(r => r.id === 'format').causes[0].kind, 'decision');
});
test('確認待ちでは前提を残し、完了後に次の未完了の前提へ進む', () => {
  const state = createSample();
  setCriterion(state, 'move', 1, true);
  transition(state, 'move', 'review');
  assert.ok(blockingTasks(state, 'ui').some(r => r.id === 'move'));
  transition(state, 'move', 'done');
  const rows = blockingTasks(state, 'ui');
  assert.ok(!rows.some(r => r.id === 'move'));
  assert.ok(rows.find(r => r.id === 'multi').root);
  assert.deepEqual(rows.find(r => r.id === 'multi').direct.map(t => t.id), ['save']);
});
test('判断の解除後も、同じ後続が待っている別の前提を残す', () => {
  const state = createSample();
  resolveDecision(state, 'save-format', 'CSV', '配置情報を渡すため');
  const rows = blockingTasks(state, 'ui');
  assert.ok(!rows.some(r => r.id === 'format'));
  assert.ok(rows.find(r => r.id === 'multi').direct.some(t => t.id === 'save'));
  assert.deepEqual(blockers(state, state.tasks.find(t => t.id === 'save')).map(b => b.id), ['multi']);
});
test('後続がない作業の待ちも示し、解除すると表示から外す', () => {
  const state = createSample();
  setWait(state, 'guide-review', '確認を依頼する相手を決める');
  const row = blockingTasks(state, 'guide').find(r => r.id === 'guide-review');
  assert.ok(row.root);
  assert.equal(row.affected.length, 0);
  assert.equal(row.causes.find(c => c.kind === 'wait').text, '確認を依頼する相手を決める');
  setWait(state, 'guide-review', '');
  assert.ok(!blockingTasks(state, 'guide').some(r => r.id === 'guide-review'));
});
test('別の目標の前提をさかのぼって、対象目標への影響を示す', () => {
  const state = createSample();
  state.tasks.find(t => t.id === 'guide-write').deps = ['multi'];
  const rows = blockingTasks(state, 'guide');
  assert.deepEqual(rows.filter(r => r.root).map(r => r.id), ['move']);
  assert.deepEqual(rows.find(r => r.id === 'move').affected.map(t => t.id), ['guide-write', 'guide-review']);
  assert.ok(!rows.some(r => r.task?.goalId === 'notice'));
});
test('情報がない前提を未確認として残す', () => {
  const state = createSample();
  state.tasks.find(t => t.id === 'guide-write').deps = ['missing'];
  const row = blockingTasks(state, 'guide').find(r => r.id === 'missing');
  assert.equal(row.task, null);
  assert.ok(row.root);
  assert.equal(row.causes[0].kind, 'unknown');
  assert.deepEqual(row.direct.map(t => t.id), ['guide-write']);
  assert.deepEqual(row.indirect.map(t => t.id), ['guide-review']);
});
test('合流する後続を重複して数えず、完了済みの作業を経由しない', () => {
  const state = createSample();
  state.tasks.find(t => t.id === 'save').deps.push('move');
  const row = blockingTasks(state, 'ui').find(r => r.id === 'move');
  assert.deepEqual(row.direct.map(t => t.id), ['multi', 'save']);
  assert.equal(row.affected.length, 4);
  state.tasks.find(t => t.id === 'guide-check').deps = ['move'];
  assert.ok(!blockingTasks(state, 'guide').some(r => r.id === 'move'));
});
test('循環する前提でも停止せず、関係する作業を残す', () => {
  const state = createSample();
  state.tasks.find(t => t.id === 'guide-write').deps = ['guide-review'];
  const rows = blockingTasks(state, 'guide');
  assert.deepEqual(rows.map(r => r.id), ['guide-write', 'guide-review']);
  assert.ok(rows.every(r => !r.root));
  assert.ok(rows.every(r => r.affected.length === 1 && r.affected[0].id !== r.id));
  assert.equal(nextWork(state, 'guide').mode, 'blocked');
});

test('目標の完了率はEstimateで重みを付け、確認待ちを含めない', () => {
  const state = createSample();
  assert.deepEqual(goalProgress(state, 'ui'), { total: 10, complete: 3, missingEstimates: 0, totalPoints: 13, completePoints: 3.5, percent: 26 });
  assert.equal(goalProgress(state, 'notice').percent, 16);
  assert.equal(goalProgress(state, 'guide').percent, 25);
  assert.deepEqual(criteriaProgress(state.tasks.find(t => t.id === 'delete')), { total: 2, achieved: 2, percent: 100 });
});
test('完了条件の達成率を更新しても、成果を確認するまで目標の完了率は変えない', () => {
  const state = createSample();
  const task = state.tasks.find(t => t.id === 'move');
  assert.equal(criteriaProgress(task).percent, 50);
  setCriterion(state, 'move', 1, true);
  assert.equal(criteriaProgress(task).percent, 100);
  assert.equal(goalProgress(state, 'ui').percent, 26);
  transition(state, 'move', 'review');
  assert.equal(goalProgress(state, 'ui').percent, 26);
  transition(state, 'move', 'done');
  assert.equal(goalProgress(state, 'ui').percent, 50);
});
test('未確認の作業を分母から除外せず、未登録の割合は不明とする', () => {
  const state = createSample();
  state.tasks.find(t => t.id === 'move').status = 'unknown';
  assert.equal(goalProgress(state, 'ui').totalPoints, 13);
  assert.equal(goalProgress(state, 'ui').percent, 26);
  state.goals.push({ id: 'empty', title: '作業未登録' });
  assert.equal(goalProgress(state, 'empty').percent, null);
  assert.equal(goalProgress(state, 'empty').totalPoints, null);
  assert.deepEqual(criteriaProgress({ criteria: [] }), { total: 0, achieved: 0, percent: null });
});
test('作業を未完了に戻すと目標と条件の割合を下げる', () => {
  const state = createSample();
  transition(state, 'read', 'todo');
  assert.equal(goalProgress(state, 'ui').percent, 23);
  assert.equal(criteriaProgress(state.tasks.find(t => t.id === 'read')).percent, 0);
});
test('未完了が一件でも残る目標を端数処理で100%にしない', () => {
  const state = createSample();
  const template = state.tasks[0];
  state.tasks = Array.from({ length: 201 }, (_, i) => ({ ...template, id: `task-${i}`, status: i === 200 ? 'review' : 'done' }));
  state.order = state.tasks.map(t => t.id);
  assert.equal(goalProgress(state, 'ui').percent, 99);
  state.tasks[200].status = 'done';
  assert.equal(goalProgress(state, 'ui').percent, 100);
  assert.equal(criteriaProgress({ criteria: [{ checked: true }, { checked: true }, { checked: false }] }).percent, 66);
});

test('一件ずつでも、大きな作業が残っていれば完了率は半分に達しない', () => {
  const state = createSample();
  state.tasks = [state.tasks[0], state.tasks.find(t => t.id === 'move')];
  state.order = state.tasks.map(t => t.id);
  assert.equal(goalProgress(state, 'ui').complete, 1);
  assert.equal(goalProgress(state, 'ui').total, 2);
  assert.equal(goalProgress(state, 'ui').percent, 14);
});
test('Estimateの変更を重みに反映し、状態と条件の達成状況を維持する', () => {
  const state = createSample();
  setEstimate(state, 'move', 6);
  assert.equal(goalProgress(state, 'ui').totalPoints, 16);
  assert.equal(goalProgress(state, 'ui').percent, 21);
  assert.equal(state.tasks.find(t => t.id === 'move').status, 'active');
  assert.equal(criteriaProgress(state.tasks.find(t => t.id === 'move')).percent, 50);
  assert.equal(state.history[0].goalId, 'ui');
  setEstimate(state, 'read', 1);
  assert.equal(goalProgress(state, 'ui').completePoints, 4);
  assert.equal(goalProgress(state, 'ui').percent, 24);
  assert.equal(state.tasks.find(t => t.id === 'read').status, 'done');
});
test('Estimateが欠けた目標は未算出とし、入力後に計算する', () => {
  const state = createSample();
  setEstimate(state, 'move', null);
  assert.equal(goalProgress(state, 'ui').percent, null);
  assert.equal(goalProgress(state, 'ui').totalPoints, null);
  assert.equal(goalProgress(state, 'ui').missingEstimates, 1);
  assert.equal(goalProgress(state, 'ui').completePoints, 3.5);
  setEstimate(state, 'move', 3);
  assert.equal(goalProgress(state, 'ui').percent, 26);
  setEstimate(state, 'read', null);
  assert.equal(goalProgress(state, 'ui').completePoints, null);
  assert.equal(goalProgress(state, 'ui').percent, null);
});
test('不正なEstimateを記録せず、元の値を維持する', () => {
  const state = createSample();
  for (const value of [0, -1, Infinity, NaN, '0.5']) assert.throws(() => setEstimate(state, 'move', value), /0より大きい/);
  assert.equal(state.tasks.find(t => t.id === 'move').estimatePoints, 3);
  assert.equal(state.history.length, 0);
  state.tasks.find(t => t.id === 'move').estimatePoints = -1;
  assert.equal(goalProgress(state, 'ui').percent, null);
});

test('0.5などの小数のEstimateを丸めずに集計する', () => {
  const state = createSample();
  setEstimate(state, 'move', 0.5);
  assert.equal(state.tasks.find(t => t.id === 'move').estimatePoints, 0.5);
  assert.equal(goalProgress(state, 'ui').totalPoints, 10.5);
  assert.equal(goalProgress(state, 'ui').percent, 33);
  assert.match(state.history[0].text, /3pt → 0.5pt/);
  setEstimate(state, 'read', 0.25);
  assert.equal(goalProgress(state, 'ui').completePoints, 3.25);
  assert.equal(goalProgress(state, 'ui').totalPoints, 10.25);
  assert.equal(goalProgress(state, 'ui').percent, 31);
});
test('小数計算の誤差で割合を一段下げず、微小な未完了も100%にしない', () => {
  const state = createSample();
  const template = state.tasks[0];
  state.tasks = [{ ...template, id: 'first', estimatePoints: 0.29, status: 'done' }, { ...template, id: 'second', estimatePoints: 0.21, status: 'review' }];
  state.order = state.tasks.map(t => t.id);
  assert.equal(goalProgress(state, 'ui').percent, 58);
  state.tasks[0].estimatePoints = 1;
  state.tasks[1].estimatePoints = 1e-18;
  assert.equal(goalProgress(state, 'ui').percent, 99);
  state.tasks[1].status = 'done';
  assert.equal(goalProgress(state, 'ui').percent, 100);
});

test('親子Issueの階層と依存関係を別にたどる', () => {
  const state = createSample();
  assert.deepEqual(issueChildren(state, 'ui').map(n => n.issue.id), ['ui-design', 'ui-tools', 'ui-export']);
  assert.deepEqual(issueChildren(state, 'ui-tools').map(n => n.issue.id), ['ui-layout', 'delete']);
  assert.deepEqual(issueChildren(state, 'ui-layout').map(n => n.issue.id), ['move', 'multi']);
  assert.deepEqual(issuePath(state, 'move').map(n => n.id), ['ui', 'ui-tools', 'ui-layout', 'move']);
  assert.equal(nextWork(state, 'ui').task.id, 'move');
  assert.ok(availableTasks(state, 'guide').some(t => t.id === 'guide-write'));
});
test('集約Issue自身のEstimateを足さず、階層をまたいでも作業量を一度だけ数える', () => {
  const state = createSample();
  state.goals[0].estimatePoints = 13;
  state.parentIssues.find(p => p.id === 'ui-tools').estimatePoints = 5;
  state.parentIssues.find(p => p.id === 'ui-layout').estimatePoints = 4;
  assert.equal(issueProgress(state, 'ui').totalPoints, 13);
  assert.equal(issueProgress(state, 'ui-tools').totalPoints, 5);
  assert.equal(issueProgress(state, 'ui-layout').totalPoints, 4);
  assert.equal(issueProgress(state, 'ui-design').percent, 100);
});
test('階層ごとの割合を平均せず、作業IssueのEstimateから親の割合を求める', () => {
  const state = createSample();
  state.tasks = [state.tasks.find(t => t.id === 'read'), state.tasks.find(t => t.id === 'move')];
  state.order = state.tasks.map(t => t.id);
  setEstimate(state, 'move', 1.5);
  assert.equal(issueProgress(state, 'ui-design').percent, 100);
  assert.equal(issueProgress(state, 'ui-tools').percent, 0);
  assert.equal(issueProgress(state, 'ui').percent, 25);
});
test('作業Issueを完了するとすべての上位Issueへ反映し、Issueの状態は書き換えない', () => {
  const state = createSample();
  setCriterion(state, 'move', 1, true);
  transition(state, 'move', 'review');
  assert.equal(issueProgress(state, 'ui-layout').percent, 0);
  transition(state, 'move', 'done');
  assert.equal(issueProgress(state, 'ui-layout').percent, 75);
  assert.equal(issueProgress(state, 'ui-tools').percent, 60);
  assert.equal(issueProgress(state, 'ui').percent, 50);
  assert.equal(state.goals[0].issueState, 'open');
  assert.equal(state.parentIssues.find(p => p.id === 'ui-layout').issueState, 'open');
  state.parentIssues.find(p => p.id === 'ui-tools').issueState = 'closed';
  assert.equal(issueProgress(state, 'ui-tools').percent, 60);
});
test('下位のEstimateが欠けると、その上位の割合も未算出にする', () => {
  const state = createSample();
  setEstimate(state, 'move', null);
  for (const id of ['ui-layout', 'ui-tools', 'ui']) {
    assert.equal(issueProgress(state, id).percent, null);
    assert.equal(issueProgress(state, id).missingEstimates, 1);
  }
  assert.equal(issueProgress(state, 'ui-design').percent, 100);
  assert.equal(issueProgress(state, 'notice').percent, 16);
});
test('親の直下にある作業Issueと、多段の子Issueを併せて集計する', () => {
  const state = createSample();
  assert.deepEqual(issueChildren(state, 'guide').map(n => n.issue.id), ['guide-content', 'guide-check']);
  assert.equal(issueProgress(state, 'guide').totalPoints, 2);
  assert.equal(issueProgress(state, 'guide').completePoints, 0.5);
  assert.equal(issueProgress(state, 'guide-content').totalPoints, 1.5);
});
test('親子関係の循環や存在しない親を、完了した階層として扱わない', () => {
  const state = createSample();
  state.parentIssues.find(p => p.id === 'ui-tools').parentId = 'ui-layout';
  assert.throws(() => issuePath(state, 'move'), /循環/);
  assert.throws(() => issueProgress(state, 'ui-layout'), /循環/);
  state.parentIssues.find(p => p.id === 'ui-tools').parentId = 'missing';
  assert.throws(() => issuePath(state, 'move'), /親Issue/);
  assert.throws(() => issueChildren(state, 'missing'), /親Issue/);
});

test('イテレーション終了日は開始日を含む期間の最終日とする', () => {
  const iteration = createSample().iterations.find(i => i.id === 'i5');
  assert.deepEqual(iterationTiming(iteration, '2026-10-03'), { startDate: '2026-09-28', endDate: '2026-10-11', daysLeft: 8, phase: 'active' });
  assert.equal(iterationTiming(iteration, '2026-09-27').phase, 'upcoming');
  assert.equal(iterationTiming(iteration, '2026-10-11').phase, 'active');
  assert.equal(iterationTiming(iteration, '2026-10-11').daysLeft, 0);
  assert.equal(iterationTiming(iteration, '2026-10-12').phase, 'past');
  assert.equal(iterationTiming(iteration, '2026-10-12').daysLeft, -1);
});
test('日本時間の日付で残り日数を計算し、月末とうるう年をまたぐ', () => {
  assert.equal(todayInTokyo(new Date('2026-10-02T14:59:59Z')), '2026-10-02');
  assert.equal(todayInTokyo(new Date('2026-10-02T15:00:00Z')), '2026-10-03');
  assert.deepEqual(iterationTiming({ startDate: '2024-02-26', durationDays: 7 }, '2024-02-29'), { startDate: '2024-02-26', endDate: '2024-03-03', daysLeft: 3, phase: 'active' });
});
test('日付や期間が不明な場合は期限を推測しない', () => {
  const invalid = [null, {}, { startDate: '2026-02-30', durationDays: 14 }, { startDate: '2026-10-03', durationDays: 0 },
    { startDate: '2026-10-03', durationDays: 0.5 }, { startDate: '2026-10-03', durationDays: '14' }, { startDate: '2026-10-03', durationDays: Number.MAX_SAFE_INTEGER },
    { startDate: '9999-12-31', durationDays: 2 }];
  for (const value of invalid) assert.deepEqual(iterationTiming(value, '2026-10-03'), { startDate: null, endDate: null, daysLeft: null, phase: 'unknown' });
  assert.equal(iterationTiming(createSample().iterations[1], 'bad-date').phase, 'unknown');
});
test('未割当と取得できないイテレーションを、期限なしと確認済みに混同しない', () => {
  const state = createSample();
  const task = state.tasks.find(t => t.id === 'move');
  assert.equal(taskTiming(state, task, '2026-10-03').endDate, '2026-10-11');
  task.iterationId = null;
  assert.equal(taskTiming(state, task, '2026-10-03').phase, 'unassigned');
  task.iterationId = 'missing';
  assert.equal(taskTiming(state, task, '2026-10-03').phase, 'unknown');
  task.iterationId = 'i5'; state.iterations[1].durationDays = null;
  assert.equal(taskTiming(state, task, '2026-10-03').phase, 'unknown');
});
test('親Issue全体と選択したイテレーションの進捗を分けて集計する', () => {
  const state = createSample();
  const ui = iterationWork(state, 'i5', 'ui');
  assert.deepEqual(ui.tasks.map(t => t.id), ['move', 'multi', 'format']);
  assert.equal(ui.progress.totalPoints, 4.5);
  assert.equal(ui.progress.percent, 0);
  assert.equal(ui.remainingPoints, 4.5);
  assert.equal(goalProgress(state, 'ui').percent, 26);
  const guide = iterationWork(state, 'i5', 'guide');
  assert.equal(guide.progress.percent, 33);
  assert.equal(guide.remainingPoints, 1);
  const all = iterationWork(state, 'i5');
  assert.equal(all.tasks.length, 7);
  assert.equal(all.progress.totalPoints, 8);
  assert.equal(all.remainingPoints, 7.5);
});
test('確認待ちを残りの作業量に含め、完了後に期間と全体へ反映する', () => {
  const state = createSample();
  setCriterion(state, 'move', 1, true); transition(state, 'move', 'review');
  assert.equal(iterationWork(state, 'i5', 'ui').remainingPoints, 4.5);
  transition(state, 'move', 'done');
  assert.equal(iterationWork(state, 'i5', 'ui').remainingPoints, 1.5);
  assert.equal(iterationWork(state, 'i5', 'ui').progress.percent, 66);
  assert.equal(goalProgress(state, 'ui').percent, 50);
});
test('割当を変更すると期間ごとの対象が変わり、全体の作業量と優先順は維持する', () => {
  const state = createSample();
  const before = [...state.order];
  setIteration(state, 'move', 'i6');
  assert.equal(iterationWork(state, 'i5', 'ui').remainingPoints, 1.5);
  assert.equal(iterationWork(state, 'i6', 'ui').remainingPoints, 7);
  assert.equal(goalProgress(state, 'ui').totalPoints, 13);
  assert.equal(nextWork(state, 'ui').task.id, 'move');
  assert.deepEqual(state.order, before);
  assert.match(state.history[0].text, /I5 → I6/);
  setIteration(state, 'move', null);
  assert.equal(taskTiming(state, state.tasks.find(t => t.id === 'move')).phase, 'unassigned');
  assert.equal(iterationWork(state, 'i6', 'ui').remainingPoints, 4);
  assert.equal(state.history[0].goalId, 'ui');
});
test('不正な割当を保存せず、対象のない期間は未算出とする', () => {
  const state = createSample();
  assert.throws(() => setIteration(state, 'move', 'missing'), /イテレーション/);
  assert.equal(state.tasks.find(t => t.id === 'move').iterationId, 'i5');
  assert.equal(state.history.length, 0);
  assert.throws(() => iterationWork(state, 'missing'), /イテレーション/);
  const empty = iterationWork(state, 'i4', 'guide');
  assert.equal(empty.progress.percent, null);
  assert.equal(empty.remainingPoints, 0);
});
test('期間内のEstimateが不足している場合は、残りポイントを推測しない', () => {
  const state = createSample();
  setEstimate(state, 'move', null);
  assert.equal(iterationWork(state, 'i5', 'ui').remainingPoints, null);
  assert.equal(iterationWork(state, 'i5', 'ui').progress.percent, null);
  assert.equal(iterationWork(state, 'i6', 'ui').remainingPoints, 4);
});

test('前の期間の未完了と確認待ちを残し、完了・未割当・日付不明を超過扱いにしない', () => {
  const state = createSample();
  for (const id of ['move', 'multi', 'delete', 'format']) state.tasks.find(t => t.id === id).iterationId = 'i4';
  state.tasks.find(t => t.id === 'format').status = 'unknown';
  state.tasks.find(t => t.id === 'save').iterationId = null;
  state.tasks.find(t => t.id === 'restore').iterationId = 'missing';
  assert.deepEqual(overdueTasks(state, 'ui', '2026-10-03').map(t => t.id), ['move', 'multi', 'delete', 'format']);
  assert.deepEqual(overdueTasks(state, 'notice', '2026-10-03'), []);
  assert.deepEqual(overdueTasks(state, undefined, 'bad-date'), []);
});

test('期間の終了当日は超過に含めず、翌日から未完了を示す', () => {
  const state = createSample();
  state.tasks.find(t => t.id === 'move').iterationId = 'i4';
  assert.deepEqual(overdueTasks(state, undefined, '2026-09-27'), []);
  assert.deepEqual(overdueTasks(state, undefined, '2026-09-28').map(t => t.id), ['move', 'delete']);
});

test('超過の確認では状態や割当を変えず、人間の繰越操作後に今期へ集計する', () => {
  const state = createSample();
  setIteration(state, 'delete', 'i4');
  const before = structuredClone(state);
  assert.deepEqual(overdueTasks(state, undefined, '2026-10-03').map(t => t.id), ['delete']);
  assert.deepEqual(state, before);
  setIteration(state, 'delete', 'i5');
  assert.deepEqual(overdueTasks(state, undefined, '2026-10-03'), []);
  const task = state.tasks.find(t => t.id === 'delete');
  assert.equal(task.status, 'review');
  assert.equal(task.estimatePoints, 1);
  assert.deepEqual(task.criteria, before.tasks.find(t => t.id === 'delete').criteria);
  assert.deepEqual(state.order, before.order);
  assert.equal(iterationWork(state, 'i5', 'ui').remainingPoints, 5.5);
  assert.equal(goalProgress(state, 'ui').totalPoints, 13);
  assert.match(state.history[0].text, /I4 → I5/);
  transition(state, 'delete', 'done');
  assert.equal(iterationWork(state, 'i5', 'ui').remainingPoints, 4.5);
});

import { workCategory, myWork, currentIteration } from '../dist/engine.mjs';
const category = (state, id, today) => workCategory(state, state.tasks.find(t => t.id === id), today);

test('今の期間は進行中の期間、なければ次に始まる期間とする', () => {
  const state = createSample();
  assert.equal(currentIteration(state, '2026-10-01').id, 'i5');
  assert.equal(currentIteration(state, '2026-09-01').id, 'i4');
  assert.equal(currentIteration(state, '2026-12-01'), null);
  assert.equal(currentIteration({ ...state, iterations: [{ id: 'x', title: 'X', startDate: null, durationDays: null }] }, '2026-10-01'), null);
});

test('作業は要対応 → 確認待ち → 作業中 → 前提待ち → 着手可能の順に一つだけに分類する', () => {
  const state = createSample();
  const today = '2026-09-20';
  assert.deepEqual(category(state, 'move', today), { group: 'active', reasons: [] });
  assert.deepEqual(category(state, 'delete', today), { group: 'review', reasons: [] });
  assert.equal(category(state, 'multi', today).group, 'waiting');
  assert.deepEqual(category(state, 'multi', today).reasons, ['前提：入力欄の配置を調整する（作業中）']);
  assert.deepEqual(category(state, 'format', today), { group: 'action', reasons: ['判断待ち：出力形式が未決定'] });
  assert.equal(category(state, 'guide-write', today).group, 'ready');
  assert.equal(category(state, 'read', today), null);
});

test('要対応は理由をすべて示し、期限超過と前提の期限超過を区別する', () => {
  const state = createSample();
  const task = state.tasks.find(t => t.id === 'move');
  task.waitReason = '確認待ち'; task.owner = null; task.status = 'unknown';
  assert.deepEqual(category(state, 'move', '2026-10-13').reasons, ['状態が未確認', '待ち：確認待ち', '期限超過（2日）']);
  assert.deepEqual(category(state, 'multi', '2026-10-13').reasons, ['期限超過（2日）', '前提が期限超過：入力欄の配置を調整する']);
});

test('作業中でも担当者がいない、または前提が未完了なら要対応にする', () => {
  const state = createSample();
  state.tasks.find(t => t.id === 'move').owner = '';
  assert.deepEqual(category(state, 'move', '2026-10-01').reasons, ['作業中なのに担当者がいない']);
  state.tasks.find(t => t.id === 'multi').status = 'active';
  assert.deepEqual(category(state, 'multi', '2026-10-01').reasons, ['作業中なのに前提が未完了：入力欄の配置を調整する']);
});

test('自分の作業は担当者で絞り込み、着手可能を今の期間と先の期間に分け、空のまとまりを出さない', () => {
  const state = createSample();
  const today = '2026-10-01';
  const sections = owner => Object.fromEntries(myWork(state, owner, today).sections.map(s => [s.id, s.tasks.map(item => item.task.id)]));
  assert.deepEqual(sections('協力者B'), { action: ['check'], 'ready-now': ['guide-write'], waiting: ['guide-review'] });
  assert.deepEqual(Object.keys(sections(undefined)), ['active', 'action', 'ready-now', 'waiting']);
  state.tasks.find(t => t.id === 'guide-write').iterationId = 'i6';
  assert.deepEqual(sections('協力者B')['ready-later'], ['guide-write']);
  state.tasks.find(t => t.id === 'guide-write').owner = null;
  assert.deepEqual(sections(null), { 'ready-later': ['guide-write'] });
  const before = JSON.stringify(state); myWork(state, undefined, today); assert.equal(JSON.stringify(state), before);
});

test('初期展開は進行中をすべて選び、なければ対象の次の期間だけを選ぶ', () => {
  const state = { iterations: [
    { id: 'future', startDate: '2026-10-10', durationDays: 7 },
    { id: 'active1', startDate: '2026-10-01', durationDays: 7 },
    { id: 'unknown', startDate: null, durationDays: null },
    { id: 'active2', startDate: '2026-10-04', durationDays: 2 },
    { id: 'next', startDate: '2026-10-08', durationDays: 2 }
  ] };
  assert.deepEqual(currentIterations(state, '2026-10-04').map(i => i.id), ['active1', 'active2']);
  assert.deepEqual(currentIterations(state, '2026-10-07').map(i => i.id), ['active1']);
  assert.deepEqual(currentIterations(state, '2026-10-08').map(i => i.id), ['next']);
  assert.deepEqual(currentIterations({ iterations: state.iterations.filter(i => ['future', 'unknown'].includes(i.id)) }, '2026-10-04').map(i => i.id), ['future']);
  assert.deepEqual(currentIterations(state, '2026-11-01'), []);
});
