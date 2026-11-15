import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProgressServer} from '../server.mjs';
import {TestStore} from '../server/test-store.mjs';
import {createPlanRepository} from '../dist/testing/plan-repository.mjs';
import {createPlanSession} from '../dist/testing/plan-session.mjs';
import {seedCase,proposal} from './support/test-plan-fixture.mjs';
async function fixture(t){
 const dir=mkdtempSync(path.join(tmpdir(),'plan-api-')),store=new TestStore(path.join(dir,'testing')),p=proposal(store,[seedCase(store)]),servers=[];
 const start=async()=>{const server=createProgressServer({repositories:[],testDataDir:path.join(dir,'testing'),dataDir:path.join(dir,'bugs')});servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;const request=(url,options={})=>fetch(origin+url,{...options,headers:{origin,'x-test-client':'1',...options.headers}});return {server,request,repository:createPlanRepository({fetchImpl:request})};};
 t.after(async()=>{store.close();for(const server of servers){await new Promise(r=>server.close(r));await server.bugClosed;}rmSync(dir,{recursive:true,force:true});});return {dir,store,p,start,...await start()};
}
test('real plan API and session retain data across server restart and expose the plan page',async t=>{
 const f=await fixture(t),session=createPlanSession(f.repository),saved=await session.save(f.p);assert.equal(saved.results[0].status,'Not Run');await new Promise(r=>f.server.close(r));await f.server.bugClosed;const next=await f.start();assert.deepEqual((await next.repository.load()).plans,[saved]);assert.equal((await next.request('/testing/plans.html')).status,200);assert.match(await(await next.request('/testing/')).text(),/plans.html/);
});
test('HTTP response lost after commit retries same receipt and retains proposal until success',async t=>{
 const f=await fixture(t);let lost=true;const keys=[];
 const repo=createPlanRepository({fetchImpl:async(url,options)=>{if(options.method==='PUT')keys.push(JSON.parse(options.body).requestId);const response=await f.request(url,options);if(options.method==='PUT'&&lost){lost=false;await response.text();throw new Error('disconnect');}return response;}}),session=createPlanSession(repo),original=structuredClone(f.p);
 await assert.rejects(session.save(f.p));assert.deepEqual(f.p,original);const saved=await session.save(f.p);assert.equal(keys[0],keys[1]);assert.equal(saved.revision,1);assert.equal((await f.repository.load()).plans.length,1);
});
test('SQLite API failure and stale concurrent save preserve pending values and expose latest data',async t=>{
 const f=await fixture(t),session=createPlanSession(f.repository);f.store.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON plan_receipts BEGIN SELECT RAISE(ABORT,'fail'); END;");await assert.rejects(session.save(f.p),e=>e.code==='store_unavailable');assert.equal(f.p.name,'予約アプリの確認');f.store.db.exec('DROP TRIGGER fail_receipt');const saved=await session.save(f.p);const other=createPlanSession(f.repository);await other.save({...saved,name:'先の保存'});const pending={...saved,name:'後の入力'};await assert.rejects(session.save(pending),e=>e.code==='plan_conflict'&&e.current.name==='先の保存');assert.equal(pending.name,'後の入力');
});
test('plan API rejects origin violations, wrong methods, unexpected fields and result writes',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/testing/plan-ids',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403);assert.equal((await f.request('/api/testing/plans',{headers:{'x-test-client':''}})).status,403);assert.equal((await f.request('/api/testing/plans',{method:'DELETE'})).status,405);assert.equal((await f.request('/api/testing/plan-ids',{method:'POST',headers:{'content-type':'application/json'},body:'{"extra":1}'})).status,400);assert.equal((await f.request('/api/testing/results',{method:'PUT',headers:{'content-type':'application/json'},body:'{}'})).status,404);assert.deepEqual((await f.repository.load()).plans,[]);
});
test('session ignores duplicate action while a write is pending and reuses request only for identical input',async()=>{
 let release,calls=[];const repository={save:packet=>{calls.push(packet);return new Promise((resolve,reject)=>{release={resolve,reject};});}},session=createPlanSession(repository);const p={id:'TP-1',name:'A',version:'1',build:'',owner:'',purpose:'',start:'',end:'',issue:'',state:'Draft',conditions:[],caseIds:[],assignees:{}};
 const first=session.save(p);await assert.rejects(session.save(p),/保存中/);release.reject(new Error('failed'));await assert.rejects(first);const retry=session.save(p);assert.equal(calls[0].requestId,calls[1].requestId);release.reject(new Error('failed'));await assert.rejects(retry);const changed=session.save({...p,name:'B'});assert.notEqual(calls[1].requestId,calls[2].requestId);release.resolve({id:p.id});await changed;
});
