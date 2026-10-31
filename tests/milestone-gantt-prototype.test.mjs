import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMilestoneSchedule } from '../dist/milestone-schedule.mjs';
import { samples, issueKey } from '../docs/prototypes/milestone-gantt-samples.mjs';
import { axisFor, calendarPosition, positionText, dueText, diagnosticText, isoDate } from '../docs/prototypes/milestone-gantt-view.mjs';

test('全サンプルが計算契約を満たし、日週月の座標変換で計算結果を変えない', () => {
  for (const sample of Object.values(samples)) {
    const result = calculateMilestoneSchedule(sample.input), before = structuredClone(result);
    assert.equal(result.status, 'calculated', sample.label);
    assert.equal(result.milestones[1].state, 'excluded');
    for (const scale of ['day', 'week', 'month']) {
      const axis = axisFor(result, result.milestones[0], scale);
      for (const task of result.tasks) {
        for (const position of [task.earliestStart, task.earliestFinish].filter(Boolean)) {
          assert.ok(calendarPosition(position) >= axis.start.getTime(), sample.label);
          assert.ok(calendarPosition(position) < axis.end.getTime(), sample.label);
        }
      }
      assert.equal(axis.ticks[0].start.getTime(), axis.start.getTime());
      assert.equal(axis.ticks.at(-1).end.getTime(), axis.end.getTime());
    }
    assert.deepEqual(result, before);
  }
});
test('0日の未完了、小数位置、丸めると0の超過を表示する', () => {
  const result = calculateMilestoneSchedule(samples.fraction.input);
  const zero = result.tasks.find(t => t.key === issueKey(201));
  assert.equal(zero.completion.value, 'not-done');
  assert.equal(zero.durationDisplay, '0日');
  assert.deepEqual(zero.earliestStart, zero.earliestFinish);
  const half = result.tasks.find(t => t.key === issueKey(202));
  assert.equal(positionText(half.earliestFinish), '2026/11/02 日内50%');
  assert.equal(dueText(result.milestones[0].dueDifference), '0.01日未満超過');
});
test('金曜から月曜、年境界、暦月の幅と土日の期日を保持する', () => {
  const result = calculateMilestoneSchedule(samples.boundary.input);
  const friday = result.tasks.find(t => t.key === issueKey(202));
  assert.equal(friday.earliestStart.date, '2027-01-01');
  assert.equal(friday.earliestFinish.date, '2027-01-04');
  assert.equal(calendarPosition(friday.earliestFinish) - calendarPosition(friday.earliestStart), 4 * 86400000);
  assert.equal(result.milestones[0].dueDate, '2027-01-03');
  assert.equal(dueText(result.milestones[0].dueDifference), '1.5日超過');
  const axis = axisFor(result, result.milestones[0], 'month');
  assert.equal(isoDate(axis.start), '2026-12-01');
  assert.deepEqual(axis.ticks.map(t => (t.end-t.start)/86400000), [31,31,28]);
});
test('不足と循環を具体的に示し、既知の作業の日程は残す', () => {
  const missing = calculateMilestoneSchedule(samples.missing.input);
  assert.equal(diagnosticText(missing.diagnostics[0]), '作業進捗率：未入力');
  assert.equal(missing.milestones[0].finish, null);
  assert.ok(missing.tasks.find(t => t.key === issueKey(201)).earliestStart);
  assert.equal(missing.tasks.find(t => t.key === issueKey(210)).earliestStart, null);
  const cycle = calculateMilestoneSchedule(samples.cycle.input);
  assert.equal(diagnosticText(cycle.diagnostics[0]), '前提：循環');
  assert.deepEqual(cycle.cycles[0].taskKeys, [issueKey(201), issueKey(202)]);
});
