import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProgressServer } from '../server.mjs';
import { createCaseRepository } from '../dist/testing/repository.mjs';
import { createCaseEditor } from '../dist/testing/case-editor.mjs';
import { TestStore } from '../server/test-store.mjs';

async function fixture(t) {
  const dir=mkdtempSync(path.join(tmpdir(),'test-api-')), servers=[];
  const start=async()=>{const server=createProgressServer({repositories:[],dataDir:path.join(dir,'bugs'),testDataDir:path.join(dir,'testing')});servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
    const request=(url,options={})=>fetch(origin+url,{...options,headers:{origin,'x-test-client':'1',...options.headers}});
    return {server,origin,request,repository:createCaseRepository({fetchImpl:request})};};
  t.after(async()=>{for(const server of servers){await new Promise(r=>server.close(r));await server.bugClosed;}rmSync(dir,{recursive:true,force:true});});
  return {dir,start,...await start()};
}
async function newEditor(repository) { const editor=createCaseEditor(repository);await editor.load();await editor.create();editor.edit('title','APIから登録');editor.edit('steps','画面を開く');editor.edit('expected','一覧が見える');return editor; }

test('real HTTP repository and editor save, reload and survive server restart', async t=>{
  const f=await fixture(t), editor=await newEditor(f.repository);editor.edit('category','画面');assert.equal(await editor.save(),true);
  const saved=editor.snapshot().draft;await new Promise(r=>f.server.close(r));await f.server.bugClosed;
  const restarted=await f.start();assert.deepEqual((await restarted.repository.load()).cases[0],{...saved,revision:1});
  assert.equal((await restarted.request('/testing/')).status,200);
  assert.match(await (await restarted.request('/')).text(),/test-management-link/);
});
test('conflicting real API writes preserve unsaved input and show latest content',async t=>{
  const f=await fixture(t), a=await newEditor(f.repository);await a.save();
  const b=createCaseEditor(f.repository);await b.load();b.select(a.snapshot().selected);
  a.edit('expected','先に保存');await a.save();b.edit('expected','未保存の入力');assert.equal(await b.save(),false);
  assert.equal(b.snapshot().draft.expected,'未保存の入力');assert.equal(b.snapshot().conflict.expected,'先に保存');
});
test('lost response retries the persisted receipt and does not increment revision twice',async t=>{
  const f=await fixture(t);let lost=true;
  const repository=createCaseRepository({fetchImpl:async(url,options)=>{const response=await f.request(url,options);if(options.method==='PUT'&&lost){lost=false;await response.text();throw new Error('disconnect');}return response;}});
  const editor=await newEditor(repository);assert.equal(await editor.save(),false);assert.equal(editor.snapshot().dirty,true);assert.equal(await editor.save(),true);
  assert.equal((await f.repository.load()).cases[0].revision,1);
});
test('real SQLite failure preserves UI input and retry succeeds after repair',async t=>{
  const f=await fixture(t), editor=await newEditor(f.repository);const external=new TestStore(path.join(f.dir,'testing'));t.after(()=>{try{external.close();}catch{}});
  external.db.exec("CREATE TRIGGER fail_case BEFORE INSERT ON cases BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.equal(await editor.save(),false);assert.equal(editor.snapshot().draft.title,'APIから登録');assert.equal(editor.snapshot().dirty,true);
  external.db.exec('DROP TRIGGER fail_case');assert.equal(await editor.save(),true);external.close();
});
test('API rejects cross-origin writes, missing client header and invalid payload',async t=>{
  const f=await fixture(t), headers={'Content-Type':'application/json'}, url='/api/testing/case-ids';
  for(const [options,status] of [[{method:'POST',headers:{...headers,origin:'https://other.example'},body:'{}'},403],[{headers:{'x-test-client':''}},403],[{method:'POST',headers,body:'[]'},400],[{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'},415],[{method:'POST',headers,body:'x'.repeat(262145)},413],[{method:'DELETE'},405]]) assert.equal((await f.request(url,options)).status,status);
  assert.equal((await f.request('/api/testing/cases?all=1')).status,403);
  assert.equal((await f.request('/api/testing/cases',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.deepEqual(await f.repository.load(),{cases:[],categories:[]});
});
test('initialization failure is reported safely and can recover without stopping progress routes',async t=>{
  const f=await fixture(t);writeFileSync(path.join(f.dir,'testing'),'not a directory');
  const response=await f.request('/api/testing/cases');assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'store_unavailable'});
  assert.equal((await f.request('/')).status,200);rmSync(path.join(f.dir,'testing'));assert.deepEqual(await f.repository.load(),{cases:[],categories:[]});
});
test('test DB cannot be created inside the public assets directory',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'test-public-'));mkdirSync(path.join(dir,'dist'));const server=createProgressServer({repositories:[],root:path.join(dir,'dist'),dataDir:path.join(dir,'bugs'),testDataDir:path.join(dir,'dist','data')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await server.bugClosed;rmSync(dir,{recursive:true,force:true});});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/testing/cases`,{headers:{'x-test-client':'1'}});assert.equal(response.status,503);
});
