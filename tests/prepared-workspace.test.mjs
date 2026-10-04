import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCloudWorkspaceStore,planWorkspaceMigration} from '../dist/cloud-workspace.mjs';
import {emptyWorkspace} from '../dist/workspace.mjs';
import {sqliteD1,fixtureWorkspace} from './cloud-fixtures.mjs';
import worker from '../server/worker.mjs';
const raw=readFileSync(new URL('../samples/prepared-workspace.json',import.meta.url));
const snapshot=JSON.parse(raw);
function harness(t) {
 const DB=sqliteD1();t.after(()=>DB.close());let fail=false,lost=false,writes=0;
 const fetcher=async(url,options={})=>{
  if(options.method==='PUT'){writes++;if(fail)throw new Error('isolated offline');}
  const r=await worker.fetch(new Request('https://progress.test'+url,{...options,headers:{...options.headers,'oai-authenticated-user-id':'qa-prepared','Origin':'https://progress.test'}}),{DB});
  if(lost&&options.method==='PUT')throw new Error('isolated lost acknowledgement');return r;
 };
 const store=()=>createCloudWorkspaceStore(fetcher);const add=async s=>{const plan=s.migrationPlan(snapshot);if(plan.added.length)await s.transact(draft=>Object.assign(draft,s.migrationPlan(snapshot).workspace));return plan;};
 return {store,add,DB,setFail:v=>fail=v,setLost:v=>lost=v,writes:()=>writes};
}
test('prepared sample contains the fictional 3-project / 18-task record',()=>{
 assert.deepEqual(snapshot.projects.map(p=>p.name),['レシピアプリ','予約管理アプリ','github-progress-board']);assert.equal(snapshot.projects.reduce((n,p)=>n+p.data.tasks.length,0),18);
 const plan=planWorkspaceMigration(emptyWorkspace(),snapshot);assert.deepEqual(plan.workspace.projects,snapshot.projects);assert.equal(plan.added.length,3);
});
test('prepared initial import persists once; reload and repeated attempt do not add a version',async t=>{
 const h=harness(t),s=h.store();await s.initialize();await h.add(s);assert.equal(s.status().version,1);assert.deepEqual(s.snapshot().projects,snapshot.projects);
 const reloaded=h.store();await reloaded.initialize();assert.equal((await h.add(reloaded)).added.length,0);assert.equal(h.writes(),1);assert.equal(reloaded.status().version,1);
});
test('prepared partial import preserves existing unrelated and identical projects and prior server version',async t=>{
 const h=harness(t),s=h.store();await s.initialize();const existing=fixtureWorkspace('unrelated');existing.projects.push(structuredClone(snapshot.projects[0]));
 await s.transact(d=>Object.assign(d,existing));const previous=await s.raw();await h.add(s);
 assert.equal(s.snapshot().projects.length,4);assert.deepEqual(s.snapshot().projects[0],existing.projects[0]);assert.deepEqual(s.snapshot().projects.slice(1),snapshot.projects);
 const after=await s.raw();assert.ok(after.serverBackup.versions.some(v=>v.version===1));assert.ok(after.serverBackup.chunks.some(c=>c.version===1));assert.equal(previous.confirmed.version,1);
});
test('prepared conflicting ID refuses all additions and leaves source and existing records unchanged',async t=>{
 const h=harness(t),s=h.store();await s.initialize();const existing=structuredClone(snapshot);existing.projects=[existing.projects[0]];existing.selectedProjectId=null;existing.projects[0].name='Updated by owner';existing.projects[0].data.project='Updated by owner';await s.transact(d=>Object.assign(d,existing));
 const before=s.snapshot();await assert.rejects(h.add(s),/同じプロジェクトID/);assert.deepEqual(s.snapshot(),before);assert.equal(s.status().version,1);assert.equal(h.writes(),1);assert.equal(raw.toString(),readFileSync(new URL('../samples/prepared-workspace.json',import.meta.url),'utf8'));
});
test('prepared failure permits explicit reload/retry; lost acknowledgement does not duplicate committed data',async t=>{
 const h=harness(t),s=h.store();await s.initialize();h.setFail(true);await assert.rejects(h.add(s));assert.equal(s.status().readOnly,true);assert.equal(s.status().version,0);
 h.setFail(false);const retry=h.store();await retry.initialize();h.setLost(true);await assert.rejects(h.add(retry));assert.equal(retry.status().readOnly,true);
 h.setLost(false);const reload=h.store();await reload.initialize();assert.equal(reload.status().version,1);assert.equal((await h.add(reload)).added.length,0);assert.equal(h.writes(),2);
});
test('prepared stale-client import fails CAS without changing other saved records',async t=>{
 const h=harness(t),a=h.store(),b=h.store();await a.initialize();await b.initialize();await h.add(a);await assert.rejects(h.add(b));assert.equal(b.status().readOnly,true);const reload=h.store();await reload.initialize();assert.deepEqual(reload.snapshot().projects,snapshot.projects);assert.equal(reload.status().version,1);
});
test('prepared asset requires authentication before the asset binding is called',async()=>{
 let calls=0;const env={ASSETS:{fetch:()=>{calls++;return new Response(raw,{headers:{'Content-Type':'application/json'}});}}};
 assert.equal((await worker.fetch(new Request('https://progress.test/prepared-workspace.json'),env)).status,401);assert.equal(calls,0);
 const r=await worker.fetch(new Request('https://progress.test/prepared-workspace.json',{headers:{'oai-authenticated-user-id':'qa-prepared'}}),env);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),raw);assert.equal(r.headers.get('cache-control'),'no-store');
});
