import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {TestStore} from '../server/test-store.mjs';
import {planValues} from '../dist/testing/plan-model.mjs';
import {caseValues} from '../dist/testing/case-editor.mjs';
import {seedCase,proposal,save,recordFixture} from './support/test-plan-fixture.mjs';
function fixture(t){const dir=mkdtempSync(path.join(tmpdir(),'plans-')),stores=[];const open=()=>{const s=new TestStore(dir,{timeout:10});stores.push(s);return s;};t.after(()=>{for(const s of stores)try{s.close();}catch{}rmSync(dir,{recursive:true,force:true});});return {dir,open,store:open()};}
const code=expected=>e=>e.code===expected;
const env={id:'ios',os:'iOS',version:'18',model:'iPhone'};

test('plan creates each case-condition pair once with no invented execution data; all fields survive restart',t=>{
 const {store,open}=fixture(t),cases=[seedCase(store),seedCase(store)],p=proposal(store,cases);p.conditions.push(env);Object.assign(p,{build:'build1',owner:'Wakua',purpose:'予約の受入',start:'2026-11-14',end:'2026-11-15',issue:'https://example.com/1',assignees:{[cases[0].id]:'担当A'}});
 const saved=save(store,p);assert.equal(saved.results.length,4);for(const r of saved.results)assert.deepEqual([r.status,r.performer,r.date,r.recordedAt,r.retest],['Not Run',null,null,null,false]);
 store.close();const other=open();assert.deepEqual(other.loadPlans().plans,[saved]);assert.equal(other.newPlan().id,'TP-2');assert.equal(other.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});
test('version 1 migration preserves every existing case and receipt',t=>{
 const {store,open}=fixture(t),c=seedCase(store);const rows=store.db.prepare('SELECT * FROM cases').all(),receipts=store.db.prepare('SELECT * FROM case_receipts').all();
 store.db.exec('DROP TABLE plan_receipts; DROP TABLE plan_history; DROP TABLE plan_units; DROP TABLE test_plans; DROP TABLE plan_ids; PRAGMA user_version=1;');store.close();const migrated=open();
 assert.deepEqual(migrated.db.prepare('SELECT * FROM cases').all(),rows);assert.deepEqual(migrated.db.prepare('SELECT * FROM case_receipts').all(),receipts);assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version,2);assert.equal(save(migrated,proposal(migrated,[c])).results.length,1);
});
test('failed additive migration rolls back schema and retains version 1 data',t=>{
 const {store,dir}=fixture(t);seedCase(store);const rows=store.db.prepare('SELECT * FROM cases').all();store.db.exec('DROP TABLE plan_receipts; DROP TABLE plan_history; DROP TABLE plan_units; DROP TABLE test_plans; DROP TABLE plan_ids; CREATE TABLE plan_history(conflicting INTEGER); PRAGMA user_version=1;');store.close();
 assert.throws(()=>new TestStore(dir));const db=new DatabaseSync(path.join(dir,'tests.sqlite'));try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);assert.deepEqual(db.prepare('SELECT * FROM cases').all(),rows);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='test_plans'").get(),undefined);}finally{db.close();}
});
test('only Active cases can be added; later deprecation keeps existing membership and current definition',t=>{
 const {store}=fixture(t),active=seedCase(store),draft=seedCase(store,'下書き','','Draft'),p=save(store,proposal(store,[active]));
 assert.throws(()=>save(store,{...p,caseIds:[...p.caseIds,draft.id]}),code('case_not_active'));
 store.save({values:{...caseValues(active),status:'Deprecated',title:'最新のタイトル'},revision:1,requestId:'deprecated'});
 assert.equal(save(store,{...p,name:'名前を変更'}).caseIds[0],active.id);assert.equal(store.load().cases[0].title,'最新のタイトル');
});
test('invalid fields, dates, duplicates and result injection leave DB unchanged',t=>{
 const {store}=fixture(t),p=save(store,proposal(store,[seedCase(store)]));
 for(const change of [{start:'2026-99-99'},{start:'2026-02-30'},{caseIds:[]},{conditions:[]},{conditions:[env,env]},{conditions:[env,{...env,id:'other'}]},{assignees:{'TC-999':'X'}},{name:' '},{state:'Unknown'}])assert.throws(()=>save(store,{...p,...change}),code('invalid_plan'));
 // planValues drops non-writable result fields: the public packet still rejects injected fields.
 assert.throws(()=>store.savePlan({values:{...planValues(p),results:[]},revision:1,requestId:'inject',action:'save',acknowledgeWarnings:false}),code('invalid_plan'));
 assert.deepEqual(store.loadPlans().plans,[p]);
});
test('adding and excluding unrecorded targets creates Not Run and preserves prior selection in history',t=>{
 const {store}=fixture(t),a=seedCase(store),b=seedCase(store),p=save(store,proposal(store,[a]));
 const added=save(store,{...p,caseIds:[a.id,b.id],conditions:[...p.conditions,env],assignees:{[b.id]:'担当B'}});assert.equal(added.results.length,4);
 const removed=save(store,{...added,caseIds:[b.id],assignees:{[b.id]:'担当B'},conditions:[env]});assert.equal(removed.results.length,1);assert.ok(removed.history.some(h=>h.before?.caseIds.includes(a.id)&&!h.after.caseIds.includes(a.id)));assert.equal(store.load().cases.length,2);
});
test('recorded targets cannot be removed, renamed or replaced while unrecorded pairs can be excluded',t=>{
 const {store}=fixture(t),a=seedCase(store),b=seedCase(store),p=save(store,proposal(store,[a,b]));
 store.db.prepare("UPDATE plan_units SET status='Failed',performed_by='A',performed_at='time',recorded_at='time' WHERE case_id=?").run(Number(a.id.slice(3)));
 const before=store.loadPlans().plans[0];
 for(const next of [{...before,caseIds:[b.id]},{...before,conditions:[env]},{...before,conditions:before.conditions.map(e=>({...e,version:'12'}))}])assert.throws(()=>save(store,next),code('recorded_target'));
 const kept=save(store,{...before,caseIds:[a.id]});assert.deepEqual(kept.results,before.results.filter(r=>r.caseId===a.id));
});
test('completion blocks Not Run and requires acknowledgement for unresolved results; reopen retains all results',t=>{
 const {store}=fixture(t),p=save(store,proposal(store,Array.from({length:5},()=>seedCase(store))));
 assert.throws(()=>save(store,{...p,state:'Completed'},{acknowledgeWarnings:true}),code('not_run_remaining'));assert.deepEqual(store.loadPlans().plans,[p]);
 const recorded=recordFixture(store,p,['Passed','Failed','Blocked','Skipped','Not Applicable']);
 assert.throws(()=>save(store,{...recorded,state:'Completed'}),code('completion_warning'));
 const done=save(store,{...recorded,state:'Completed'},{acknowledgeWarnings:true});assert.ok(done.history.some(h=>h.text==='計画を完了'));
 assert.throws(()=>save(store,{...done,conditions:[...done.conditions,env]}),code('plan_closed'));
 const reopened=save(store,{...done,state:'In Progress'});assert.deepEqual(reopened.results,recorded.results);assert.ok(reopened.history.some(h=>h.text==='計画を再開'));
 assert.throws(()=>save(store,{...reopened,state:'Draft'}),code('invalid_transition'));
});
test('result-free Draft deletion retains case definitions, units and audit history and cannot reuse ID',t=>{
 const {store,open}=fixture(t),p=save(store,proposal(store,[seedCase(store)])),request={action:'delete',acknowledgeWarnings:false,requestId:'delete-once',revision:p.revision,values:planValues(p)};
 const result=store.savePlan(request);assert.deepEqual(store.loadPlans().plans,[]);assert.equal(store.load().cases.length,1);assert.equal(store.db.prepare('SELECT count(*) n FROM plan_units').get().n,1);assert.ok(store.db.prepare("SELECT event FROM plan_history WHERE event LIKE '%削除'").get());
 store.close();const other=open();assert.deepEqual(other.savePlan(request),result);assert.equal(other.newPlan().id,'TP-2');assert.throws(()=>save(other,p),code('plan_deleted'));
});
test('recorded Draft and active plan cannot be deleted',t=>{
 const {store}=fixture(t),p=save(store,proposal(store,[seedCase(store)]));recordFixture(store,p);
 assert.throws(()=>save(store,p,{action:'delete'}),code('plan_delete_forbidden'));
 const started=save(store,{...p,state:'In Progress'});assert.throws(()=>save(store,started,{action:'delete'}),code('plan_delete_forbidden'));
});
test('stale concurrent update provides current plan without losing pending input',t=>{
 const {store,open}=fixture(t),p=save(store,proposal(store,[seedCase(store)])),other=open(),next=save(store,{...p,name:'先に保存'}),pending={...p,name:'後の入力'};
 assert.throws(()=>save(other,pending),e=>e.code==='plan_conflict'&&e.current.name==='先に保存');assert.equal(pending.name,'後の入力');assert.deepEqual(other.loadPlans().plans,[next]);
});
test('lost response replay survives restart and does not roll back a newer edit or duplicate history',t=>{
 const {store,open}=fixture(t),p=proposal(store,[seedCase(store)]),request={values:planValues(p),revision:null,requestId:'once',action:'save',acknowledgeWarnings:false};const first=store.savePlan(request),next=save(store,{...first,name:'最新'});store.close();const other=open();assert.deepEqual(other.savePlan(request),first);assert.deepEqual(other.loadPlans().plans,[next]);assert.throws(()=>other.savePlan({...request,values:{...request.values,name:'different'}}),code('request_reused'));
});
test('failure before receipt commits rolls back plan, units and history; same operation retries after repair',t=>{
 const {store}=fixture(t),p=save(store,proposal(store,[seedCase(store)]));store.db.exec("CREATE TRIGGER fail_plan BEFORE INSERT ON plan_receipts BEGIN SELECT RAISE(ABORT,'failure'); END;");assert.throws(()=>save(store,{...p,conditions:[...p.conditions,env]}));assert.deepEqual(store.loadPlans().plans,[p]);store.db.exec('DROP TRIGGER fail_plan');assert.equal(save(store,{...p,conditions:[...p.conditions,env]}).results.length,2);
});
test('SQLite writer lock does not lose data; save succeeds when the lock is released',t=>{
 const {store,open}=fixture(t),p=save(store,proposal(store,[seedCase(store)])),other=open();other.db.exec('BEGIN IMMEDIATE');try{assert.throws(()=>save(store,{...p,name:'retry'}));assert.deepEqual(store.loadPlans().plans,[p]);}finally{other.db.exec('ROLLBACK');}assert.equal(save(store,{...p,name:'retry'}).name,'retry');
});

test('execution fields cannot invent a performerless recorded result or an execution date for Not Run',t=>{
 const {store}=fixture(t);save(store,proposal(store,[seedCase(store)]));
 assert.throws(()=>store.db.exec("UPDATE plan_units SET status='Passed',performed_at='now',recorded_at='now'"));
 assert.throws(()=>store.db.exec("UPDATE plan_units SET performed_at='now'"));
});
test('completed plan can be archived without changing results; archived is not reopened implicitly',t=>{
 const {store}=fixture(t),p=save(store,proposal(store,[seedCase(store)])),recorded=recordFixture(store,p);
 const done=save(store,{...recorded,state:'Completed'},{acknowledgeWarnings:true}),archived=save(store,{...done,state:'Archived'});
 assert.deepEqual(archived.results,done.results);assert.throws(()=>save(store,{...archived,state:'In Progress'}),code('invalid_transition'));
});
