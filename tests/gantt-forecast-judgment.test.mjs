import test from 'node:test';
import assert from 'node:assert/strict';
import { samples, issueKey } from '../docs/prototypes/milestone-gantt-samples.mjs';
import { calculateMilestoneSchedule } from '../dist/milestone-schedule.mjs';
import { incompleteForecast } from '../dist/gantt-forecast-judgment.mjs';

const copy = name => structuredClone(samples[name].input);
function forecast(input, index = 0) {
  const result = calculateMilestoneSchedule(input);
  return incompleteForecast(result, result.milestones[index], new Map(input.issues.map(i => [i.key, i])));
}
const issue = (input, n) => input.issues.find(i => i.key === issueKey(n));

test('予測がなくても具体的な未入力と期日より後の割当を別々に読める', () => {
  const input = copy('basic');
  input.milestones[0].dueDate = '2026-11-01';
  for (const field of ['iteration', 'estimatePoints', 'workProgressPercent']) issue(input,201).planning[field].value = null;
  issue(input,202).planning.workProgressPercent.value = null;
  const facts = forecast(input);
  assert.equal(facts.label, '期日内に終わるか判断できません');
  assert.deepEqual(facts.causes, ['#201 見積・割当期間・作業進捗率が未入力', '#202 作業進捗率が未入力']);
  assert.equal(facts.allocation, '#202 の割当開始は11/2（期日後）');
});

test('期日当日の割当と期日をまたぐ割当、期日のない計画を区別する', () => {
  const input = copy('missing'), due = input.milestones[0].dueDate;
  for (const i of input.issues) i.planning.iteration.value = {startDate:due, endDate:due};
  assert.equal(forecast(input).allocation, null);
  issue(input,201).planning.iteration.value.endDate = '2026-11-08';
  assert.equal(forecast(input).allocation, '#201 の割当期間は11/8まで（期日をまたぐ）');
  input.milestones[0].dueDate = null;
  assert.deepEqual(forecast(input), {label:'完了見込みを判断できません', causes:['#202 作業進捗率が未入力'], allocation:null});
});

test('別リリース・完了済みの作業と未確定の割当を判断材料に含めない', () => {
  const input = copy('basic');
  input.milestones[0].dueDate = '2026-11-01';
  input.milestones[0].tasks = {keys:[issueKey(201),issueKey(202)], totalCount:2, complete:true, problem:null};
  input.milestones[1].state = 'open';
  input.milestones[1].tasks = {keys:[issueKey(210)], totalCount:1, complete:true, problem:null};
  issue(input,201).completion.value = 'done';
  issue(input,202).planning.sourceProblem = 'unselected';
  const facts = forecast(input);
  assert.deepEqual(facts.causes, ['#202 出典Project：未指定']);
  assert.equal(facts.allocation, null);
});

test('循環の当事者を示し、空・全作業完了・計算済みには予測不足の警告を足さない', () => {
  assert.deepEqual(forecast(copy('cycle')).causes,['#201・#202 の前提が循環']);
  for (const name of ['empty','completed','basic']) assert.equal(forecast(copy(name)),null);
});
