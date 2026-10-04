import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {criteriaProgress,goalProgress,createSample} from '../dist/engine.mjs';
const app=readFileSync(new URL('../dist/app.mjs',import.meta.url),'utf8');
const css=readFileSync(new URL('../dist/list.css',import.meta.url),'utf8');
test('ordinary task rows reuse existing completion-criteria metric with explicit achieved/total label',()=>{
 const rows=app.slice(app.indexOf('function iterationRows('),app.indexOf('function iterationGoalGroups('));
 assert.ok(rows.includes('<div class="period-task-criteria">${taskProgressSummary(task)}</div>'));
 const summary=app.slice(app.indexOf('function taskProgressSummary('),app.indexOf('function criteriaProgressText('));
 assert.ok(summary.includes('criteriaProgress(task)'));assert.ok(summary.includes('完了条件 ${progress.percent}%'));assert.ok(summary.includes('達成 ${progress.achieved}/${progress.total}件'));assert.ok(summary.includes('完了条件 未登録'));
 assert.ok(css.includes('.period-task-criteria { display: block;'));assert.ok(css.includes('overflow-wrap: anywhere;'));
});
test('zero criteria remains unknown, unchecked is 0%, partial floors and all checked is 100%',()=>{
 for(const [checks,percent] of [[[],null],[[false,false],0],[[true,false,false],33],[[true,true,false],66],[[true,true],100]])assert.equal(criteriaProgress({criteria:checks.map(checked=>({checked}))}).percent,percent);
});
test('criteria displayed for review status does not promote it to done or change effort completion',()=>{
 const state=createSample(),task=state.tasks.find(t=>t.id==='move');task.status='review';task.criteria.forEach(c=>c.checked=true);
 const before=structuredClone(state);assert.equal(criteriaProgress(task).percent,100);assert.equal(goalProgress(state,'ui').percent,26);assert.equal(task.status,'review');assert.deepEqual(state,before);
});
test('actual baseline has unknown goal estimates while each task retains its supported criteria metric',()=>{
 const workspace=JSON.parse(readFileSync(new URL('../samples/prepared-workspace.json',import.meta.url)));
 for(const p of workspace.projects){for(const g of p.data.goals)assert.equal(goalProgress(p.data,g.id).percent,null);for(const t of p.data.tasks){assert.equal(t.estimatePoints,null);const m=criteriaProgress(t);assert.equal(m.total,t.criteria.length);assert.ok(m.percent===null||m.percent>=0&&m.percent<=100);}}
 assert.ok(app.includes('Estimate未入力 ${progress.missingEstimates}件'));
});
