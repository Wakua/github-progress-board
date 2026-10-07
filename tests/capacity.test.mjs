import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityLimit, sumEstimates, assessLoad } from '../dist/capacity.mjs';
import { createSample, iterationWorkload, workloadForTasks, orderedTasks, setOwner, setEstimate, setIteration } from '../dist/engine.mjs';
import { githubPlan } from '../dist/github-planning.mjs';
import { githubPeriodWorkload } from '../dist/github-work.mjs';
import { renderGithubPeriods } from '../dist/github-planning-view.mjs';
import { workloadFigures, workloadChipLabel, workloadChipTitle, workloadLimitMarkup } from '../dist/workload-view.mjs';
import { bookingSampleWorkspace } from '../scripts/make-booking-sample.mjs';

// 2026-10-05は月曜日。ここから日曜日の10-11までが1週間。
const week = { startDate: '2026-10-05', durationDays: 7 };

test('上限は期間内の平日の日数 × 1pt。7日は5pt、14日は10pt', () => {
  assert.deepEqual(capacityLimit(week, '2026-10-01'), { phase: 'upcoming', days: 5, points: 5 });
  assert.equal(capacityLimit({ startDate: '2026-10-05', durationDays: 14 }, '2026-10-01').points, 10);
  assert.equal(capacityLimit({ startDate: '2026-10-10', durationDays: 7 }, '2026-10-01').points, 5, '土曜開始でも7日は5日');
  assert.equal(capacityLimit({ startDate: '2026-10-05', durationDays: 10 }, '2026-10-01').points, 8);
  assert.equal(capacityLimit({ startDate: '2026-10-05', durationDays: 1 }, '2026-10-01').points, 1);
  assert.equal(capacityLimit({ startDate: '2026-10-11', durationDays: 1 }, '2026-10-01').points, 0, '日曜1日は稼働日がない');
});

test('進行中の期間は今日を含む残りの平日だけを数え、終了日までに平日が残らなければ0ptになる', () => {
  const days = today => capacityLimit(week, today);
  assert.deepEqual(days('2026-10-05'), { phase: 'active', days: 5, points: 5 });
  assert.equal(days('2026-10-07').points, 3);
  assert.equal(days('2026-10-09').points, 1);
  assert.deepEqual(days('2026-10-10'), { phase: 'active', days: 0, points: 0 });
  assert.equal(days('2026-10-11').points, 0);
});

test('期間の途中の土日は、翌週以降の平日を数える', () => {
  const twoWeeks = { startDate: '2026-09-28', durationDays: 14 };
  assert.deepEqual(capacityLimit(twoWeeks, '2026-10-03'), { phase: 'active', days: 5, points: 5 });
  assert.equal(capacityLimit(twoWeeks, '2026-10-04').points, 5);
  assert.equal(capacityLimit(twoWeeks, '2026-10-09').points, 1);
  assert.equal(capacityLimit(twoWeeks, '2026-10-10').points, 0, '最終週の土曜日は平日が残らない');
});

test('終了した期間と日付の不明な期間には上限を当てない', () => {
  assert.deepEqual(capacityLimit(week, '2026-10-12'), { phase: 'past', days: null, points: null });
  for (const bad of [{ startDate: null, durationDays: 7 }, { startDate: '2026-02-30', durationDays: 7 }, { startDate: '2026-10-05', durationDays: 0 },
    { startDate: '2026-10-05', durationDays: 1.5 }, { startDate: '2026-10-05', durationDays: 1e15 }]) {
    assert.deepEqual(capacityLimit(bad, '2026-10-07'), { phase: 'unknown', days: null, points: null });
  }
  assert.equal(capacityLimit(week, 'today').phase, 'unknown');
});

test('見積のない作業は合計に含めず件数を数え、合計の誤差を丸める', () => {
  assert.deepEqual(sumEstimates([1, 0.5, null]), { missingEstimates: 1, knownPoints: 1.5, points: null });
  assert.deepEqual(sumEstimates([0.1, 0.2]), { missingEstimates: 0, knownPoints: 0.3, points: 0.3 });
  assert.deepEqual(sumEstimates([]), { missingEstimates: 0, knownPoints: 0, points: 0 });
});

test('上限ちょうどは収まり、超えた分が超過になる。見積不足は確認できた合計で超過だけを判定する', () => {
  const limit = { phase: 'active', days: 3, points: 3 };
  const base = { phase: 'active', days: 3, limit: 3 };
  assert.deepEqual(assessLoad(sumEstimates([2, 1]), limit), { ...base, status: 'within', margin: 0 });
  assert.deepEqual(assessLoad(sumEstimates([2, 1.5]), limit), { ...base, status: 'over', excess: 0.5, atLeast: false });
  assert.deepEqual(assessLoad(sumEstimates([1, null]), limit), { ...base, status: 'unknown' });
  assert.deepEqual(assessLoad(sumEstimates([3.5, null]), limit), { ...base, status: 'over', excess: 0.5, atLeast: true });
  assert.deepEqual(assessLoad(sumEstimates([0.5]), { phase: 'active', days: 0, points: 0 }), { phase: 'active', days: 0, limit: 0, status: 'over', excess: 0.5, atLeast: false });
  assert.equal(assessLoad(sumEstimates([1]), null), null);
  assert.equal(assessLoad(sumEstimates([1]), capacityLimit(week, '2026-10-12')), null);
});

test('手動計画：進行中の期間は未完了の合計を残りの稼働日と比べ、完了済みは除く', () => {
  const state = createSample();
  const rows = iterationWorkload(state, 'i5', undefined, '2026-10-07');
  assert.deepEqual(rows.map(row => [row.owner, row.points, row.load.status, row.load.limit, row.load.excess ?? row.load.margin]), [
    ['自分', 4.5, 'over', 3, 1.5], ['協力者A', 2, 'within', 3, 1], ['協力者B', 1, 'within', 3, 2]]);
  state.tasks.find(t => t.id === 'move').status = 'done';
  const done = iterationWorkload(state, 'i5', undefined, '2026-10-07').find(row => row.owner === '自分');
  assert.deepEqual([done.points, done.load.status, done.load.margin], [1.5, 'within', 1.5]);
});

test('手動計画：予定の期間は全期間の稼働日、終了した期間・目標を絞った内訳・未担当には上限を当てない', () => {
  const state = createSample();
  assert.deepEqual(iterationWorkload(state, 'i6', undefined, '2026-10-07').map(row => row.load.limit), [10, 10, 10]);
  assert.ok(iterationWorkload(state, 'i4', undefined, '2026-10-07').every(row => row.load === null));
  assert.ok(iterationWorkload(state, 'i5', 'notice', '2026-10-07').every(row => row.load === null));
  setOwner(state, 'move', null);
  const rows = iterationWorkload(state, 'i5', undefined, '2026-10-07');
  assert.equal(rows.find(row => row.owner === null).load, null);
  assert.equal(rows.find(row => row.owner === '自分').load.status, 'within');
  setIteration(state, 'move', null);
  const orphaned = orderedTasks(state).filter(t => !state.iterations.some(i => i.id === t.iterationId));
  assert.ok(orphaned.length && workloadForTasks(state, orphaned).every(row => row.load === null));
});

test('手動計画：見積のない作業は合計に含めず、確認できた合計が収まる間は未確認にする', () => {
  const state = createSample();
  setEstimate(state, 'move', null);
  const row = iterationWorkload(state, 'i5', undefined, '2026-10-07').find(item => item.owner === '自分');
  assert.deepEqual([row.points, row.knownPoints, row.missingEstimates, row.load.status], [null, 1.5, 1, 'unknown']);
});

const snapshotOf = mutate => {
  const workspace = bookingSampleWorkspace(new Date('2026-10-05T12:00:00Z'));
  const snapshot = workspace.projects[0].githubSnapshot;
  mutate?.(snapshot.planning.issues.reduce((byNumber, issue) => ({ ...byNumber, [issue.number]: issue.projects[0] }), {}));
  return snapshot;
};
const period = (snapshot, title) => githubPlan(snapshot).periods.find(p => p.iteration.title === title);
const summary = rows => rows.map(row => [row.owner, row.points, row.load?.status ?? null]);

test('GitHubの計画：期間ごとに担当別の未完了を、そのProjectの残りの稼働日と比べる', () => {
  const rows = githubPeriodWorkload(period(snapshotOf(), 'It1'), '2026-10-07');
  assert.deepEqual(summary(rows), [['Claude', 3, 'within'], ['Wakua', 0.5, 'within'], [null, 1, null]]);
  assert.equal(rows[0].load.margin, 0);
  assert.equal(rows[0].load.limit, 3);
});

test('GitHubの計画：上限を超えた担当者に超過量を示し、Closedは合計から除く', () => {
  const snapshot = snapshotOf(projects => { projects[5].owner = 'Claude'; });
  const rows = githubPeriodWorkload(period(snapshot, 'It1'), '2026-10-07');
  assert.deepEqual([rows[0].owner, rows[0].points, rows[0].load.status, rows[0].load.excess], ['Claude', 4, 'over', 1]);
  const closed = githubPeriodWorkload(period(snapshotOf(), 'It0'), '2026-10-07');
  assert.deepEqual(summary(closed), [['Codex', 2, null], ['Wakua', 0, null]], '終了した期間には上限を当てない');
});

test('GitHubの計画：予定の期間は全期間の稼働日と比べ、見積未設定は件数にして確認できた合計だけで判定する', () => {
  const upcoming = githubPeriodWorkload(period(snapshotOf(), 'It2'), '2026-10-07');
  assert.deepEqual(upcoming.map(row => row.load.limit), [5, 5]);
  const snapshot = snapshotOf(projects => { projects[4].estimatePoints = null; projects[9].estimatePoints = 0; });
  const [claude, wakua] = githubPeriodWorkload(period(snapshot, 'It1'), '2026-10-07');
  assert.deepEqual(claude.load, { phase: 'active', days: 3, limit: 3, status: 'unknown' });
  assert.deepEqual([claude.points, claude.knownPoints, claude.missingEstimates], [null, 2, 1]);
  assert.deepEqual([wakua.points, wakua.knownPoints, wakua.missingEstimates, wakua.load.status], [null, 0, 1, 'unknown'], 'Estimate 0は未設定と同じ');
});

test('GitHubの計画：担当別の負荷を期間の本文に出し、超過だけを強調して担当名を無害化する', () => {
  const html = renderGithubPeriods(snapshotOf(projects => { projects[5].owner = 'Claude'; }), '2026-10-07');
  assert.match(html, /<span class="workload-chip is-over static"[^>]*data-github-workload="Claude"[^>]*title="上限3pt（残りの稼働日3日 × 1pt）"/);
  assert.match(html, /4pt<\/strong><span class="workload-limit">\/ 3pt<\/span><span class="workload-over">超過1pt<\/span>/);
  assert.match(html, /<span class="workload-chip static"[^>]*data-github-workload="Wakua"/);
  const plain = renderGithubPeriods(snapshotOf(projects => { projects[9].owner = 'A<b>'; }), '2026-10-07');
  assert.ok(plain.includes('data-github-workload="A&lt;b&gt;"') && !plain.includes('A<b>'));
  assert.match(plain, /data-github-workload=""/, '未担当は担当名を空にして並べる');
});

test('表示部品：上限と超過量を値のあとに並べ、未担当と上限のない期間は合計だけにする', () => {
  const over = { owner: '自分', points: 4.5, missingEstimates: 0, load: { status: 'over', limit: 3, days: 3, phase: 'active', excess: 1.5, atLeast: false } };
  assert.equal(workloadFigures(over), '<strong>4.5pt</strong><span class="workload-limit">/ 3pt</span><span class="workload-over">超過1.5pt</span>');
  assert.equal(workloadChipLabel(over), '自分の未完了作業。上限3pt、超過1.5pt');
  assert.equal(workloadChipTitle(over), '上限3pt（残りの稼働日3日 × 1pt）');
  const unknown = { owner: '自分', points: null, missingEstimates: 2, load: { status: 'over', limit: 3, days: 3, phase: 'active', excess: 0.5, atLeast: true } };
  assert.match(workloadFigures(unknown), /未入力<small>2件<\/small>.*超過0.5pt以上/);
  const none = { owner: null, points: 2, missingEstimates: 0, load: null };
  assert.equal(workloadFigures(none), '<strong>2pt</strong>');
  assert.equal(workloadChipLabel(none), '未担当の未完了作業');
  assert.equal(workloadChipTitle(none), '');
  assert.equal(workloadLimitMarkup(null), '');
  assert.match(workloadLimitMarkup(over.load), /<dt>上限<\/dt><dd>3pt<small>残りの稼働日3日 × 1pt<\/small><\/dd><dt>超過<\/dt><dd class="workload-over">1.5pt<\/dd>/);
  assert.match(workloadLimitMarkup({ status: 'within', limit: 5, days: 5, phase: 'upcoming', margin: 2 }), /<dt>余裕<\/dt><dd>2pt<\/dd>/);
});
