import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {BugStore,digest,initialPolicy} from '../server/bug-store.mjs';
import {createProgressServer} from '../server.mjs';
import {recoverIncompleteUploads,acquireDataLock} from '../server/bug-api.mjs';
const cleanup=dir=>{const relative=path.relative(tmpdir(),dir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));rmSync(dir,{recursive:true,force:true});};
function storeFixture(t,policy=initialPolicy) {
  const dir=mkdtempSync(path.join(tmpdir(),'progress-bugs-'));
  const store=new BugStore(dir,{initialize:true,policy});
  for(const [id,role] of [['a','tester'],['b','tester'],['admin','admin']]) store.createUser(id,id,role);
  const keys=Object.fromEntries(['a','b','admin'].map(id=>[id,store.issueKey(id)]));
  const actors=Object.fromEntries(Object.entries(keys).map(([id,key])=>[id,store.actorForKey(key.secret)]));
  t.after(()=>{store.close();cleanup(dir);});return{dir,store,keys,actors};
}
async function httpFixture(t,policy=initialPolicy) {
  const dir=mkdtempSync(path.join(tmpdir(),'progress-bugs-http-'));
  const init=new BugStore(dir,{initialize:true,policy});
  for(const [id,role] of [['a','tester'],['b','tester'],['admin','admin']]) init.createUser(id,id,role);
  const keys=Object.fromEntries(['a','b','admin'].map(id=>[id,init.issueKey(id)]));init.close();
  let server=createProgressServer({dataDir:dir});server.listen(0,'127.0.0.1');await once(server,'listening');
  let base='http://127.0.0.1:'+server.address().port;
  const call=(route,{user=null,headers={},...options}={})=>fetch(base+route,{...options,headers:{...(user?{Authorization:'Bearer '+keys[user].secret}:{}),...headers}});
  const json=(route,body,options={})=>call('/api/bugs/'+route,{...options,method:'POST',headers:{'Content-Type':'application/json',...options.headers},body:JSON.stringify(body)});
  const upload=(data,name='再現&data.bin',route='uploads',options={})=>call('/api/bugs/'+route,{...options,method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(name),'X-File-Type':'',...options.headers},body:data});
  async function restart({keepPort=false}={}) { const port=keepPort?server.address().port:0;await new Promise(resolve=>server.close(resolve));server=createProgressServer({dataDir:dir});server.listen(port,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port; }
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));cleanup(dir);});
  return{dir,keys,call,json,upload,restart,get store(){return server.bugStore;},get base(){return base;}};
}
const reportInput=(overrides={})=>({body:'予約一覧の更新が止まる\n再現手順: ファイルを読み込む。',reportedVersion:'QA-1',requestId:'request-1',uploadIds:[],...overrides});

test('report creation atomically stores the registration queue and rejects forged reporter IDs',t=>{
  const {store,actors}=storeFixture(t);const report=store.createReport(actors.a,reportInput({reporterId:'b'}));
  assert.equal(report.reporterName,'a');assert.equal(store.db.prepare('SELECT count(*) AS n FROM registration_queue').get().n,1);
  assert.equal(store.listReports(actors.b).length,1);assert.equal(store.listReports(actors.admin).length,1);
  assert.equal(report.isOwn,true);assert.equal(store.getReport(actors.b,report.id).isOwn,false);assert.equal(store.listReports(actors.b)[0].reporterName,'a');
  assert.throws(()=>store.createReport(actors.admin,reportInput()),error=>error.status===403);
});
test('the same receipt request retries without creating another report; changes conflict',t=>{
  const {store,actors}=storeFixture(t);const first=store.createReport(actors.a,reportInput());
  assert.equal(store.createReport(actors.a,reportInput()).id,first.id);
  assert.throws(()=>store.createReport(actors.a,reportInput({body:'別の報告'})),error=>error.status===409);
  assert.equal(store.listReports(actors.a).length,1);
});
test('failed report commit retains uploads and leaves no partial report or queue',t=>{
  const {store,actors}=storeFixture(t);const file=store.reserveAttachment(actors.a,null,{name:'save.dat',size:3,type:''});
  writeFileSync(store.filePath(file.id),'abc');store.finishAttachment(file.id,digest('abc'));
  store.db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON registration_queue BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(()=>store.createReport(actors.a,reportInput({uploadIds:[file.id]})));
  assert.equal(store.listReports(actors.a).length,0);assert.equal(store.pendingUploads(actors.a).length,1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM registration_queue').get().n,0);
  store.db.exec('DROP TRIGGER fail_queue');
  assert.equal(store.createReport(actors.a,reportInput({uploadIds:[file.id]})).attachments.length,1);
});
test('key hashes and session hashes are stored; revocation invalidates every session for that key',t=>{
  const {store,keys}=storeFixture(t);const session=store.startSession(keys.a.secret);
  assert.equal(store.actorForSession(session.token).id,'a');
  assert.notEqual(store.db.prepare('SELECT hash FROM api_keys WHERE id=?').get(keys.a.id).hash,keys.a.secret);
  assert.notEqual(store.db.prepare('SELECT hash FROM sessions').get().hash,session.token);
  const replacement=store.issueKey('a');store.revokeKey(keys.a.id);
  assert.equal(store.actorForKey(keys.a.secret),null);assert.equal(store.actorForSession(session.token),null);
  assert.equal(store.actorForKey(replacement.secret).id,'a');
});
test('reservations include concurrent uploads and preserve accepted files above a lowered limit',t=>{
  const {store,actors}=storeFixture(t,{maxBytes:5,maxFiles:2});
  const report=store.createReport(actors.a,reportInput());
  const file=store.reserveAttachment(actors.a,report.id,{name:'a',size:3,type:''});
  assert.throws(()=>store.reserveAttachment(actors.a,report.id,{name:'b',size:3,type:''}),error=>error.status===413);
  writeFileSync(store.filePath(file.id),'abc');store.finishAttachment(file.id,digest('abc'));
  store.db.prepare('UPDATE policy SET max_bytes=1,max_files=1').run();
  assert.equal(store.getReport(actors.a,report.id).attachments.length,1);
  assert.throws(()=>store.reserveAttachment(actors.a,report.id,{name:'b',size:0,type:''}),error=>error.status===413);
  assert.equal(readFileSync(store.filePath(file.id),'utf8'),'abc');
});
test('interrupted uploads recover separately from accepted files; missing files stay visible',t=>{
  const {store,actors}=storeFixture(t);
  const report=store.createReport(actors.a,reportInput());
  const accepted=store.reserveAttachment(actors.a,report.id,{name:'ready',size:3,type:''});writeFileSync(store.filePath(accepted.id),'abc');store.finishAttachment(accepted.id,digest('abc'));
  const broken=store.reserveAttachment(actors.a,report.id,{name:'interrupted',size:4,type:''});writeFileSync(store.filePath(broken.id,true),'a');
  const missing=store.reserveAttachment(actors.a,report.id,{name:'missing',size:2,type:''});store.finishAttachment(missing.id,digest('ab'));
  recoverIncompleteUploads(store);
  assert.ok(existsSync(store.filePath(accepted.id)));assert.equal(existsSync(store.filePath(broken.id,true)),false);
  assert.equal(store.db.prepare('SELECT id FROM attachments WHERE id=?').get(broken.id),undefined);
  assert.equal(store.getReport(actors.a,report.id).attachments.find(file=>file.id===missing.id).state,'missing');
});
test('a live server owns the data-directory lock',t=>{
  const {store}=storeFixture(t);const release=acquireDataLock(store);
  try{assert.throws(()=>acquireDataLock(store),/起動しています/);}finally{release();}
  assert.equal(existsSync(path.join(store.dataDir,'server.lock')),false);
});
test('invalid names, foreign uploads, and missing bytes never become accepted report attachments',t=>{
  const {store,actors}=storeFixture(t);
  for(const name of ['../secret','x/y','x\\y','x\n']) assert.throws(()=>store.reserveAttachment(actors.a,null,{name,size:1,type:''}),error=>error.status===400);
  const file=store.reserveAttachment(actors.a,null,{name:'x',size:1,type:''});store.finishAttachment(file.id,digest('x'));
  assert.throws(()=>store.createReport(actors.b,reportInput({uploadIds:[file.id]})),error=>error.status===409);
  assert.throws(()=>store.createReport(actors.a,reportInput({uploadIds:[file.id]})),error=>error.status===409);
});
test('HTTP initial/later uploads and downloads preserve exact bytes across restart',async t=>{
  const fx=await httpFixture(t);const data=Buffer.from([0,1,255,10,13,0,128]);
  const sent=await fx.upload(data);assert.equal(sent.status,201);const file=(await sent.json()).attachment;assert.equal(file.hash,digest(data));
  const response=await fx.json('reports',reportInput({uploadIds:[file.id]}));assert.equal(response.status,201);const report=(await response.json()).report;
  const later=await fx.upload(Buffer.from('追加データ'),'追加.txt','reports/'+report.id+'/attachments');assert.equal(later.status,201);
  const download=await fx.call('/api/bugs/reports/'+report.id+'/attachments/'+file.id);assert.equal(download.status,200);
  assert.match(download.headers.get('content-disposition'),/filename\*=UTF-8/);assert.deepEqual(Buffer.from(await download.arrayBuffer()),data);
  await fx.restart();const detail=await fx.call('/api/bugs/reports/'+report.id);assert.equal((await detail.json()).report.attachments.length,2);
  const again=await fx.call('/api/bugs/reports/'+report.id+'/attachments/'+file.id);assert.deepEqual(Buffer.from(await again.arrayBuffer()),data);
  assert.equal(fx.store.db.prepare('SELECT count(*) AS n FROM registration_queue').get().n,1);
});
test('HTTP exposes reports, attachments and management through the common local user without credentials',async t=>{
  const fx=await httpFixture(t);const file=(await(await fx.upload(Buffer.from('a'))).json()).attachment;
  const report=(await(await fx.json('reports',reportInput({uploadIds:[file.id]}))).json()).report;
  assert.equal(report.reporterName,'共通の利用者');assert.equal(report.isOwn,true);
  const shared=(await(await fx.call('/api/bugs/reports/'+report.id,{user:'b'})).json()).report;assert.deepEqual(shared,report);
  const download=await fx.call('/api/bugs/reports/'+report.id+'/attachments/'+file.id);assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.from('a'));
  assert.equal((await fx.call('/api/bugs/reports/'+report.id+'/attachments/'+file.id,{method:'HEAD'})).status,200);
  assert.equal((await fx.upload(Buffer.from('b'),'x','reports/'+report.id+'/attachments')).status,201);
  for(const route of ['/','/app.mjs','/bugs/'])assert.equal((await fx.call(route)).status,200);
  assert.equal((await fx.call('/api/bugs/reports')).status,200);
  assert.equal((await fx.call('/api/bugs/reports/00000000-0000-0000-0000-000000000000')).status,404);
});

test('HTTP keeps Host and Origin validation and needs neither API keys nor a session',async t=>{
  const fx=await httpFixture(t);
  assert.equal((await fx.call('/api/bugs/me',{headers:{Origin:'https://other.example'}})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{const request=http.get(fx.base+'/api/bugs/me',{headers:{Host:'other.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});assert.equal(hostStatus,403);
  const response=await fx.call('/api/bugs/me');assert.equal(response.status,200);assert.equal(response.headers.get('set-cookie'),null);
  const actor=await response.json();assert.equal(actor.name,'共通の利用者');assert.equal(actor.shared,true);
  const html=await(await fx.call('/bugs/')).text();assert.doesNotMatch(html,/APIキー|ログイン|type="password"|name="key"/);
  assert.equal((await fx.json('session',{key:fx.keys.a.secret})).status,404);
  assert.equal((await fx.call('/api/bugs/session',{method:'DELETE'})).status,404);
});

test('HTTP quotas reject new files before writing, and unrelated report metadata stays readable',async t=>{
  const fx=await httpFixture(t,{maxBytes:4,maxFiles:1});const sent=await fx.upload(Buffer.from('abcd'));assert.equal(sent.status,201);
  const file=(await sent.json()).attachment;const report=(await (await fx.json('reports',reportInput({uploadIds:[file.id]}))).json()).report;
  assert.equal((await fx.upload(Buffer.from('x'),'x','reports/'+report.id+'/attachments')).status,413);
  assert.equal((await fx.call('/api/bugs/reports')).status,200);assert.equal((await fx.call('/api/bugs/reports/'+report.id)).status,200);
  assert.equal(readFileSync(fx.store.filePath(file.id),'utf8'),'abcd');
});
test('HTTP interrupted stream is removed without damaging an accepted report',async t=>{
  const fx=await httpFixture(t);const report=(await (await fx.json('reports',reportInput())).json()).report;
  await new Promise(resolve=>{
    const req=http.request(fx.base+'/api/bugs/reports/'+report.id+'/attachments',{method:'POST',headers:{Authorization:'Bearer '+fx.keys.a.secret,'Content-Length':'10','X-File-Name':'broken'}});
    req.on('error',()=>resolve());req.write('abc');setTimeout(()=>req.destroy(),30);
  });
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(fx.store.db.prepare("SELECT count(*) AS n FROM attachments WHERE state='uploading'").get().n,0);
  assert.equal((await fx.call('/api/bugs/reports/'+report.id)).status,200);
});
test('HTTP disk-write failure returns no successful attachment and keeps report intact',async t=>{
  const fx=await httpFixture(t);const report=(await (await fx.json('reports',reportInput())).json()).report;
  const actual=fx.store.filesDir;fx.store.filesDir=path.join(fx.dir,'not-created');
  try{await fx.upload(Buffer.from('x'),'x','reports/'+report.id+'/attachments').then(response=>assert.notEqual(response.status,201),()=>{});}
  finally{fx.store.filesDir=actual;}
  assert.equal(fx.store.getReport(fx.store.actorForKey(fx.keys.a.secret),report.id).attachments.length,0);
  assert.equal(fx.store.db.prepare('SELECT count(*) AS n FROM attachments').get().n,0);
});
test('HTTP concurrent late uploads cannot exceed a report budget',async t=>{
  const fx=await httpFixture(t,{maxBytes:6,maxFiles:2});const report=(await (await fx.json('reports',reportInput())).json()).report;
  const results=await Promise.all([fx.upload(Buffer.from('aaaa'),'a','reports/'+report.id+'/attachments'),fx.upload(Buffer.from('bbbb'),'b','reports/'+report.id+'/attachments')]);
  assert.deepEqual(results.map(result=>result.status).sort(),[201,413]);
  const detail=await fx.call('/api/bugs/reports/'+report.id);const value=(await detail.json()).report;assert.equal(value.attachmentCount,1);assert.equal(value.attachmentBytes,4);
});
test('HTTP ready pending uploads are shared and recoverable by the common user',async t=>{
  const fx=await httpFixture(t);const attachment=(await (await fx.upload(Buffer.from('x'))).json()).attachment;
  await fx.restart();
  assert.equal((await (await fx.call('/api/bugs/uploads')).json()).attachments[0].id,attachment.id);
  assert.equal((await (await fx.call('/api/bugs/uploads',{user:'b'})).json()).attachments[0].id,attachment.id);
  const report=(await (await fx.json('reports',reportInput({uploadIds:[attachment.id]}))).json()).report;
  assert.equal(report.attachmentCount,1);assert.equal((await (await fx.call('/api/bugs/uploads')).json()).attachments.length,0);
});
test('list metadata never opens or embeds large attachment bytes',async t=>{
  const fx=await httpFixture(t);const data=Buffer.alloc(8*1024**2,21);const file=(await (await fx.upload(data,'audio.raw')).json()).attachment;
  await fx.json('reports',reportInput({uploadIds:[file.id]}));
  const response=await fx.call('/api/bugs/reports');const text=await response.text();assert.ok(text.length<2000);assert.equal(JSON.parse(text).reports[0].attachmentBytes,data.length);
  assert.deepEqual(readFileSync(fx.store.filePath(file.id)),data);
});
test('uninitialized integration keeps the existing progress page and explains missing setup',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'progress-bugs-off-'));const server=createProgressServer({dataDir:dir});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));cleanup(dir);});
  const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/bugs/')).status,200);assert.equal((await fetch(base+'/api/bugs/me')).status,503);
});
test('data cannot be stored in the public dist directory',()=>{
  for(const directory of ['dist','dist/secret','dist/..secret']) {
    const dataDir=path.resolve(directory);
    assert.throws(()=>createProgressServer({dataDir}),/distの外/);
    const cli=spawnSync(process.execPath,['scripts/bug-users.mjs','init','--data-dir',dataDir],{encoding:'utf8',windowsHide:true});
    assert.equal(cli.status,1);assert.match(cli.stderr,/distの外/);
  }
});

test('revocation is checked inside every creation and upload commit transaction',t=>{
  const {store,keys,actors}=storeFixture(t);
  const file=store.reserveAttachment(actors.a,null,{name:'pending',size:1,type:''});
  store.revokeKey(keys.a.id);
  assert.throws(()=>store.createReport(actors.a,reportInput()),error=>error.status===401);
  assert.throws(()=>store.reserveAttachment(actors.a,null,{name:'another',size:1,type:''}),error=>error.status===401);
  assert.throws(()=>store.finishAttachment(file.id,digest('x'),actors.a),error=>error.status===401);
  assert.equal(store.db.prepare("SELECT state FROM attachments WHERE id=?").get(file.id).state,'uploading');
  assert.equal(store.listReports(actors.admin).length,0);
});


test('別ポートではログインせず、保存した報告をポートごとに分離する',async t=>{
  const first=await httpFixture(t),second=await httpFixture(t);
  const report=(await(await first.json('reports',reportInput())).json()).report;
  assert.equal((await(await second.call('/api/bugs/reports')).json()).reports.length,0);
  const actor=(await(await second.call('/api/bugs/me',{headers:{Cookie:'bug_session=old; bug_session_4322=old'}})).json());assert.equal(actor.shared,true);
  await first.restart({keepPort:true});
  const afterRestart=await new Promise((resolve,reject)=>{const request=http.get(first.base+'/api/bugs/reports/'+report.id,response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});assert.equal(afterRestart,200);
});

test('旧CookieやBearerの内容で共通の利用者が変わらない',async t=>{
  const fx=await httpFixture(t);
  for(const headers of [{Cookie:'bug_session=old; bug_session_4322=old'},{Authorization:'Bearer invalid'},{Authorization:'Bearer '+fx.keys.a.secret}]){
    const response=await fx.call('/api/bugs/me',{headers});assert.equal(response.status,200);assert.equal((await response.json()).id,'local-shared');assert.equal(response.headers.get('set-cookie'),null);
  }
  fx.store.revokeKey(fx.keys.a.id);assert.equal((await fx.call('/api/bugs/me')).status,200);
});


test('共通の利用者は以前の報告と未登録添付を、報告者名とファイル本体を保って扱える',async t=>{
  const fx=await httpFixture(t),legacy=fx.store.actorForKey(fx.keys.a.secret);
  const before=fx.store.createReport(legacy,reportInput({requestId:'old-report'}));
  const file=fx.store.reserveAttachment(legacy,null,{name:'old.dat',size:3,type:''});writeFileSync(fx.store.filePath(file.id),'abc');fx.store.finishAttachment(file.id,digest('abc'),legacy);
  const detail=(await(await fx.call('/api/bugs/reports/'+before.id)).json()).report;assert.equal(detail.reporterName,'a');assert.equal(detail.body,before.body);
  assert.equal((await fx.upload(Buffer.from('x'),'later.dat','reports/'+before.id+'/attachments')).status,201);
  assert.equal((await(await fx.call('/api/bugs/uploads')).json()).attachments[0].id,file.id);
  const saved=(await(await fx.json('reports',reportInput({requestId:'common-report',uploadIds:[file.id],reporterId:'a'}))).json()).report;
  assert.equal(saved.reporterName,'共通の利用者');assert.equal(saved.attachments[0].id,file.id);
  assert.equal(fx.store.db.prepare('SELECT owner_id FROM attachments WHERE id=?').get(file.id).owner_id,'a');
  assert.deepEqual(Buffer.from(await(await fx.call('/api/bugs/reports/'+saved.id+'/attachments/'+file.id)).arrayBuffer()),Buffer.from('abc'));
});

test('以前の未登録添付も、共通の利用者の保存容量に含める',async t=>{
  const fx=await httpFixture(t,{maxBytes:4,maxFiles:2}),legacy=fx.store.actorForKey(fx.keys.a.secret);
  const file=fx.store.reserveAttachment(legacy,null,{name:'old.dat',size:3,type:''});writeFileSync(fx.store.filePath(file.id),'abc');fx.store.finishAttachment(file.id,digest('abc'),legacy);
  assert.equal((await fx.upload(Buffer.from('xx'),'new.dat')).status,413);
  assert.equal(readFileSync(fx.store.filePath(file.id),'utf8'),'abc');
});
