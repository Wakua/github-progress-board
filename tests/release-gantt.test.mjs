import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseGanttModel, ganttProjects } from '../dist/release-gantt-model.mjs';
import { ganttSnapshot } from './gantt-fixture.mjs';
import { scheduleSnapshot, repo, external, url } from './github-schedule-fixture.mjs';
const options={selectedProjectId:'sample-project',baseDate:'2026-11-02'};
test('Projectを指定するまで計算せず、snapshotと既存分類を変更しない',()=>{
  const s=ganttSnapshot(),before=structuredClone(s);
  assert.equal(releaseGanttModel(s).result,null);
  assert.equal(releaseGanttModel(s,{selectedProjectId:'unknown'}).result,null);
  const m=releaseGanttModel(s,options);
  assert.equal(m.result.milestones[0].finish.date,'2026-11-05');
  assert.equal(m.input.issues.find(i=>i.key.endsWith('/210')).category,'着手可能');
  assert.equal(m.result.tasks.find(i=>i.key.endsWith('/210')).earliestStart.date,'2026-11-05');
  assert.deepEqual(s,before);
});
test('再取得した進捗率と基準日の変更で計算し直す',()=>{
  const before=releaseGanttModel(ganttSnapshot(),options);
  const after=releaseGanttModel(ganttSnapshot('basic',50),options);
  assert.notDeepEqual(after.result.milestones[0].finish,before.result.milestones[0].finish);
  const tomorrow=releaseGanttModel(ganttSnapshot(),{...options,baseDate:'2026-11-03'});
  assert.equal(tomorrow.result.milestones[0].finish.date,'2026-11-06');
  const saturday=releaseGanttModel(ganttSnapshot(),{...options,baseDate:'2026-10-31'});
  assert.equal(saturday.result.calculationStartDate,'2026-11-02');
});
test('未入力・循環では独立した日程を残し、確定できない結果を出さない',()=>{
  for(const name of ['missing','cycle']) {
    const m=releaseGanttModel(ganttSnapshot(name),options);
    assert.equal(m.result.milestones[0].state,'incomplete');
    assert.equal(m.result.milestones[0].finish,null);
    assert.equal(m.result.milestones[0].criticalTaskKeys.length,0);
    assert.ok(m.result.tasks.some(t=>t.earliestStart));
    assert.ok(m.result.diagnostics.length);
  }
});
test('0日・端数・期日なし・全完了・閉じたMilestoneを保持する',()=>{
  const fraction=releaseGanttModel(ganttSnapshot('fraction'),options);
  assert.ok(fraction.result.tasks.some(t=>t.durationDays===0&&t.completion.value!=='done'));
  assert.equal(fraction.result.milestones[0].dueDifference.display,'0.01日未満');
  assert.equal(releaseGanttModel(ganttSnapshot('noDue'),options).result.milestones[0].dueDate,null);
  assert.equal(releaseGanttModel(ganttSnapshot('completed'),options).result.milestones[0].state,'completed');
  assert.equal(fraction.result.milestones[1].state,'excluded');
});
test('外部repositoryの同番号を別作業として表示し、出典Projectを推測しない',async()=>{
  const s=await scheduleSnapshot();
  const m=releaseGanttModel(s,{selectedProjectId:'P1',baseDate:'2026-10-05'});
  assert.equal(m.input.issues.find(i=>i.key===url(1)).title,'#1 QA 1');
  assert.equal(m.input.issues.find(i=>i.key===url(1,external)).title,'qa-external/other#1 QA external 1');
  assert.equal(m.input.issues.find(i=>i.key===url(2,external)).planning.sourceProjectId,null);
  assert.equal(m.result.milestones[0].state,'incomplete');
  const sourceProjectIds=Object.fromEntries(s.planning.schedule.issues.filter(i=>!i.key.startsWith(repo+'/')).map(i=>[i.key,'P2']));
  const chosen=releaseGanttModel(s,{selectedProjectId:'P1',sourceProjectIds,baseDate:'2026-10-05'});
  assert.equal(chosen.result.milestones[0].state,'calculated');
  assert.ok(chosen.result.overlapUnchecked.some(i=>i.reasons.includes('outside-project')));
});
test('古いsnapshotを0%で補わず、Projectの削除と空の取得を扱う',()=>{
  const s=ganttSnapshot();delete s.planning.schedule;
  const m=releaseGanttModel(s,options);
  assert.equal(m.result.milestones[0].state,'incomplete');
  assert.ok(m.result.diagnostics.some(d=>d.field==='workProgressPercent'));
  assert.equal(ganttProjects(ganttSnapshot('empty')).length,0);
  assert.equal(releaseGanttModel(null),null);
});

