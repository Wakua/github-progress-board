import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {BugStore,BugError,digest,reportKinds} from '../server/bug-store.mjs';
import {GitHubWorker} from '../server/bug-github-worker.mjs';
import {createProgressServer} from '../server.mjs';

// 報告の種別（#73）：不具合・要望・確認。ツールの中だけで持ち、GitHubには書かない。架空の予約管理の報告を使う。
const repository='qa-fixture/booking-reports';
const url=number=>'https://github.com/'+repository+'/issues/'+number;
const cleanup=dir=>{const relative=path.relative(tmpdir(),dir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));rmSync(dir,{recursive:true,force:true});};
function fixture(t) {
  const dir=mkdtempSync(path.join(tmpdir(),'progress-bug-kind-'));
  let store=new BugStore(dir,{initialize:true});const actor=store.sharedActor();
  let count=0;
  t.after(()=>{store?.close();cleanup(dir);});
  return{dir,actor,get store(){return store;},release(){store.close();store=null;},
    create:(extra={})=>store.createReport(actor,{body:'架空の報告 '+(++count),reportedVersion:'',requestId:'request-'+count,uploadIds:[],...extra}),
    setState:(id,state)=>store.db.prepare('UPDATE registration_queue SET state=? WHERE report_id=?').run(state,id)};
}
const rejects400=(action,message)=>assert.throws(action,error=>error instanceof BugError&&error.status===400,message);

test('schema v6 data migrates to the current version; every existing report stays a bug',t=>{
  const fx=fixture(t);const first=fx.create(),second=fx.create();
  fx.store.db.exec('ALTER TABLE reports DROP COLUMN decision; ALTER TABLE reports DROP COLUMN decision_note; ALTER TABLE reports DROP COLUMN decided_at; ALTER TABLE reports DROP COLUMN kind; PRAGMA user_version=6;');
  fx.release();
  const reopened=new BugStore(fx.dir);
  try {
    assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,8);
    const actor=reopened.sharedActor();
    assert.deepEqual(reopened.listReports(actor).map(item=>item.kind),['bug','bug']);
    const migrated=reopened.getReport(actor,first.id);
    assert.equal(migrated.kind,'bug');assert.equal(migrated.body,first.body);assert.equal(migrated.status,'received');assert.equal(migrated.revision,first.revision);
    assert.equal(reopened.getReport(actor,second.id).kind,'bug');
  } finally {reopened.close();}
});

test('the kind defaults to a bug, and each kind is stored and returned in the list and the detail',t=>{
  const fx=fixture(t);
  assert.deepEqual(reportKinds,['bug','request','question']);
  assert.equal(fx.create().kind,'bug');
  assert.equal(fx.create({kind:'bug'}).kind,'bug');
  const request=fx.create({kind:'request'}),question=fx.create({kind:'question'});
  assert.equal(request.kind,'request');assert.equal(fx.store.getReport(fx.actor,question.id).kind,'question');
  const listed=fx.store.listReports(fx.actor);
  assert.equal(listed.find(item=>item.id===request.id).kind,'request');assert.equal(listed.find(item=>item.id===question.id).kind,'question');
  assert.equal(listed.filter(item=>item.kind==='bug').length,2);
});
test('an unknown kind is rejected and nothing is saved',t=>{
  const fx=fixture(t);
  for(const kind of ['issue','','BUG',' bug',null,1,true,['bug'],{}])rejects400(()=>fx.create({kind}),JSON.stringify(kind));
  assert.equal(fx.store.listReports(fx.actor).length,0);
  assert.equal(fx.store.db.prepare('SELECT count(*) AS n FROM registration_queue').get().n,0);
});
test('a bug keeps the request fingerprint of earlier versions; a retry returns the same report and a changed kind conflicts',t=>{
  const fx=fixture(t);
  const plain=fx.store.createReport(fx.actor,{body:'種別なし',reportedVersion:'v1',requestId:'plain',uploadIds:[]});
  assert.equal(fx.store.db.prepare('SELECT request_hash FROM reports WHERE id=?').get(plain.id).request_hash,digest(JSON.stringify(['種別なし','v1',[]])));
  assert.equal(fx.store.createReport(fx.actor,{body:'種別なし',reportedVersion:'v1',requestId:'plain',uploadIds:[],kind:'bug'}).id,plain.id);
  for(const kind of ['request','question'])assert.throws(()=>fx.store.createReport(fx.actor,{body:'種別なし',reportedVersion:'v1',requestId:'plain',uploadIds:[],kind}),error=>error.status===409,kind);
  const asked=fx.store.createReport(fx.actor,{body:'要望',reportedVersion:'',requestId:'asked',uploadIds:[],kind:'request'});
  assert.equal(fx.store.createReport(fx.actor,{body:'要望',reportedVersion:'',requestId:'asked',uploadIds:[],kind:'request'}).id,asked.id);
  for(const kind of [undefined,'bug','question'])assert.throws(()=>fx.store.createReport(fx.actor,{body:'要望',reportedVersion:'',requestId:'asked',uploadIds:[],kind}),error=>error.status===409,String(kind));
  assert.equal(fx.store.listReports(fx.actor).length,2);
});

test('the kind can be changed in every registration state, and the report revision moves',t=>{
  const fx=fixture(t);
  let report=fx.create();
  for(const [state,kind] of [['pending','request'],['creating','question'],['unknown','request'],['failed','bug'],['registered','question']]) {
    fx.setState(report.id,state);
    const changed=fx.store.setKind(fx.actor,report.id,{kind,revision:report.revision});
    assert.equal(changed.kind,kind,state);assert.equal(changed.revision,report.revision+1,state);assert.ok(changed.updatedAt>=report.updatedAt);
    assert.equal(fx.store.listReports(fx.actor)[0].kind,kind);
    report=changed;
  }
});
test('saving the same kind changes nothing, even from a stale view',t=>{
  const fx=fixture(t);const report=fx.create({kind:'request'});
  assert.equal(fx.store.setKind(fx.actor,report.id,{kind:'request',revision:report.revision}).revision,report.revision);
  assert.equal(fx.store.setKind(fx.actor,report.id,{kind:'request',revision:report.revision+9}).revision,report.revision);
});
test('a stale revision, an invalid body and an unknown report are rejected without changes',t=>{
  const fx=fixture(t);const report=fx.create();
  assert.throws(()=>fx.store.setKind(fx.actor,report.id,{kind:'request',revision:report.revision+1}),error=>error.status===409);
  for(const input of [undefined,null,{},{kind:'request'},{revision:1},{kind:'issue',revision:1},{kind:null,revision:1},{kind:'request',revision:0},{kind:'request',revision:'1'},{kind:'request',revision:1.5}])
    rejects400(()=>fx.store.setKind(fx.actor,report.id,input),JSON.stringify(input));
  assert.throws(()=>fx.store.setKind(fx.actor,'00000000-0000-0000-0000-000000000000',{kind:'request',revision:1}),error=>error.status===404);
  assert.equal(fx.store.getReport(fx.actor,report.id).kind,'bug');assert.equal(fx.store.getReport(fx.actor,report.id).revision,report.revision);
});
test('changing the kind leaves the body, status, history, categories and registration as they were',t=>{
  const fx=fixture(t);const report=fx.create();
  const working=fx.store.updateStatus(fx.actor,report.id,{revision:report.revision,requestId:'s-1',targetVersion:'',developerNote:'着手'});
  const changed=fx.store.setKind(fx.actor,report.id,{kind:'question',revision:working.revision});
  for(const key of ['body','status','history','categories','github','attachments','targetVersion','developerNote','reportedVersion','createdAt','reporterName'])assert.deepEqual(changed[key],working[key],key);
  assert.equal(fx.store.db.prepare('SELECT count(*) AS n FROM report_events').get().n,1);
});
test('the kind is never written to GitHub: not in the creation request, not by the change, and the registration is untouched',async t=>{
  const fx=fixture(t);
  const calls=[],issues=[];
  const client={repository,
    async createIssue(title,body,labels=[]){calls.push(['create',title,body,labels]);const issue={number:101+issues.length,html_url:url(101+issues.length),title,body,labels:[]};issues.push(issue);return issue;},
    async getIssue(number){calls.push(['get',number]);return issues.find(item=>item.number===number);},
    async findIssues(marker){calls.push(['find']);return issues.filter(item=>item.body.startsWith(marker+'\n'));},
    async getLabel(name){calls.push(['label',name]);throw new Error('タグを読んではいけません。');}};
  const worker=new GitHubWorker(fx.store,client,{clock:()=>100000});
  t.after(()=>worker.stop());
  const request=fx.create({kind:'request',body:'予約一覧に、日付の並び替えがほしい'}),question=fx.create({kind:'question',body:'満席の日に、予約ボタンが押せないのは仕様ですか'});
  await worker.processOne();await worker.processOne();
  const created=calls.filter(call=>call[0]==='create');
  assert.equal(created.length,2);
  for(const [,title,body,labels] of created) {
    assert.deepEqual(labels,[]);
    assert.doesNotMatch(title+body,/要望|確認（|質問|request|question|種別/);
  }
  const before=calls.length,registered=fx.store.registration(request.id);
  const changed=fx.store.setKind(fx.actor,request.id,{kind:'bug',revision:request.revision});
  fx.store.setKind(fx.actor,question.id,{kind:'bug',revision:question.revision});
  assert.equal(calls.length,before,'種別を変えても、GitHubへ要求を送らない');
  assert.deepEqual(fx.store.registration(request.id),registered);assert.equal(changed.github.state,'registered');
});
test('the text search covers every kind',t=>{
  const fx=fixture(t);
  const ids=[['bug','予約の確認メールが届かない'],['request','予約の確認メールに、変更前の日時もほしい'],['question','予約の確認メールの送信時刻は仕様ですか']].map(([kind,body])=>fx.create({kind,body}).id);
  assert.deepEqual(fx.store.searchReports('確認メール').sort(),[...ids].sort());
  assert.deepEqual(fx.store.searchReports('仕様ですか'),[ids[2]]);
});

test('the API accepts the kind when a report is created and when it is changed, and returns it in the list and the detail',async t=>{
  const fx=fixture(t);fx.release();
  const server=createProgressServer({dataDir:fx.dir});server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const base='http://127.0.0.1:'+server.address().port+'/api/bugs/';
    const post=(route,body,headers={'Content-Type':'application/json'})=>fetch(base+route,{method:'POST',headers,body:typeof body==='string'?body:JSON.stringify(body)});
    const created=await post('reports',{body:'予約一覧に、日付の並び替えがほしい',reportedVersion:'',requestId:'kind-1',uploadIds:[],kind:'request'});
    assert.equal(created.status,201);const report=(await created.json()).report;assert.equal(report.kind,'request');
    const plain=await post('reports',{body:'種別を指定しない報告',reportedVersion:'',requestId:'kind-2',uploadIds:[]});
    assert.equal((await plain.json()).report.kind,'bug');
    const bad=await post('reports',{body:'別の報告',reportedVersion:'',requestId:'kind-3',uploadIds:[],kind:'issue'});
    assert.equal(bad.status,400);assert.match((await bad.json()).error,/種別/);
    assert.deepEqual((await (await fetch(base+'reports')).json()).reports.map(item=>item.kind).sort(),['bug','request']);
    const changed=await post('reports/'+report.id+'/kind',{kind:'question',revision:report.revision});
    assert.equal(changed.status,200);const updated=(await changed.json()).report;assert.equal(updated.kind,'question');
    assert.equal((await (await fetch(base+'reports/'+report.id)).json()).report.kind,'question');
    assert.equal((await post('reports/'+report.id+'/kind',{kind:'bug',revision:report.revision})).status,409);
    assert.equal((await post('reports/'+report.id+'/kind',{kind:'issue',revision:updated.revision})).status,400);
    assert.equal((await post('reports/'+report.id+'/kind','x',{'Content-Type':'text/plain'})).status,415);
    assert.equal((await post('reports/'+report.id+'/kind','{',{'Content-Type':'application/json'})).status,400);
    assert.equal((await fetch(base+'reports/'+report.id+'/kind')).status,404);
    assert.equal((await post('reports/00000000-0000-0000-0000-000000000000/kind',{kind:'bug',revision:1})).status,404);
    assert.equal((await fetch(base+'reports/'+report.id+'/kind',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://evil.example'},body:'{}'})).status,403);
  } finally {await server.bugWorker?.stop();await new Promise(resolve=>server.close(resolve));await server.bugClosed;}
});
