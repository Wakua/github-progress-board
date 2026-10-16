import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {BugStore,BugError,requestDecisions,maxDecisionNote} from '../server/bug-store.mjs';
import {createProgressServer} from '../server.mjs';

// 要望の判定（#82）：対応する・保留と、理由、日付。ツールの中だけで持つ。架空の予約管理の報告を使う。
const cleanup=dir=>{const relative=path.relative(tmpdir(),dir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));rmSync(dir,{recursive:true,force:true});};
function fixture(t) {
  const dir=mkdtempSync(path.join(tmpdir(),'progress-bug-decision-'));
  let store=new BugStore(dir,{initialize:true});const actor=store.sharedActor();
  let count=0;
  t.after(()=>{store?.close();cleanup(dir);});
  return{dir,actor,get store(){return store;},release(){store.close();store=null;},
    create:(extra={})=>store.createReport(actor,{body:'架空の要望 '+(++count),reportedVersion:'',requestId:'request-'+count,uploadIds:[],kind:'request',...extra})};
}
const rejects=(action,status,message)=>assert.throws(action,error=>error instanceof BugError&&error.status===status,message);

test('判定の値は、未判定・対応する・保留で、要望は未判定から始まる。理由と日付は空',t=>{
  const fx=fixture(t);const report=fx.create();
  assert.deepEqual(requestDecisions,['undecided','accept','defer']);
  assert.deepEqual(report.decision,{value:'undecided',note:'',at:null});
  assert.deepEqual(fx.store.listReports(fx.actor)[0].decision,{value:'undecided',note:'',at:null});
});
test('判定を残すと、判定と理由と日付が付き、更新番号が進む。理由は前後の空白を除く',t=>{
  const fx=fixture(t);const report=fx.create();
  const accepted=fx.store.setDecision(fx.actor,report.id,{decision:'accept',note:'  今回の版で入れる。  ',revision:report.revision});
  assert.equal(accepted.decision.value,'accept');assert.equal(accepted.decision.note,'今回の版で入れる。');
  assert.match(accepted.decision.at,/^\d{4}-\d\d-\d\dT/);assert.equal(accepted.revision,report.revision+1);
  const deferred=fx.store.setDecision(fx.actor,report.id,{decision:'defer',revision:accepted.revision});
  assert.equal(deferred.decision.value,'defer');assert.equal(deferred.decision.note,'','理由は省ける');assert.equal(deferred.revision,accepted.revision+1);
  assert.equal(fx.store.listReports(fx.actor)[0].decision.value,'defer');
});
test('未判定へ戻すと、理由と日付を消す',t=>{
  const fx=fixture(t);const report=fx.create();
  const deferred=fx.store.setDecision(fx.actor,report.id,{decision:'defer',note:'次の版で見直す。',revision:report.revision});
  const back=fx.store.setDecision(fx.actor,report.id,{decision:'undecided',note:'残らない理由',revision:deferred.revision});
  assert.deepEqual(back.decision,{value:'undecided',note:'',at:null});
});
test('同じ判定と理由を保存し直しても、日付も更新番号も変えない。古い画面からでも、変えない',t=>{
  const fx=fixture(t);const report=fx.create();
  const saved=fx.store.setDecision(fx.actor,report.id,{decision:'accept',note:'入れる',revision:report.revision});
  const again=fx.store.setDecision(fx.actor,report.id,{decision:'accept',note:'入れる',revision:report.revision});
  assert.deepEqual(again.decision,saved.decision);assert.equal(again.revision,saved.revision);
  assert.equal(fx.store.setDecision(fx.actor,report.id,{decision:'accept',note:'入れる',revision:saved.revision+9}).revision,saved.revision);
});
test('古い更新番号、不正な入力、要望でない報告、存在しない報告は、何も変えずに断る',t=>{
  const fx=fixture(t);const report=fx.create();
  rejects(()=>fx.store.setDecision(fx.actor,report.id,{decision:'accept',revision:report.revision+1}),409);
  for(const input of [undefined,null,{},{decision:'accept'},{revision:1},{decision:'later',revision:1},{decision:null,revision:1},{decision:'accept',revision:0},{decision:'accept',revision:'1'},{decision:'accept',revision:1.5},{decision:'accept',note:5,revision:1},{decision:'accept',note:'あ'.repeat(maxDecisionNote+1),revision:1}])
    rejects(()=>fx.store.setDecision(fx.actor,report.id,input),400,JSON.stringify(input)?.slice(0,60));
  fx.store.setDecision(fx.actor,report.id,{decision:'accept',note:'あ'.repeat(maxDecisionNote),revision:report.revision});
  for(const kind of ['bug','question']) {
    const other=fx.create({kind});
    rejects(()=>fx.store.setDecision(fx.actor,other.id,{decision:'accept',revision:other.revision}),400,kind);
    assert.equal(fx.store.getReport(fx.actor,other.id).decision.value,'undecided');
  }
  rejects(()=>fx.store.setDecision(fx.actor,'00000000-0000-0000-0000-000000000000',{decision:'accept',revision:1}),404);
});
test('判定は、本文・対応状況・履歴・種別・登録を変えない。種別を要望から変えても、判定は残る',t=>{
  const fx=fixture(t);const report=fx.create();
  const working=fx.store.updateStatus(fx.actor,report.id,{revision:report.revision,requestId:'s-1',targetVersion:'',developerNote:'着手'});
  const decided=fx.store.setDecision(fx.actor,report.id,{decision:'accept',note:'入れる',revision:working.revision});
  for(const key of ['body','status','history','categories','github','attachments','targetVersion','developerNote','kind','reportedVersion','createdAt'])assert.deepEqual(decided[key],working[key],key);
  const asked=fx.store.setKind(fx.actor,report.id,{kind:'question',revision:decided.revision});
  assert.equal(asked.decision.value,'accept','種別を戻したときのために、判定を残す');
  assert.equal(fx.store.db.prepare('SELECT count(*) AS n FROM report_events').get().n,1,'判定は、履歴の出来事にしない');
});
test('保存し直しても、判定が残る。更新前の保存先は、すべて未判定になる',t=>{
  const fx=fixture(t);const report=fx.create();
  fx.store.setDecision(fx.actor,report.id,{decision:'defer',note:'あとで見る',revision:report.revision});
  fx.store.db.exec('ALTER TABLE reports DROP COLUMN decision_note; ALTER TABLE reports DROP COLUMN decided_at; ALTER TABLE reports DROP COLUMN decision; PRAGMA user_version=7;');
  fx.release();
  const reopened=new BugStore(fx.dir);
  try {
    assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,8);
    assert.deepEqual(reopened.getReport(reopened.sharedActor(),report.id).decision,{value:'undecided',note:'',at:null});
  } finally {reopened.close();}
});
test('APIは、判定を残し、一覧と詳細に返す。不正な要求と、古い更新番号は、断る',async t=>{
  const fx=fixture(t);const report=fx.create();fx.release();
  const server=createProgressServer({dataDir:fx.dir});server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const base='http://127.0.0.1:'+server.address().port+'/api/bugs/';
    const post=(route,body,headers={'Content-Type':'application/json'})=>fetch(base+route,{method:'POST',headers,body:typeof body==='string'?body:JSON.stringify(body)});
    const saved=await post('reports/'+report.id+'/decision',{decision:'defer',note:'次の版で見直す。',revision:report.revision});
    assert.equal(saved.status,200);const updated=(await saved.json()).report;
    assert.equal(updated.decision.value,'defer');assert.equal(updated.decision.note,'次の版で見直す。');
    assert.equal((await (await fetch(base+'reports')).json()).reports[0].decision.value,'defer');
    assert.equal((await (await fetch(base+'reports/'+report.id)).json()).report.decision.note,'次の版で見直す。');
    assert.equal((await post('reports/'+report.id+'/decision',{decision:'accept',revision:report.revision})).status,409);
    assert.equal((await post('reports/'+report.id+'/decision',{decision:'later',revision:updated.revision})).status,400);
    assert.equal((await post('reports/'+report.id+'/decision','x',{'Content-Type':'text/plain'})).status,415);
    assert.equal((await post('reports/'+report.id+'/decision','{',{'Content-Type':'application/json'})).status,400);
    assert.equal((await fetch(base+'reports/'+report.id+'/decision')).status,404);
    assert.equal((await post('reports/00000000-0000-0000-0000-000000000000/decision',{decision:'accept',revision:1})).status,404);
    assert.equal((await fetch(base+'reports/'+report.id+'/decision',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://evil.example'},body:'{}'})).status,403);
  } finally {await server.bugWorker?.stop();await new Promise(resolve=>server.close(resolve));await server.bugClosed;}
});
