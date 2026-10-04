import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planPreparedEstimates,applyPreparedEstimates,isProvisionalEstimate,ESTIMATE_SOURCE} from '../dist/estimate-proposals.mjs';
import {emptyWorkspace,validateWorkspace,createWorkspaceStore,STORAGE_KEY,updateProject} from '../dist/workspace.mjs';
import {setEstimate,goalProgress} from '../dist/engine.mjs';
import {createCloudWorkspaceStore} from '../dist/cloud-workspace.mjs';
import {sqliteD1,memoryStorage} from './cloud-fixtures.mjs';
import worker from '../server/worker.mjs';
const baseline=JSON.parse(readFileSync(new URL('../samples/prepared-workspace.json',import.meta.url)));
const proposal=JSON.parse(readFileSync(new URL('../dist/prepared-estimates.json',import.meta.url)));
const copy=()=>structuredClone(baseline),plan=w=>planPreparedEstimates(w,baseline,proposal),apply=(w,p=plan(w))=>applyPreparedEstimates(w,baseline,proposal,p.changes,'2026-10-04T04:55:00Z');
const withoutEstimates=p=>({...p,data:{...p.data,history:[],tasks:p.data.tasks.map(t=>{const {estimateProvenance,...rest}=t;return {...rest,estimatePoints:null};})}});
test('18 proposals use one point per workday and expose ranges/rationale, including retrospective label',()=>{
 const w=copy(),before=structuredClone(w),p=plan(w);assert.equal(p.changes.length,18);assert.equal(p.skipped.length,0);assert.equal(p.changes.filter(c=>c.retrospective).length,10);assert.equal(proposal.pointsPerWorkday,1);assert.equal(p.addedPoints,20.25);
 assert.ok(p.changes.every(c=>c.rationale&&c.range[0]<=c.points&&c.range[1]>=c.points));assert.deepEqual(w,before);
});
test('estimate-only apply preserves every other task field, criteria check, status, evidence and all prior history',()=>{
 const w=copy();w.projects[0].data.tasks[1].evidence='User edit';w.projects[0].data.tasks[1].owner='Owner';w.projects[0].data.tasks[1].customMetadata={keep:true};
 const before=structuredClone(w);apply(w);
 for(let i=0;i<w.projects.length;i++){assert.deepEqual(withoutEstimates(w.projects[i]),withoutEstimates(before.projects[i]));assert.deepEqual(w.projects[i].data.history.slice(w.projects[i].data.tasks.length),before.projects[i].data.history);}
 assert.equal(w.projects.flatMap(p=>p.data.tasks).filter(isProvisionalEstimate).length,18);assert.equal(plan(w).changes.length,0);assert.equal(plan(w).skipped.length,18);validateWorkspace(w);
});
test('nonnull user estimate remains untouched and only null estimates are eligible',()=>{
 const w=copy();w.projects[0].data.tasks[0].estimatePoints=7.5;const p=plan(w);assert.equal(p.changes.length,17);assert.match(p.skipped[0].reason,/入力済み/);apply(w,p);assert.equal(w.projects[0].data.tasks[0].estimatePoints,7.5);assert.equal(w.projects[0].data.tasks[0].estimateProvenance,undefined);
});
test('changed task title, criteria texts and dependencies are conservatively skipped',()=>{
 for(const mutate of [t=>t.title+=' changed',t=>t.criteria[0].text+=' changed',t=>t.deps=[]]){
  const w=copy();const task=w.projects[0].data.tasks.find(t=>t.deps.length)||w.projects[0].data.tasks[1];mutate(task);const p=plan(w);assert.ok(p.skipped.some(s=>s.taskId===task.id&&/原本と異なる/.test(s.reason)));
 }
});
test('repository mismatch, missing IDs, unknown tasks and preexisting custom annotation are not overwritten',()=>{
 const w=copy();w.projects[0].repositoryUrl='https://github.com/other/repo';const p=plan(w);assert.equal(p.changes.length,14);assert.ok(p.skipped.slice(0,4).every(s=>/repository/.test(s.reason)));
 const empty=plan(emptyWorkspace());assert.equal(empty.changes.length,0);assert.equal(empty.skipped.length,18);
 const custom=copy();custom.projects[0].data.tasks[0].estimateProvenance={custom:'preserve'};validateWorkspace(custom);const cp=plan(custom);assert.ok(cp.skipped.some(s=>/注記/.test(s.reason)));apply(custom,cp);assert.deepEqual(custom.projects[0].data.tasks[0].estimateProvenance,{custom:'preserve'});
 const unknown=copy();const p0=unknown.projects[0];const t=structuredClone(p0.data.tasks[0]);t.id='new-logistics-work';t.issueNumber=null;t.estimatePoints=null;p0.data.tasks.push(t);p0.data.order.push(t.id);const up=plan(unknown);assert.ok(up.skipped.some(s=>s.taskId===t.id&&/原本にない/.test(s.reason)));
});
test('stale preview aborts before changing values; manual changes remove only owned provenance',()=>{
 const w=copy(),p=plan(w);w.projects[0].data.tasks[0].estimatePoints=9;const before=structuredClone(w);assert.throws(()=>apply(w,p),/確認内容が変わり/);assert.deepEqual(w,before);
 const known=copy();apply(known);const task=known.projects[0].data.tasks[0];updateProject(known,known.projects[0].id,data=>setEstimate(data,task.id,4));assert.equal(task.estimateProvenance,undefined);validateWorkspace(known);
});
test('provenance round-trips through existing v1 local storage without schema migration',()=>{
 const w=copy();apply(w);const storage=memoryStorage({[STORAGE_KEY]:JSON.stringify(w)});const store=createWorkspaceStore(storage);assert.deepEqual(store.snapshot(),w);assert.equal(store.status().readOnly,false);
});
test('recognized provenance is validated; malformed ranges, points, dates and rationale are rejected',()=>{
 const w=copy();apply(w);for(const mutate of [p=>p.range=[2,1],p=>p.points=999,p=>p.scopeAt='bad',p=>p.retrospective='yes',p=>p.rationale='']){const bad=structuredClone(w);mutate(bad.projects[0].data.tasks[0].estimateProvenance);assert.throws(()=>validateWorkspace(bad));}
});
test('proposal validation rejects duplicate IDs, missing identity, invalid values and malformed ranges',()=>{
 for(const mutate of [p=>p.entries.push(p.entries[0]),p=>p.entries[0].taskId='unknown',p=>p.entries[0].points=0,p=>p.entries[0].range=[4,1],p=>p.pointsPerWorkday=8]){const p=structuredClone(proposal);mutate(p);assert.throws(()=>planPreparedEstimates(copy(),baseline,p));}
});
test('review stays incomplete and estimates do not alter original snapshot or product criteria',()=>{
 const w=copy();apply(w);const p=w.projects.find(p=>p.id==='progress-board');assert.equal(p.data.tasks.find(t=>t.id==='shared-storage').status,'review');assert.equal(goalProgress(p.data,p.data.goals[0].id).percent,40);assert.equal(baseline.projects.flatMap(p=>p.data.tasks).filter(t=>t.estimatePoints!==null).length,0);
});
function harness(t){const DB=sqliteD1();t.after(()=>DB.close());let fail=false,lost=false,puts=0;const fetcher=async(path,options={})=>{if(options.method==='PUT'){puts++;if(fail)throw new Error('QA offline');}const result=await worker.fetch(new Request('https://progress.test'+path,{...options,headers:{...options.headers,'Origin':'https://progress.test','oai-authenticated-user-id':'qa-estimates'}}),{DB});if(lost&&options.method==='PUT')throw new Error('QA lost response');return result;};return {store:()=>createCloudWorkspaceStore(fetcher),setFail:v=>fail=v,setLost:v=>lost=v,puts:()=>puts};}
async function seed(h){const s=h.store();await s.initialize();await s.transact(d=>Object.assign(d,copy()));return s;}
async function save(s){const p=plan(s.snapshot());if(p.changes.length)await s.transact(d=>apply(d,p));}
test('real SQLite cloud path saves metadata, preserves backup history and becomes idempotent after reload',async t=>{
 const h=harness(t),s=await seed(h);await save(s);const raw=await s.raw();assert.equal(s.status().version,2);assert.ok(raw.serverBackup.versions.some(v=>v.version===1));const reload=h.store();await reload.initialize();await save(reload);assert.equal(h.puts(),2);assert.equal(reload.status().version,2);assert.equal(reload.snapshot().projects.flatMap(p=>p.data.tasks).filter(isProvisionalEstimate).length,18);
});
test('cloud failure and lost acknowledgement keep safe recovery and do not repeat estimates after reload',async t=>{
 const h=harness(t),s=await seed(h);h.setFail(true);await assert.rejects(save(s));assert.equal(s.status().readOnly,true);h.setFail(false);const retry=h.store();await retry.initialize();h.setLost(true);await assert.rejects(save(retry));h.setLost(false);const reload=h.store();await reload.initialize();await save(reload);assert.equal(reload.status().version,2);assert.equal(h.puts(),3);
});
test('another device update makes estimate submission conflict instead of overwriting new user evidence',async t=>{
 const h=harness(t),a=await seed(h),b=h.store();await b.initialize();await a.transact(d=>{d.projects[0].data.tasks[0].evidence+=' newer';});await assert.rejects(save(b));const reload=h.store();await reload.initialize();assert.match(reload.snapshot().projects[0].data.tasks[0].evidence,/newer$/);assert.equal(reload.snapshot().projects[0].data.tasks[0].estimatePoints,null);
});
