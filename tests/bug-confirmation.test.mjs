import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {BugStore,digest} from '../server/bug-store.mjs';
import {createProgressServer} from '../server.mjs';
const approvedRepository='qa-fixture/booking-reports';

import {GitHubFailure} from '../server/bug-github-client.mjs';
function cleanup(dir){const relative=path.relative(tmpdir(),dir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));rmSync(dir,{recursive:true,force:true});}
async function fixture(t,{githubClient}={}) {
  const dir=mkdtempSync(path.join(tmpdir(),'progress-bug-confirmation-'));
  const init=new BugStore(dir,{initialize:true});
  for(const [id,role]of [['a','tester'],['b','tester'],['admin','admin']])init.createUser(id,id,role);
  const keys=Object.fromEntries(['a','b','admin'].map(id=>[id,init.issueKey(id)]));init.close();
  let server;
  async function start(){server=createProgressServer({dataDir:dir,githubClient});server.listen(0,'127.0.0.1');await once(server,'listening');}
  await start();
  const call=(route,body,user='admin')=>fetch('http://127.0.0.1:'+server.address().port+'/api/bugs/'+route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
  const create=async()=>{const response=await call('reports',{body:'確認用の架空報告\n再現手順',reportedVersion:'v1',requestId:crypto.randomUUID(),uploadIds:[]},'a');assert.equal(response.status,201);return(await response.json()).report;};
  const input=(report,extra={})=>({revision:report.revision,requestId:crypto.randomUUID(),targetVersion:report.targetVersion,developerNote:'再確認をお願いします。',...extra});
  const advance=async(report,extra={})=>{const response=await call('reports/'+report.id+'/status',input(report,extra));assert.equal(response.status,200,await response.clone().text());return(await response.json()).report;};
  const checking=async()=>{let report=await create();report=await advance(report);report=await advance(report);return advance(report,{targetVersion:'v2'});};
  async function stop(){await new Promise(resolve=>server.close(resolve));await server.bugClosed;}
  async function restart(){await stop();await start();}
  t.after(async()=>{await stop();cleanup(dir);});
  return{dir,keys,call,create,input,advance,checking,restart,get store(){return server.bugStore;},get worker(){return server.bugWorker;}};
}
const confirmation=(report,extra={})=>({revision:report.revision,requestId:crypto.randomUUID(),version:report.targetVersion,result:'resolved',note:'操作を再確認した。',...extra});

test('共通の利用者がキーなしで対応と確認を進め、確認待ち以外の結果を拒否する',async t=>{
  const fx=await fixture(t);let report=await fx.create();
  assert.equal((await fx.call('reports/'+report.id+'/confirmations',confirmation(report,{version:'v2'}))).status,409);
  report=await fx.advance(report);report=await fx.advance(report);report=await fx.advance(report,{targetVersion:'v2'});
  const answer=await fx.call('reports/'+report.id+'/confirmations',confirmation(report));assert.equal(answer.status,200);
  const saved=(await answer.json()).report;assert.equal(saved.status,'complete');assert.equal(saved.history.at(-1).actorName,'共通の利用者');
});

test('older-version evidence stays waiting; unresolved returns to work and a new release can complete',async t=>{
  const fx=await fixture(t);let report=await fx.checking();assert.equal(report.status,'checking');
  const older=await fx.call('reports/'+report.id+'/confirmations',confirmation(report,{version:'v1'}),'a');assert.equal(older.status,200);
  let result=await older.json();report=result.report;assert.equal(result.matchesTarget,false);assert.equal(report.status,'checking');
  const shared=(await(await fx.call('reports/'+report.id,undefined,'b')).json()).report;assert.equal(shared.isOwn,true);assert.deepEqual(shared.history,report.history);
  assert.equal(report.confirmations[0].targetVersion,'v2');assert.equal(report.confirmations[0].version,'v1');
  result=await(await fx.call('reports/'+report.id+'/confirmations',confirmation(report,{result:'unresolved'}),'a')).json();report=result.report;
  assert.equal(report.status,'working');assert.equal(report.confirmations[1].matchesTarget,true);
  report=await fx.advance(report,{targetVersion:'v3'});assert.equal(report.status,'fixed');
  report=await fx.advance(report,{targetVersion:'v3'});assert.equal(report.status,'checking');
  result=await(await fx.call('reports/'+report.id+'/confirmations',confirmation(report),'a')).json();report=result.report;
  assert.equal(report.status,'complete');assert.equal(report.history.length,8);assert.equal(report.confirmations.length,3);
  assert.equal(report.confirmations[1].targetVersion,'v2');assert.equal(report.confirmations[2].targetVersion,'v3');
  assert.equal((await fx.call('reports/'+report.id+'/status',fx.input(report))).status,409);
});
test('status and confirmation retries remain idempotent after success and restart',async t=>{
  const fx=await fixture(t);let report=await fx.create();const input=fx.input(report);
  const first=await fx.call('reports/'+report.id+'/status',input);report=(await first.json()).report;
  const replay=await fx.call('reports/'+report.id+'/status',input);assert.equal(replay.status,200);assert.equal((await replay.json()).report.history.length,1);
  assert.equal((await fx.call('reports/'+report.id+'/status',{...input,developerNote:'違う連絡'})).status,409);
  report=await fx.advance(report);report=await fx.advance(report,{targetVersion:'v2'});
  const answer=confirmation(report),saved=await(await fx.call('reports/'+report.id+'/confirmations',answer,'a')).json();
  await fx.restart();
  const repeated=await fx.call('reports/'+report.id+'/confirmations',answer,'a');assert.equal(repeated.status,200);
  const value=await repeated.json();assert.equal(value.confirmationId,saved.confirmationId);assert.equal(value.matchesTarget,true);assert.equal(value.report.confirmations.length,1);
  assert.equal((await fx.call('reports/'+report.id+'/confirmations',{...answer,result:'unresolved'},'a')).status,409);
});
test('simultaneous distinct actions cannot skip a stage or store conflicting confirmation results',async t=>{
  const fx=await fixture(t);let report=await fx.create();
  const actions=await Promise.all([fx.call('reports/'+report.id+'/status',fx.input(report)),fx.call('reports/'+report.id+'/status',fx.input(report))]);
  assert.deepEqual(actions.map(response=>response.status).sort(),[200,409]);
  report=(await(await fx.call('reports/'+report.id)).json()).report;assert.equal(report.status,'working');assert.equal(report.history.length,1);
  report=await fx.advance(report);report=await fx.advance(report,{targetVersion:'v2'});
  const answers=await Promise.all([fx.call('reports/'+report.id+'/confirmations',confirmation(report),'a'),fx.call('reports/'+report.id+'/confirmations',confirmation(report,{result:'unresolved'}),'a')]);
  assert.deepEqual(answers.map(response=>response.status).sort(),[200,409]);
  report=(await(await fx.call('reports/'+report.id)).json()).report;assert.equal(report.confirmations.length,1);
});
test('stale requests are rejected after a different confirmation and renewed target version',async t=>{
  const fx=await fixture(t);let report=await fx.checking();const stale=confirmation(report);
  report=(await(await fx.call('reports/'+report.id+'/confirmations',confirmation(report,{result:'unresolved'}),'a')).json()).report;
  report=await fx.advance(report);report=await fx.advance(report,{targetVersion:'v3'});
  assert.equal((await fx.call('reports/'+report.id+'/confirmations',stale,'a')).status,409);
  const current=(await(await fx.call('reports/'+report.id)).json()).report;assert.equal(current.status,'checking');assert.equal(current.targetVersion,'v3');assert.equal(current.confirmations.length,1);
});
test('a published confirmation request requires a target and rejects malformed result inputs',async t=>{
  const fx=await fixture(t);let report=await fx.create();report=await fx.advance(report);report=await fx.advance(report);
  assert.equal((await fx.call('reports/'+report.id+'/status',fx.input(report,{targetVersion:' '}))).status,400);
  assert.equal((await fx.call('reports/'+report.id+'/status',fx.input(report,{revision:'3'}))).status,400);
  report=await fx.advance(report,{targetVersion:' v2 '});assert.equal(report.targetVersion,'v2');
  for(const extra of [{version:' '},{result:'maybe'},{note:'x'.repeat(4001)},{requestId:'bad key'},{revision:0}])assert.equal((await fx.call('reports/'+report.id+'/confirmations',confirmation(report,extra),'a')).status,400);
  assert.equal((await(await fx.call('reports/'+report.id)).json()).report.confirmations.length,0);
});
test('history write failures roll back state and revision together',async t=>{
  const fx=await fixture(t);let report=await fx.create();report=(await(await fx.call('reports/'+report.id)).json()).report;
  fx.store.db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON report_events BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.equal((await fx.call('reports/'+report.id+'/status',fx.input(report))).status,503);
  assert.deepEqual((await(await fx.call('reports/'+report.id)).json()).report,report);
  fx.store.db.exec('DROP TRIGGER fail_history');report=await fx.advance(report);report=await fx.advance(report);report=await fx.advance(report,{targetVersion:'v2'});
  fx.store.db.exec("CREATE TRIGGER fail_confirmation BEFORE INSERT ON report_events WHEN NEW.kind='confirmation' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.equal((await fx.call('reports/'+report.id+'/confirmations',confirmation(report),'a')).status,503);
  assert.deepEqual((await(await fx.call('reports/'+report.id)).json()).report,report);
});
test('revoked actors cannot commit either workflow action',async t=>{
  const fx=await fixture(t);const report=await fx.checking();const admin=fx.store.actorForKey(fx.keys.admin.secret),tester=fx.store.actorForKey(fx.keys.a.secret);
  fx.store.revokeKey(fx.keys.admin.id);fx.store.revokeKey(fx.keys.a.id);
  assert.throws(()=>fx.store.updateStatus(admin,report.id,fx.input(report)),error=>error.status===401);
  assert.throws(()=>fx.store.recordConfirmation(tester,report.id,confirmation(report)),error=>error.status===401);
  assert.equal(fx.store.db.prepare("SELECT count(*) AS n FROM report_events WHERE kind='confirmation'").get().n,0);
});
test('GitHub Closed and tag failures do not complete a tester confirmation or change its history',async t=>{
  const client={repository:approvedRepository,issue:null,fail:false,
    async createIssue(title,body){return this.issue={number:101,html_url:'https://github.com/'+approvedRepository+'/issues/101',body,title,state:'closed',labels:[]};},
    async getIssue(){if(this.fail)throw new GitHubFailure('模擬取得失敗');return this.issue;}};
  const fx=await fixture(t,{githubClient:client});const report=await fx.checking();
  await fx.worker.serialize(()=>fx.worker.processOne());
  const actor=fx.store.actorForKey(fx.keys.admin.secret),before=fx.store.getReport(actor,report.id);assert.equal(before.status,'checking');
  client.fail=true;await fx.worker.refreshLabels(actor,report.id);
  const after=fx.store.getReport(actor,report.id);assert.equal(after.github.tags.state,'error');
  for(const key of ['status','targetVersion','developerNote','revision','history','confirmations'])assert.deepEqual(after[key],before[key]);
});
test('schema v2 migration and subsequent restart preserve report, attachment and registration data',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'progress-bug-workflow-migration-'));t.after(()=>cleanup(dir));
  let store=new BugStore(dir,{initialize:true});store.createUser('a','a','tester');const key=store.issueKey('a'),actor=store.actorForKey(key.secret);
  const file=store.reserveAttachment(actor,null,{name:'sound.raw',size:3,type:''});writeFileSync(store.filePath(file.id),'abc');store.finishAttachment(file.id,digest('abc'),actor);
  const report=store.createReport(actor,{body:'既存報告',reportedVersion:'v1',requestId:'initial',uploadIds:[file.id]});store.close();
  const db=new DatabaseSync(path.join(dir,'reports.sqlite'));
  db.exec("DROP TABLE report_events; ALTER TABLE reports DROP COLUMN status; ALTER TABLE reports DROP COLUMN target_version; ALTER TABLE reports DROP COLUMN developer_note; PRAGMA user_version=2;");db.close();
  store=new BugStore(dir);try{const migrated=store.getReport(store.actorForKey(key.secret),report.id);assert.equal(migrated.status,'received');assert.equal(migrated.targetVersion,'');assert.equal(migrated.body,report.body);assert.deepEqual(migrated.attachments,report.attachments);assert.deepEqual(migrated.github,report.github);assert.deepEqual(readFileSync(store.filePath(file.id)),Buffer.from('abc'));assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,3);}finally{store.close();}
  store=new BugStore(dir);try{assert.equal(store.getReport(store.actorForKey(key.secret),report.id).status,'received');}finally{store.close();}
});