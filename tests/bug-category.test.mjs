import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {BugStore,BugError,digest,maxCategories} from '../server/bug-store.mjs';
import {GitHubClient,GitHubFailure} from '../server/bug-github-client.mjs';
import {GitHubWorker} from '../server/bug-github-worker.mjs';
import {createProgressServer} from '../server.mjs';

// 登録前の報告のカテゴリ（#68）。架空の予約管理アプリのタグを使う。idはGitHubのタグのid。
const repository='qa-fixture/booking-reports';
const booking={id:11,name:'予約',color:'336699'},list={id:12,name:'一覧',color:'993366'},notice={id:13,name:'通知',color:'339966'},bug={id:14,name:'bug',color:'cc0000'},fresh={id:15,name:'新しいタグ',color:'888888'};
const url=number=>'https://github.com/'+repository+'/issues/'+number;
const cleanup=dir=>{const relative=path.relative(tmpdir(),dir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));rmSync(dir,{recursive:true,force:true});};

// 模擬のGitHub。存在しない名前のタグを指定されたときは、新しいタグを作る（作られた名前はautoCreatedに残す）。
function fakeClient() {
  return {repository,issues:[],posts:[],labelReads:[],autoCreated:[],
    repo:new Map([booking,list,notice,bug].map(tag=>[tag.id,{...tag}])),
    failLabelRead:null,failFirstGet:false,
    async createIssue(title,body,labels=[]) {
      const attached=labels.map(name=>{
        let found=[...this.repo.values()].find(tag=>tag.name===name);
        if(!found){found={id:900+this.repo.size,name,color:'ededed'};this.repo.set(found.id,found);this.autoCreated.push(name);}
        return found;
      });
      const number=101+this.issues.length,issue={number,html_url:url(number),title,body,labels:attached};
      this.posts.push({title,body,labels});this.issues.push(issue);return issue;
    },
    async getIssue(number) {
      if(this.failFirstGet){this.failFirstGet=false;throw new GitHubFailure('取得失敗',{status:403});}
      const issue=this.issues.find(item=>item.number===number);if(!issue)throw new GitHubFailure('見つかりません。',{status:404});return issue;
    },
    async findIssues(marker) {return this.issues.filter(issue=>issue.body.startsWith(marker+'\n'));},
    async getLabel(name) {
      this.labelReads.push(name);
      if(this.failLabelRead)throw this.failLabelRead;
      const found=[...this.repo.values()].find(tag=>tag.name===name);
      if(!found)throw new GitHubFailure('GitHubにそのタグはありません。',{status:404});
      return found;
    }
  };
}
function fixture(t,{github=false}={}) {
  const dir=mkdtempSync(path.join(tmpdir(),'progress-bug-category-'));
  let store=new BugStore(dir,{initialize:true});const actor=store.sharedActor();
  let clock=100000;const client=fakeClient();
  const worker=github?new GitHubWorker(store,client,{clock:()=>clock}):null;
  t.after(async()=>{await (store?.githubWorker||worker)?.stop();store?.close();cleanup(dir);});
  let count=0;
  const create=(extra={})=>store.createReport(actor,{body:'架空の報告 '+(++count),reportedVersion:'',requestId:'request-'+count,uploadIds:[],...extra});
  // 取得済みのタグを知らせるため、登録済みで、タグを取得した報告を1件置く。
  const know=labels=>{
    const seed=create();
    store.db.prepare("UPDATE registration_queue SET state='registered',issue_number=?,issue_url=?,labels=?,label_state='ok',labels_at=? WHERE report_id=?").run(900+count,url(900+count),JSON.stringify(labels),'2026-10-01T00:00:00.000Z',seed.id);
    return seed;
  };
  const roles=(entries)=>store.setTagRoles(actor,{roles:entries.map(([tag,role])=>({id:tag.id,role}))});
  const setState=(id,state)=>store.db.prepare('UPDATE registration_queue SET state=? WHERE report_id=?').run(state,id);
  return{dir,actor,client,worker,create,know,roles,setState,setClock:value=>{clock=value;},get store(){return store;},release(){store.close();store=null;}};
}
// 予約・通知がメイン、一覧がサブ、bugは使わない、新しいタグは未設定。
function withRoles(t,options) {
  const fx=fixture(t,options);
  fx.know([booking,list,notice,bug,fresh]);
  fx.roles([[booking,'main'],[notice,'main'],[list,'sub'],[bug,'none']]);
  return fx;
}
const rejects400=(action,message)=>assert.throws(action,error=>error instanceof BugError&&error.status===400,message);

test('schema v5 data migrates to the current version; existing reports have no categories',t=>{
  const fx=fixture(t);const report=fx.create();
  fx.store.db.exec('ALTER TABLE reports DROP COLUMN kind; DROP TABLE report_categories; ALTER TABLE registration_queue DROP COLUMN category_miss; PRAGMA user_version=5;');
  fx.release();
  const reopened=new BugStore(fx.dir);
  try {
    assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,7);
    const actor=reopened.sharedActor(),migrated=reopened.getReport(actor,report.id);
    assert.equal(migrated.body,report.body);assert.deepEqual(migrated.categories,[]);assert.deepEqual(migrated.github.tags.missing,[]);
    assert.deepEqual(reopened.listReports(actor).map(item=>item.categories),[[]]);
  } finally {reopened.close();}
});

test('categories are stored with the report, returned in the list and the detail, and sorted by tag id',t=>{
  const fx=withRoles(t);
  const report=fx.create({categories:[12,11]});
  assert.deepEqual(report.categories,[11,12]);
  assert.deepEqual(fx.store.getReport(fx.actor,report.id).categories,[11,12]);
  const listed=fx.store.listReports(fx.actor);
  assert.deepEqual(listed.find(item=>item.id===report.id).categories,[11,12]);
  assert.deepEqual(listed.filter(item=>item.id!==report.id).map(item=>item.categories),[[]]);
  assert.deepEqual(fx.create().categories,[]);
  assert.deepEqual(fx.create({categories:[]}).categories,[]);
});
test('only tags assigned as main or sub can be chosen; the report is not saved otherwise',t=>{
  const fx=withRoles(t);const before=fx.store.listReports(fx.actor).length;
  for(const categories of [[14],[15],[99],[0],[-1],[1.5],['11'],[null],[11,11],'11',{},null,Array.from({length:maxCategories+1},(_,index)=>index+1)])
    rejects400(()=>fx.create({categories}),JSON.stringify(categories)?.slice(0,60));
  assert.equal(fx.store.listReports(fx.actor).length,before);
  assert.equal(fx.store.db.prepare('SELECT count(*) AS n FROM report_categories').get().n,0);
  assert.equal(fx.create({categories:[11,12,13]}).categories.length,3);
});
test('a report with no categories keeps the request fingerprint of earlier versions; a retry returns the same report',t=>{
  const fx=withRoles(t);
  const plain=fx.store.createReport(fx.actor,{body:'分類なし',reportedVersion:'v1',requestId:'plain',uploadIds:[]});
  assert.equal(fx.store.db.prepare('SELECT request_hash FROM reports WHERE id=?').get(plain.id).request_hash,digest(JSON.stringify(['分類なし','v1',[]])));
  assert.equal(fx.store.createReport(fx.actor,{body:'分類なし',reportedVersion:'v1',requestId:'plain',uploadIds:[],categories:[]}).id,plain.id);
  assert.throws(()=>fx.store.createReport(fx.actor,{body:'分類なし',reportedVersion:'v1',requestId:'plain',uploadIds:[],categories:[11]}),error=>error.status===409);
  const chosen=fx.store.createReport(fx.actor,{body:'分類あり',reportedVersion:'',requestId:'chosen',uploadIds:[],categories:[11]});
  assert.equal(fx.store.createReport(fx.actor,{body:'分類あり',reportedVersion:'',requestId:'chosen',uploadIds:[],categories:[11]}).id,chosen.id);
  for(const other of [[12],[]])assert.throws(()=>fx.store.createReport(fx.actor,{body:'分類あり',reportedVersion:'',requestId:'chosen',uploadIds:[],categories:other}),error=>error.status===409);
  fx.roles([[booking,'none']]);
  assert.equal(fx.store.createReport(fx.actor,{body:'分類あり',reportedVersion:'',requestId:'chosen',uploadIds:[],categories:[11]}).id,chosen.id,'役割を変えたあとの再送は、前の報告を返す');
});

test('categories can be replaced while the Issue is not yet requested, and the report revision moves',t=>{
  const fx=withRoles(t);const report=fx.create({categories:[11]});
  const changed=fx.store.setCategories(fx.actor,report.id,{categories:[13,12],revision:report.revision});
  assert.deepEqual(changed.categories,[12,13]);assert.equal(changed.revision,report.revision+1);
  assert.deepEqual(fx.store.listReports(fx.actor).find(item=>item.id===report.id).categories,[12,13]);
  const cleared=fx.store.setCategories(fx.actor,report.id,{categories:[],revision:changed.revision});
  assert.deepEqual(cleared.categories,[]);
  fx.setState(report.id,'failed');
  assert.deepEqual(fx.store.setCategories(fx.actor,report.id,{categories:[11],revision:cleared.revision}).categories,[11]);
});
test('saving the same categories again changes nothing, even from a stale view',t=>{
  const fx=withRoles(t);const report=fx.create({categories:[11,12]});
  const again=fx.store.setCategories(fx.actor,report.id,{categories:[12,11],revision:report.revision});
  assert.equal(again.revision,report.revision);
  const stale=fx.store.setCategories(fx.actor,report.id,{categories:[11,12],revision:report.revision+7});
  assert.equal(stale.revision,report.revision);
});
test('a stale revision, an invalid body, and a tag that cannot be chosen are rejected without changes',t=>{
  const fx=withRoles(t);const report=fx.create({categories:[11]});
  assert.throws(()=>fx.store.setCategories(fx.actor,report.id,{categories:[12],revision:report.revision+1}),error=>error.status===409);
  for(const input of [undefined,null,{},{categories:[12]},{categories:'12',revision:1},{categories:[12],revision:0},{categories:[12],revision:'1'},{categories:[12,12],revision:1}])
    rejects400(()=>fx.store.setCategories(fx.actor,report.id,input),JSON.stringify(input));
  for(const bad of [[14],[15],[99]])rejects400(()=>fx.store.setCategories(fx.actor,report.id,{categories:bad,revision:report.revision}),JSON.stringify(bad));
  assert.deepEqual(fx.store.getReport(fx.actor,report.id).categories,[11]);
  assert.equal(fx.store.getReport(fx.actor,report.id).revision,report.revision);
  assert.throws(()=>fx.store.setCategories(fx.actor,'00000000-0000-0000-0000-000000000000',{categories:[],revision:1}),error=>error.status===404);
});
test('categories cannot be changed once the Issue is being created, may exist, or exists',t=>{
  const fx=withRoles(t);const report=fx.create({categories:[11]});
  for(const [state,pattern] of [['creating',/最中/],['unknown',/最中/],['registered',/GitHubのタグ/]]) {
    fx.setState(report.id,state);
    assert.throws(()=>fx.store.setCategories(fx.actor,report.id,{categories:[12],revision:report.revision}),error=>error.status===409&&pattern.test(error.message),state);
    assert.deepEqual(fx.store.getReport(fx.actor,report.id).categories,[11]);
  }
});

test('the creation request carries the names of the chosen tags, and the first fetch finds them on the Issue',async t=>{
  const fx=withRoles(t,{github:true});
  const report=fx.create({categories:[12,11]});
  await fx.worker.processOne();
  assert.deepEqual(fx.client.posts.map(post=>post.labels),[['予約','一覧']]);
  assert.deepEqual(fx.client.labelReads,['予約','一覧']);
  assert.deepEqual(fx.client.autoCreated,[]);
  const done=fx.store.getReport(fx.actor,report.id);
  assert.equal(done.github.state,'registered');assert.deepEqual(done.github.tags.labels.map(label=>label.id),[11,12]);
  assert.deepEqual(done.github.tags.missing,[]);assert.deepEqual(done.categories,[11,12]);
});
test('a report with no categories reads no tags and sends no tags',async t=>{
  const fx=withRoles(t,{github:true});
  const report=fx.create();await fx.worker.processOne();
  assert.deepEqual(fx.client.posts.map(post=>post.labels),[[]]);assert.deepEqual(fx.client.labelReads,[]);
  assert.deepEqual(fx.store.getReport(fx.actor,report.id).github.tags.missing,[]);
});
test('a tag renamed or recreated on GitHub is not sent, so GitHub creates no tag; the first fetch shows it as missing',async t=>{
  const fx=withRoles(t,{github:true});
  fx.client.repo.set(11,{...booking,name:'予約画面'});            // 名前の変更：ツールが知る名前「予約」は、もうない
  fx.client.repo.set(21,{id:21,name:'通知',color:'339966'});     // 削除して同じ名前で作り直し：idが違う
  fx.client.repo.delete(13);
  const report=fx.create({categories:[11,12,13]});
  await fx.worker.processOne();
  assert.deepEqual(fx.client.posts.map(post=>post.labels),[['一覧']]);
  assert.deepEqual(fx.client.autoCreated,[]);
  const done=fx.store.getReport(fx.actor,report.id);
  assert.deepEqual(done.github.tags.labels.map(label=>label.name),['一覧']);
  assert.deepEqual(done.github.tags.missing,[{id:11,name:'予約'},{id:13,name:'通知'}]);
});
test('a tag the tool no longer knows by name is not sent and is shown as missing without a name',async t=>{
  const fx=withRoles(t,{github:true});
  const report=fx.create({categories:[11,13]});
  // 通知のタグが付いた報告がなくなると、ツールはそのタグの名前を知らない。
  fx.store.db.prepare("UPDATE registration_queue SET labels=? WHERE labels IS NOT NULL").run(JSON.stringify([booking,list]));
  await fx.worker.processOne();
  assert.deepEqual(fx.client.posts.map(post=>post.labels),[['予約']]);assert.deepEqual(fx.client.labelReads,['予約']);
  assert.deepEqual(fx.store.getReport(fx.actor,report.id).github.tags.missing,[{id:13,name:null}]);
});
test('a tag the repository did not attach is shown as missing until the next fetch',async t=>{
  const fx=withRoles(t,{github:true});
  const original=fx.client.createIssue.bind(fx.client);
  // 作成者にpush権限がないと、タグは黙って落ちる。
  fx.client.createIssue=async(title,body)=>original(title,body,[]);
  const report=fx.create({categories:[11,12]});
  await fx.worker.processOne();
  const first=fx.store.getReport(fx.actor,report.id);
  assert.equal(first.github.state,'registered');assert.deepEqual(first.github.tags.labels,[]);
  assert.deepEqual(first.github.tags.missing,[{id:11,name:'予約'},{id:12,name:'一覧'}]);
  await fx.worker.refreshLabels(fx.actor,report.id);
  assert.deepEqual(fx.store.getReport(fx.actor,report.id).github.tags.missing,[]);
  assert.equal(fx.client.posts.length,1);
});
test('a developer who retags the Issue later raises no warning',async t=>{
  const fx=withRoles(t,{github:true});
  const report=fx.create({categories:[11]});await fx.worker.processOne();
  assert.deepEqual(fx.store.getReport(fx.actor,report.id).github.tags.missing,[]);
  fx.client.issues[0].labels=[{...notice}];
  await fx.worker.refreshLabels(fx.actor,report.id);
  const later=fx.store.getReport(fx.actor,report.id);
  assert.deepEqual(later.github.tags.labels.map(label=>label.id),[13]);assert.deepEqual(later.github.tags.missing,[]);
});
test('the check runs at the first successful fetch even when the fetch right after creation fails',async t=>{
  const fx=withRoles(t,{github:true});
  const original=fx.client.createIssue.bind(fx.client);
  fx.client.createIssue=async(title,body)=>original(title,body,[]);
  fx.client.failFirstGet=true;
  const report=fx.create({categories:[11]});await fx.worker.processOne();
  const failed=fx.store.getReport(fx.actor,report.id);
  assert.equal(failed.github.state,'registered');assert.equal(failed.github.tags.state,'error');assert.deepEqual(failed.github.tags.missing,[]);
  await fx.worker.refreshLabels(fx.actor,report.id);
  assert.deepEqual(fx.store.getReport(fx.actor,report.id).github.tags.missing,[{id:11,name:'予約'}]);
});
test('a failed tag check never reaches the creation request',async t=>{
  const fx=withRoles(t,{github:true});
  fx.client.failLabelRead=new GitHubFailure('GitHubの処理を完了できませんでした。',{status:503});
  const report=fx.create({categories:[11]});
  await fx.worker.processOne();
  assert.equal(fx.client.posts.length,0);
  assert.equal(fx.store.registration(report.id).state,'failed');
  fx.client.failLabelRead=new GitHubFailure('利用制限',{status:429,headers:{'retry-after':'120'}});
  await fx.worker.register(fx.actor,report.id);await fx.worker.serialize(()=>fx.worker.processOne());
  assert.equal(fx.client.posts.length,0);
  const limited=fx.store.registration(report.id);
  assert.equal(limited.state,'pending');assert.equal(limited.retryAt,220000);
  fx.client.failLabelRead=null;fx.setClock(220001);
  await fx.worker.serialize(()=>fx.worker.processOne());
  assert.deepEqual(fx.client.posts.map(post=>post.labels),[['予約']]);
});
test('an Issue found before creation is linked without reading tags or creating another',async t=>{
  const fx=withRoles(t,{github:true});
  const report=fx.create({categories:[11]});
  fx.client.issues=[{number:201,html_url:url(201),body:fx.worker.marker(report.id)+'\n',labels:[{...booking}]}];
  await fx.worker.processOne();
  assert.equal(fx.client.posts.length,0);assert.deepEqual(fx.client.labelReads,[]);
  const done=fx.store.getReport(fx.actor,report.id);
  assert.equal(done.github.number,201);assert.deepEqual(done.github.tags.missing,[]);
});
test('categories changed while pending are the ones sent',async t=>{
  const fx=withRoles(t,{github:true});
  const report=fx.create({categories:[11]});
  fx.store.setCategories(fx.actor,report.id,{categories:[13],revision:report.revision});
  await fx.worker.processOne();
  assert.deepEqual(fx.client.posts.map(post=>post.labels),[['通知']]);
});

test('the GitHub client sends tags only in the creation request, and reads one tag by name',async()=>{
  const calls=[];
  const client=new GitHubClient(repository,{run:async(args,input)=>{
    calls.push({args,input});
    if(args.includes('POST'))return{status:201,headers:{},data:{number:42,html_url:url(42),body:'body',labels:[]}};
    return{status:200,headers:{},data:{id:11,name:'予約',color:'336699'}};
  }});
  await client.createIssue('title','body');
  await client.createIssue('title','body',[]);
  await client.createIssue('title','body',['予約','一覧']);
  assert.deepEqual(calls.map(call=>JSON.parse(call.input)),[{title:'title',body:'body'},{title:'title',body:'body'},{title:'title',body:'body',labels:['予約','一覧']}]);
  calls.length=0;
  assert.deepEqual(await client.getLabel('予約'),{id:11,name:'予約',color:'336699'});
  assert.ok(calls[0].args.includes('GET'));assert.equal(calls[0].args.at(-1),'repos/'+repository+'/labels/'+encodeURIComponent('予約'));
  await client.getLabel('area:booking/list #1');
  assert.equal(calls[1].args.at(-1),'repos/'+repository+'/labels/area%3Abooking%2Flist%20%231');
  calls.length=0;
  for(const name of ['','.','..','x'.repeat(101),null,undefined,7])await assert.rejects(client.getLabel(name),error=>error instanceof GitHubFailure&&error.status===404,String(name));
  assert.equal(calls.length,0);
  for(const [method,route] of [['POST','labels'],['PUT','labels/x'],['PATCH','labels/x'],['DELETE','labels/x'],['POST','issues/1/labels'],['GET','labels'],['GET','labels/'],['GET','labels/a/b'],['GET','labels/a?x=1'],['GET','labels/a b'],['GET','repos/other/labels/x']])
    await assert.rejects(client.request(method,route),/許可/,method+' '+route);
  assert.equal(calls.length,0);
});
test('a tag that does not exist is a 404 the caller can tell apart from other failures',async()=>{
  const client=new GitHubClient(repository,{run:async()=>({status:404,headers:{},data:{message:'Not Found'}})});
  await assert.rejects(client.getLabel('なし'),error=>error instanceof GitHubFailure&&error.status===404);
  const limited=new GitHubClient(repository,{run:async()=>({status:403,headers:{},data:{message:'API rate limit exceeded'}})});
  await assert.rejects(limited.getLabel('予約'),error=>error instanceof GitHubFailure&&error.status===403);
});

test('the API accepts categories when a report is created and when they are replaced, and returns them in the list and the detail',async t=>{
  const fx=withRoles(t);fx.release();
  const server=createProgressServer({dataDir:fx.dir});server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const base='http://127.0.0.1:'+server.address().port+'/api/bugs/';
    const post=(route,body,headers={'Content-Type':'application/json'})=>fetch(base+route,{method:'POST',headers,body:typeof body==='string'?body:JSON.stringify(body)});
    const created=await post('reports',{body:'予約一覧が更新されない',reportedVersion:'',requestId:'api-1',uploadIds:[],categories:[12,11]});
    assert.equal(created.status,201);const report=(await created.json()).report;assert.deepEqual(report.categories,[11,12]);
    const bad=await post('reports',{body:'別の報告',reportedVersion:'',requestId:'api-2',uploadIds:[],categories:[14]});
    assert.equal(bad.status,400);assert.match((await bad.json()).error,/カテゴリ/);
    assert.deepEqual((await (await fetch(base+'reports')).json()).reports.find(item=>item.id===report.id).categories,[11,12]);
    const replaced=await post('reports/'+report.id+'/categories',{categories:[13],revision:report.revision});
    assert.equal(replaced.status,200);const updated=(await replaced.json()).report;assert.deepEqual(updated.categories,[13]);
    assert.deepEqual((await (await fetch(base+'reports/'+report.id)).json()).report.categories,[13]);
    assert.equal((await post('reports/'+report.id+'/categories',{categories:[12],revision:report.revision})).status,409);
    assert.equal((await post('reports/'+report.id+'/categories',{categories:[14],revision:updated.revision})).status,400);
    assert.equal((await post('reports/'+report.id+'/categories','x',{'Content-Type':'text/plain'})).status,415);
    assert.equal((await post('reports/'+report.id+'/categories','{',{'Content-Type':'application/json'})).status,400);
    assert.equal((await fetch(base+'reports/'+report.id+'/categories')).status,404);
    assert.equal((await post('reports/00000000-0000-0000-0000-000000000000/categories',{categories:[],revision:1})).status,404);
    assert.equal((await fetch(base+'reports/'+report.id+'/categories',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://evil.example'},body:'{}'})).status,403);
  } finally {await server.bugWorker?.stop();await new Promise(resolve=>server.close(resolve));await server.bugClosed;}
});
