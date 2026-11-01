import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseGanttModel, ganttProjects } from '../dist/release-gantt-model.mjs';
import { releaseGoalGroups, goalProgress, goalSchedule } from '../dist/gantt-groups.mjs';
import { releaseDependencies, projectDependencies } from '../dist/gantt-dependencies.mjs';
import { githubPlan, milestoneSources } from '../dist/github-planning.mjs';
import { githubItemPlanning } from '../dist/github-planning-view.mjs';
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
test('未設定の子孫は最も近いMilestoneに一度だけ入り、一覧・詳細・日程が一致する', () => {
  const snapshot = ganttSnapshot('inherited');
  const issue = n => snapshot.planning.issues.find(i => i.number === n);
  const check = expected => {
    const plan = githubPlan(snapshot);
    assert.deepEqual(plan.releases.map(m => m.tasks.map(t => t.number)), expected);
    const { result } = releaseGanttModel(snapshot, options);
    assert.deepEqual(result.milestones.map(m => m.targetTaskKeys.map(k => Number(k.split('/').at(-1)))), expected);
  };
  check([[201, 202, 301], [401]]);
  assert.match(githubItemPlanning(snapshot, 301), /#300から継承/);
  assert.doesNotMatch(githubItemPlanning(snapshot, 401), /から継承/);
  assert.equal(issue(301).milestoneNumber, null);
  issue(305).milestoneNumber = 2;
  check([[201, 202], [301, 401]]);
  assert.match(githubItemPlanning(snapshot, 301), /#305から継承/);
  issue(200).milestoneNumber = null;
  check([[], [301, 401]]);
  delete snapshot.planning.schedule;
  check([[], [301, 401]]);
});

test('別repositoryの同番号の親からMilestoneを継承しない', () => {
  const issues = [{ number: 9, parent: null, milestoneNumber: 1 },
    { number: 1, parent: { number: 9, url: url(9, external) }, milestoneNumber: null }];
  assert.equal(milestoneSources(repo, issues).has(1), false);
});

test('ガントの親名を整え、末端の原題・日程・依存・Milestoneの継承を保つ', () => {
  const snapshot = ganttSnapshot('inherited');
  const expected = releaseGanttModel(snapshot, options).result;
  for (const item of snapshot.items) {
    item.title = '[Hub] ' + item.title;
    snapshot.planning.schedule.issues.find(i => i.key === item.url).title = item.title;
  }
  for (const withSchedule of [true, false]) {
    if (!withSchedule) delete snapshot.planning.schedule;
    const model = releaseGanttModel(snapshot, options);
    const title = number => model.input.issues.find(i => i.key === snapshot.repositoryUrl + '/issues/' + number).title;
    assert.equal(title(200), '#200 予約の変更を受け付ける');
    assert.equal(title(305), '#305 メール通知');
    assert.equal(title(201), '#201 [Hub] 変更内容を保存する');
    assert.deepEqual(model.result.milestones[0].targetTaskKeys, expected.milestones[0].targetTaskKeys);
    if (withSchedule) assert.deepEqual(model.result, expected);
    assert.equal(snapshot.items.find(i => i.number === 200).title, '[Hub] 予約の変更を受け付ける');
  }
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

test('同じ親をリリースごとに集計し、対象外の前提を分母に含めない', () => {
  const model = releaseGanttModel(ganttSnapshot('goals'), options);
  const sources = new Map(model.input.issues.map(issue => [issue.key, issue]));
  function summaries(milestone) {
    const groups = releaseGoalGroups(milestone, model.result.tasks, model.input.issues);
    return new Map(groups.filter(group => group.key !== 'other-work')
      .map(group => [group.key.split('/').at(-1), goalProgress(group, sources)]));
  }
  const [a,b] = model.result.milestones.map(summaries);
  assert.deepEqual(a.get('200'),{count:2, percent:88, gaps:[]});
  assert.deepEqual(b.get('200'),{count:1, percent:null, gaps:['進捗未入力']});
  assert.equal(a.get('300').percent,0);
  assert.equal(a.size,2);
});

test('全件Openでも7件の加重進捗を算出し、不足・不正があれば部分集計しない', () => {
  const read = value => ({value,problem:null});
  const sources = new Map(Array.from({length:7}, (_,n) => [n,{
    planning:{estimatePoints:read(n === 0 ? 4 : 1),workProgressPercent:read(n === 6 ? 80 : 100)},
  }]));
  const group = {children:[...sources.keys()].map(key => ({key,task:{key}}))};
  assert.equal(goalProgress(group,sources).percent,98);
  const planning = sources.get(6).planning;
  planning.workProgressPercent = read(101);
  assert.deepEqual(goalProgress(group,sources).gaps,['進捗不正な値']);
  planning.workProgressPercent = {value:null,problem:'not-fetched'};
  assert.deepEqual(goalProgress(group,sources).gaps,['進捗未取得']);
  planning.estimatePoints = read(null);
  assert.equal(goalProgress(group,sources).percent,null);
});

test('親の期間は所属する子の最早開始と最遅終了に限り、日程不明の子を数える', () => {
  const snapshot = ganttSnapshot('goals');
  const input = snapshot.planning.schedule.issues;
  const work = n => input.find(i => i.key.endsWith('/'+n)).projects[0];
  function range(release, parent) {
    const model = releaseGanttModel(snapshot,options);
    const groups = releaseGoalGroups(model.result.milestones[release], model.result.tasks, model.input.issues);
    return goalSchedule(groups.find(group => group.key.endsWith('/'+parent)));
  }
  assert.equal(range(0,200).earliestFinish.coordinate,0.6);
  assert.equal(range(0,300).earliestFinish.coordinate,2);
  assert.equal(range(1,200).earliestStart,null); // Outside prerequisite #201 has dates.
  work(401).workProgressPercent.value = 0;
  assert.equal(range(0,200).earliestFinish.coordinate,0.6);
  assert.equal(range(1,200).earliestFinish.coordinate,2);
  work(202).workProgressPercent.value = null;
  const partial = range(0,200);
  assert.deepEqual([partial.scheduled,partial.count,partial.earliestStart.coordinate,partial.earliestFinish.coordinate],[1,2,0,0]);
});

test('閉じた親ペアに末端の根拠をまとめ、別リリースの同じ親には投影しない', () => {
  const model=releaseGanttModel(ganttSnapshot('dependencies'),options);
  const [a,b]=model.result.milestones;
  const id=n=>model.input.issues.find(i=>i.key.endsWith('/'+n)).key;
  function pairs(m) {
    const groups=releaseGoalGroups(m,model.result.tasks,model.input.issues);
    const {edges}=releaseDependencies(model.input,model.result,m,groups);
    return projectDependencies(edges,groups,new Set(groups.map(g=>g.key)));
  }
  const cross=pairs(a).find(p=>p.from===id(200) && p.to===id(300));
  assert.deepEqual(cross.edges.map(e=>[e.from,e.to]),[[id(201),id(301)],[id(202),id(301)]]);
  assert.ok(pairs(a).find(p=>p.internal && p.from===id(200)));
  assert.ok(pairs(b).find(p=>p.from===id(201) && p.to===id(200)));
});

test('計算辺が作られない登録済みの前提も保存し、他のリリースだけの関係を除く', () => {
  const model=releaseGanttModel(ganttSnapshot('dependencies'),options);
  const milestone=model.result.milestones[1];
  const groups=releaseGoalGroups(milestone,model.result.tasks,model.input.issues);
  const {edges}=releaseDependencies(model.input,{edges:[],relations:[]},milestone,groups);
  assert.ok(edges.some(e=>e.from.endsWith('/201') && e.to.endsWith('/401')));
  assert.ok(!edges.some(e=>e.from.endsWith('/202') && e.to.endsWith('/301')));
});
