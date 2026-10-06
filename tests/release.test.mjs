import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseSummaries, releasePanelMarkup } from '../dist/release.mjs';
import { bookingSampleWorkspace } from '../scripts/make-booking-sample.mjs';

const TODAY = '2026-10-05';
const snapshot = bookingSampleWorkspace(new Date('2026-10-05T12:00:00Z')).projects[0].githubSnapshot;
const [r1, r2] = releaseSummaries(snapshot, TODAY);
const labelsOf = (summary, number) => summary.overflow.find(row => row.task.number === number)?.labels;

test('Milestoneごとに、期日・残りの期間数・残りのptを出す', () => {
  assert.deepEqual([r1.due, r1.iterations, r1.remainingPoints, r1.late], ['2026-10-18', 2, 9.5, false]);
  assert.deepEqual([r2.due, r2.iterations, r2.remainingPoints], ['2026-11-01', 4, 6]);
});

test('はみ出しは、期日より後・未割当・見積なしの作業だけを理由つきで出す', () => {
  assert.deepEqual(labelsOf(r1, 8), ['期日より後']);
  assert.deepEqual(labelsOf(r1, 7), ['未割当', '見積なし']);
  assert.deepEqual(r1.overflow.map(row => row.task.number).sort((a, b) => a - b), [7, 8]);
  assert.deepEqual(labelsOf(r2, 17), ['期日より後']);
  assert.equal(r2.overflow.length, 1);
});

test('要対応と期限切れは件数だけを数え、作業名は出さない', () => {
  assert.deepEqual([r1.attention, r1.overdue, r2.attention, r2.overdue], [3, 1, 0, 0]);
  const html = releasePanelMarkup([r1]);
  assert.match(html, /要対応 3件（期限切れ 1件） →/);
  assert.ok(html.includes('data-view-go="attention"'));
  assert.ok(!html.includes('data-id="issue:6"'), '期限切れの作業名は、要対応に任せる');
});

test('最長の前提の流れは、見積の合計が最大の流れ。完了予定日は出さない', () => {
  assert.deepEqual([r1.path.tasks.map(t => t.number), r1.path.points, r1.path.missing], [[3, 4], 3, 0]);
  assert.deepEqual([r2.path.tasks.map(t => t.number), r2.path.points], [[14, 15], 4]);
  const html = releasePanelMarkup([r1, r2]);
  assert.match(html, /#3<\/button> → <button[^>]*>#4<\/button> · 3pt/);
  assert.ok(html.includes('data-action="github-item" data-id="issue:3"'), '流れの作業は、詳細を開くボタン');
  assert.match(html, /あと2期間 · 残り9\.5pt/);
  assert.ok(!/完了予定|予測/.test(html));
});

test('期日を過ぎたMilestoneと、計画情報のない場合を扱う', () => {
  const [late] = releaseSummaries(snapshot, '2026-10-20');
  assert.ok(late.late);
  assert.match(releasePanelMarkup([late]), /期日超過/);
  assert.equal(releaseSummaries({ ...snapshot, planning: undefined }, TODAY), null);
  assert.match(releasePanelMarkup(null), /未取得/);
  assert.match(releasePanelMarkup([]), /Milestone/);
  const none = { ...r2, overflow: [], attention: 0, overdue: 0, path: null };
  assert.match(releasePanelMarkup([none]), /はみ出しなし/);
});

const changed = edit => { const copy = structuredClone(snapshot); edit(id => copy.planning.issues.find(i => i.number === id)); return releaseSummaries(copy, TODAY); };
const move = (issue, iteration) => { issue.projects[0].iteration = iteration; };
const IT = { id: 'itx', title: 'ItX', startDate: '2026-10-12', duration: 14 };

test('期日をまたいで終わる割当も、期日より後に入れる', () => {
  const [spanning] = changed(issue => move(issue(4), IT));
  assert.deepEqual(labelsOf(spanning, 4), ['期日より後']);
  assert.equal(labelsOf(r1, 4), undefined, '期日以内に終わる割当は入れない');
});

test('前提だけが期限切れの作業も、期限切れの件数に数える', () => {
  const [late] = changed(issue => move(issue(9), { id: 'it0', title: 'It0', startDate: '2026-09-28', duration: 7 }));
  assert.equal(r1.overdue, 1);
  assert.equal(late.overdue, 3, '#6（自身）・#9（自身）・#10（前提が期限切れ）');
  assert.equal(late.attention, 4, '#5（担当なし）も要対応');
});

test('最長の流れは、別のMilestoneにある未完了の前提もたどる', () => {
  const [moved] = changed(issue => { issue(3).milestoneNumber = 2; });
  assert.deepEqual(moved.path.tasks.map(t => t.number), [3, 4]);
  assert.equal(moved.path.points, 3);
});
