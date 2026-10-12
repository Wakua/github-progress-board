import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {BugStore} from '../server/bug-store.mjs';
import {GitHubClient,GitHubFailure,parseBugRepository,parseResponse} from '../server/bug-github-client.mjs';
import {GitHubWorker,labelFallbackLimit,retryTime} from '../server/bug-github-worker.mjs';
import {createProgressServer} from '../server.mjs';
const approvedRepository='qa-fixture/booking-reports';

const url=(number,repository=approvedRepository)=>'https://github.com/'+repository+'/issues/'+number;
const label={id:7,name:'UI',color:'336699'};
function fake(repository=approvedRepository,now=()=>0) {
  return {repository,now,lag:0,posts:[],reads:[],issues:[],labels:[label],
    async createIssue(title,body){const issue={number:this.issues.length+101,html_url:url(this.issues.length+101,this.repository),title,body,labels:this.labels,at:this.now()};this.posts.push({title,body});this.issues.push(issue);return issue;},
    async getIssue(number){this.reads.push(number);const issue=this.issues.find(issue=>issue.number===number);if(!issue)throw new GitHubFailure('見つかりません。',{status:404});return{...issue,labels:this.labels};},
    async findIssues(marker){return this.issues.filter(issue=>issue.body.startsWith(marker+'\n')&&this.now()-(issue.at??-Infinity)>=this.lag);},
    lists:0,notListed:new Set(),
    async listIssues(){this.lists++;return new Map(this.issues.filter(issue=>!this.notListed.has(issue.number)).map(issue=>[issue.number,{...issue,labels:this.labels}]));}
  };
}
function fixture(t,{enabled=true}={}) {
  const dir=mkdtempSync(path.join(tmpdir(),'progress-bug-github-'));const store=new BugStore(dir,{initialize:true});
  for(const [id,role]of [['a','tester'],['b','tester'],['admin','admin']])store.createUser(id,id,role);
  const keys=Object.fromEntries(['a','b','admin'].map(id=>[id,store.issueKey(id)]));
  const actors=Object.fromEntries(Object.entries(keys).map(([id,key])=>[id,store.actorForKey(key.secret)]));
  let clock=100000;const client=fake(approvedRepository,()=>clock);
  const worker=enabled?new GitHubWorker(store,client,{clock:()=>clock}):null;
  t.after(async()=>{await (store.githubWorker||worker)?.stop();store.close();const relative=path.relative(tmpdir(),dir);assert.ok(relative&&!relative.startsWith('..'));rmSync(dir,{recursive:true,force:true});});
  const report=(id='a',body='バグ報告')=>store.createReport(actors[id],{body,reportedVersion:'test',requestId:crypto.randomUUID(),uploadIds:[]});
  return{dir,store,keys,actors,client,worker,report,setClock:value=>{clock=value;}};
}
test('gh response parsing includes rate headers and rejects malformed success bodies',()=>{
  const parsed=parseResponse('HTTP/2.0 429 Too Many Requests\r\nRetry-After: 120\r\nX-RateLimit-Remaining: 0\r\n\r\n{"message":"limited"}');
  assert.equal(parsed.status,429);assert.equal(parsed.headers['retry-after'],'120');
  assert.throws(()=>parseResponse('HTTP/2.0 201 Created\nContent-Type: application/json\n\nnot JSON'),error=>error.uncertain&&error.status===201);
});
test('GitHub client permits only the chosen repository and creation/read routes',async()=>{
  const calls=[];const client=new GitHubClient(approvedRepository,{run:async(args,input)=>{
    calls.push({args,input});return{status:201,headers:{},data:{number:42,html_url:url(42),body:'body',labels:[]}};
  }});
  await client.createIssue('title','body');
  assert.deepEqual(JSON.parse(calls[0].input),{title:'title',body:'body'});
  assert.ok(calls[0].args.includes('--input'));assert.ok(calls[0].args.includes('repos/'+approvedRepository+'/issues'));
  assert.equal(calls[0].args.includes('--verbose'),false);
  assert.throws(()=>new GitHubClient(''));
  for(const invalid of ['owner','../repo','owner/repo/issues','owner/repo?token=x','https://user:secret@github.com/owner/repo']) assert.throws(()=>new GitHubClient(invalid));
  assert.equal(new GitHubClient('qa-fixture/another').repository,'qa-fixture/another');
  for(const [method,route]of [['PATCH','issues/42'],['POST','issues/42/comments'],['PUT','issues/42/labels'],['GET','../../../user']])await assert.rejects(client.request(method,route),/許可/);
  assert.equal(calls.length,1);
});
test('GitHub client marks server failures as uncertain and permission failures as definite',async()=>{
  for(const status of [403,503]) {
    const client=new GitHubClient(approvedRepository,{run:async()=>({status,headers:{},data:{message:'failed'}})});
    await assert.rejects(client.createIssue('x','x'),error=>error.status===status&&error.uncertain===(status===503));
  }
});
test('reconciliation reads all pages, excludes PRs, and matches only the generated first-line marker',async()=>{
  const marker='<!-- marker -->';let pages=0;
  const client=new GitHubClient(approvedRepository,{run:async args=>{
    pages++;return{status:200,headers:{},data:pages===1?
      Array.from({length:100},(_,index)=>({number:index+1,html_url:url(index+1),body:index===0?'content\n'+marker+'\n':''})):
      [{number:101,html_url:url(101),body:marker+'\ncorrect'},{number:102,html_url:url(102),body:marker+'\nPR',pull_request:{}}]};
  }});
  assert.equal((await client.findIssues(marker))[0].number,101);assert.equal(pages,2);
});
test('failed or incomplete reads do not establish a zero-candidate reconciliation',async()=>{
  let page=0;const client=new GitHubClient(approvedRepository,{run:async()=>{page++;if(page===2)throw new GitHubFailure('途中で失敗しました。');return{status:200,headers:{},data:Array.from({length:100},(_,index)=>({number:index+1,html_url:url(index+1),body:''}))};}});
  await assert.rejects(client.findIssues('marker'));
});
test('issue lookup reads newest first, stops at issues older than the report, and counts a repeated issue once',async()=>{
  const marker='<!-- marker -->',calls=[],base=Date.parse('2026-10-01T12:00:00Z');
  const issue=(number,minutesAgo,body='')=>({number,html_url:url(number),body,created_at:new Date(base-minutesAgo*60000).toISOString()});
  const old=new GitHubClient(approvedRepository,{run:async args=>{
    calls.push(args.at(-1));const page=Number(/&page=(\d+)$/.exec(args.at(-1))[1]);
    return{status:200,headers:{},data:Array.from({length:100},(_,index)=>issue(10000-(page-1)*100-index,(page-1)*1000+index*10,index===3?marker+'\n':''))};
  }});
  const found=await old.findIssues(marker,{createdAfter:new Date(base-60*60000).toISOString()});
  assert.match(calls[0],/sort=created&direction=desc&/);
  assert.equal(calls.length,1);assert.deepEqual(found.map(item=>item.number),[9997]);
  let pages=0;const shifted=new GitHubClient(approvedRepository,{run:async()=>{
    pages++;return{status:200,headers:{},data:pages===1?Array.from({length:100},(_,index)=>issue(500-index,index,index===99?marker+'\n':'')):[issue(401,100,marker+'\n')]};
  }});
  assert.deepEqual((await shifted.findIssues(marker)).map(item=>item.number),[401]);assert.equal(pages,2);
});
test('right after a lost creation, neither reconciliation nor retry can create a second issue',async t=>{
  const fx=fixture(t);fx.client.lag=8000;const original=fx.client.createIssue.bind(fx.client);
  fx.client.createIssue=async(...args)=>{await original(...args);throw new GitHubFailure('応答欠落',{uncertain:true});};
  const report=fx.report();await fx.worker.processOne();
  assert.equal(fx.store.registration(report.id).state,'unknown');assert.equal(fx.client.posts.length,1);
  fx.setClock(101100);await fx.worker.reconcile(fx.actors.admin,report.id);
  const early=fx.store.registration(report.id);
  assert.deepEqual(early.candidates,[]);assert.equal(early.holdUntil,160000);
  await assert.rejects(fx.worker.retryUnknown(fx.actors.admin,report.id,{confirmNoIssue:true,revision:early.revision}),error=>error.status===409&&/直後/.test(error.message));
  assert.equal(fx.store.registration(report.id).state,'unknown');
  fx.setClock(160000);await fx.worker.reconcile(fx.actors.admin,report.id);
  assert.equal(fx.store.registration(report.id).state,'registered');assert.equal(fx.client.posts.length,1);
});
test('a zero-candidate check releases a retry only when it started a full settle period after the attempt',async t=>{
  const fx=fixture(t);fx.client.lag=Infinity;fx.client.createIssue=async()=>{throw new GitHubFailure('不明',{uncertain:true});};
  const report=fx.report();await fx.worker.processOne();
  for(const [time,released] of [[159999,false],[160000,true]]) {
    fx.setClock(time);await fx.worker.reconcile(fx.actors.admin,report.id);
    const checked=fx.store.registration(report.id),retry=fx.worker.retryUnknown(fx.actors.admin,report.id,{confirmNoIssue:true,revision:checked.revision});
    if(released)await retry;else await assert.rejects(retry,error=>error.status===409);
  }
  assert.equal(fx.store.registration(report.id).state,'pending');
});
test('the settle period counts from the creation request, not from the start of a slow lookup',async t=>{
  const fx=fixture(t);fx.client.lag=8000;
  const find=fx.client.findIssues.bind(fx.client),create=fx.client.createIssue.bind(fx.client);
  let slow=true;
  fx.client.findIssues=async(...args)=>{if(slow){slow=false;fx.setClock(155000);}return find(...args);};
  fx.client.createIssue=async(...args)=>{await create(...args);throw new GitHubFailure('応答欠落',{uncertain:true});};
  const report=fx.report();await fx.worker.processOne();
  fx.setClock(160000);await fx.worker.reconcile(fx.actors.admin,report.id);
  const early=fx.store.registration(report.id);
  assert.deepEqual(early.candidates,[]);assert.equal(early.holdUntil,215000);
  await assert.rejects(fx.worker.retryUnknown(fx.actors.admin,report.id,{confirmNoIssue:true,revision:early.revision}),error=>error.status===409);
  assert.equal(fx.client.posts.length,1);
  fx.setClock(215000);await fx.worker.reconcile(fx.actors.admin,report.id);
  assert.equal(fx.store.registration(report.id).state,'registered');assert.equal(fx.client.posts.length,1);
});
test('registering after a restore to an older backup links the existing issue instead of creating another',async t=>{
  const fx=fixture(t);const report=fx.report();await fx.worker.processOne();
  const registered=fx.store.registration(report.id);assert.equal(registered.state,'registered');
  const restore=repository=>fx.store.db.prepare("UPDATE registration_queue SET state='pending',repository=?,issue_number=NULL,issue_url=NULL,attempts=0,attempted_at=NULL,label_state='unfetched',labels=NULL,labels_at=NULL,revision=1 WHERE report_id=?").run(repository,report.id);
  restore(fx.client.repository);fx.setClock(900000);await fx.worker.serialize(()=>fx.worker.processOne());
  assert.equal(fx.client.posts.length,1);assert.equal(fx.store.registration(report.id).state,'registered');assert.equal(fx.store.registration(report.id).number,registered.number);
  restore(null);await fx.worker.register(fx.actors.admin,report.id);await fx.worker.serialize(()=>fx.worker.processOne());
  assert.equal(fx.client.posts.length,1);assert.equal(fx.store.registration(report.id).number,registered.number);
});
test('several issues with the same identifier stop registration for a manual check',async t=>{
  const fx=fixture(t);const report=fx.report();
  fx.client.issues=[201,202].map(number=>({number,html_url:url(number),body:fx.worker.marker(report.id)+'\n',labels:[]}));
  await fx.worker.processOne();
  const row=fx.store.registration(report.id);
  assert.equal(row.state,'unknown');assert.deepEqual(row.candidates.map(item=>item.number),[201,202]);assert.equal(fx.client.posts.length,0);
  await assert.rejects(fx.worker.retryUnknown(fx.actors.admin,report.id,{confirmNoIssue:true,revision:row.revision}),error=>error.status===409);
});
test('a failed lookup never reaches creation and does not mark the result unknown',async t=>{
  const fx=fixture(t);const find=fx.client.findIssues.bind(fx.client);
  const report=fx.report(),limited=fx.report();
  fx.client.findIssues=async()=>{throw new GitHubFailure('GitHubの処理を完了できませんでした。',{status:503});};
  await fx.worker.processOne();
  assert.equal(fx.store.registration(report.id).state,'failed');assert.equal(fx.client.posts.length,0);
  fx.client.findIssues=async()=>{throw new GitHubFailure('利用制限',{status:429,headers:{'retry-after':'120'}});};
  await fx.worker.processOne();
  assert.equal(fx.store.registration(limited.id).state,'pending');assert.equal(fx.store.registration(limited.id).retryAt,220000);assert.equal(fx.client.posts.length,0);
  fx.client.findIssues=find;fx.setClock(220001);
  await fx.worker.register(fx.actors.admin,report.id);await fx.worker.serialize(()=>fx.worker.processOne());await fx.worker.serialize(()=>fx.worker.processOne());
  assert.equal(fx.client.posts.length,2);
});
test('creation is serialized, linked durably, and tags are fetched without changing the report',async t=>{
  const fx=fixture(t);const report=fx.report();const before=fx.store.getReport(fx.actors.a,report.id);
  await Promise.all([fx.worker.serialize(()=>fx.worker.processOne()),fx.worker.serialize(()=>fx.worker.processOne())]);
  const after=fx.store.getReport(fx.actors.a,report.id);
  assert.equal(fx.client.posts.length,1);assert.equal(after.github.state,'registered');assert.equal(after.github.number,101);
  assert.deepEqual(after.github.tags.labels,[label]);
  for(const key of ['body','reportedVersion','revision','status','createdAt','updatedAt','attachments'])assert.deepEqual(after[key],before[key]);
});
test('connection-time backlog stays unbound until an administrator selects it',async t=>{
  const fx=fixture(t,{enabled:false});const report=fx.report();
  const worker=new GitHubWorker(fx.store,fx.client);
  await worker.processOne();assert.equal(fx.client.posts.length,0);
  await assert.rejects(worker.register(fx.actors.a,report.id),error=>error.status===403);
  await worker.register(fx.actors.admin,report.id);await worker.serialize(()=>worker.processOne());
  assert.equal(fx.client.posts.length,1);
});
test('a lost creation reply is reconciled to the existing issue without another POST',async t=>{
  const fx=fixture(t);const original=fx.client.createIssue.bind(fx.client);
  fx.client.createIssue=async(...args)=>{await original(...args);throw new GitHubFailure('応答欠落',{uncertain:true});};
  const report=fx.report();await fx.worker.processOne();assert.equal(fx.store.registration(report.id).state,'unknown');
  await fx.worker.processOne();await assert.rejects(fx.worker.register(fx.actors.admin,report.id),error=>error.status===409);
  await fx.worker.reconcile(fx.actors.admin,report.id);
  assert.equal(fx.client.posts.length,1);assert.equal(fx.store.registration(report.id).state,'registered');
});
test('uncertain network or server failures never automatically create again',async t=>{
  const fx=fixture(t);fx.client.createIssue=async()=>{fx.client.posts.push({});throw new GitHubFailure('通信失敗',{status:503,uncertain:true});};
  const report=fx.report();await fx.worker.processOne();await fx.worker.processOne();
  assert.equal(fx.store.registration(report.id).state,'unknown');assert.equal(fx.client.posts.length,1);assert.equal(fx.store.getReport(fx.actors.a,report.id).body,'バグ報告');
});
test('restart changes an in-flight creation to unknown and keeps its namespace',async t=>{
  const fx=fixture(t);const report=fx.report();const marker=fx.worker.marker(report.id);
  fx.store.db.prepare("UPDATE registration_queue SET state='creating' WHERE report_id=?").run(report.id);
  await fx.worker.stop();const worker=new GitHubWorker(fx.store,fx.client);
  assert.equal(fx.store.registration(report.id).state,'unknown');assert.equal(worker.marker(report.id),marker);
  await worker.processOne();assert.equal(fx.client.posts.length,0);
});
test('one worker owns the store while it is running',t=>{
  const fx=fixture(t);assert.throws(()=>new GitHubWorker(fx.store,fx.client),/実行中/);
});
test('association commit failure is recovered from the created issue',async t=>{
  const fx=fixture(t);const report=fx.report();
  fx.store.db.exec("CREATE TRIGGER fail_link BEFORE UPDATE ON registration_queue WHEN NEW.state='registered' BEGIN SELECT RAISE(ABORT,'write failed'); END");
  await fx.worker.processOne();assert.equal(fx.store.registration(report.id).state,'unknown');assert.equal(fx.client.posts.length,1);
  fx.store.db.exec('DROP TRIGGER fail_link');await fx.worker.reconcile(fx.actors.admin,report.id);
  assert.equal(fx.store.registration(report.id).state,'registered');assert.equal(fx.client.posts.length,1);
});
test('permission failure stays visible and only an administrator can retry',async t=>{
  const fx=fixture(t);const create=fx.client.createIssue.bind(fx.client);fx.client.createIssue=async()=>{throw new GitHubFailure('権限不足',{status:403});};
  const report=fx.report();await fx.worker.processOne();assert.equal(fx.store.registration(report.id).state,'failed');
  await assert.rejects(fx.worker.register(fx.actors.b,report.id),error=>error.status===403);
  fx.client.createIssue=create;await fx.worker.register(fx.actors.admin,report.id);await fx.worker.serialize(()=>fx.worker.processOne());
  assert.equal(fx.store.registration(report.id).state,'registered');
});
test('rate limits persist a shared cooldown and prevent every report from retrying early',async t=>{
  const fx=fixture(t);const original=fx.client.createIssue.bind(fx.client);let attempts=0;
  fx.client.createIssue=async(...args)=>{attempts++;if(attempts===1)throw new GitHubFailure('利用制限',{status:429,headers:{'retry-after':'120'}});return original(...args);};
  const first=fx.report(),second=fx.report();await fx.worker.processOne();await fx.worker.processOne();
  assert.equal(attempts,1);assert.equal(fx.store.registration(first.id).retryAt,220000);
  await assert.rejects(fx.worker.register(fx.actors.admin,second.id),error=>error.status===429);
  fx.setClock(220001);await fx.worker.processOne();await fx.worker.processOne();assert.equal(attempts,3);
});
test('retry time observes remaining/reset headers and backs off on secondary limits',()=>{
  assert.equal(retryTime({status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':'500'}},100000),500000);
  assert.equal(retryTime({status:403,headers:{'rate-limited':'true'}},100000,2),220000);
  assert.equal(retryTime({status:403,headers:{}},100000),0);
});
test('zero candidates require a fresh matching revision and explicit administrator acknowledgement',async t=>{
  const fx=fixture(t);fx.client.createIssue=async()=>{throw new GitHubFailure('不明',{uncertain:true});};
  const report=fx.report();await fx.worker.processOne();fx.setClock(160000);await fx.worker.reconcile(fx.actors.admin,report.id);
  const checked=fx.store.registration(report.id);
  for(const input of [{confirmNoIssue:false,revision:checked.revision},{confirmNoIssue:true,revision:checked.revision-1}])await assert.rejects(fx.worker.retryUnknown(fx.actors.admin,report.id,input),error=>error.status===409);
  await fx.worker.retryUnknown(fx.actors.admin,report.id,{confirmNoIssue:true,revision:checked.revision});
  await assert.rejects(fx.worker.retryUnknown(fx.actors.admin,report.id,{confirmNoIssue:true,revision:checked.revision}),error=>error.status===409);
});
test('expired or multiple-candidate reconciliation cannot release another creation',async t=>{
  const fx=fixture(t);fx.client.createIssue=async()=>{throw new GitHubFailure('不明',{uncertain:true});};
  const report=fx.report();await fx.worker.processOne();await fx.worker.reconcile(fx.actors.admin,report.id);
  let checked=fx.store.registration(report.id);fx.setClock(400001);
  await assert.rejects(fx.worker.retryUnknown(fx.actors.admin,report.id,{confirmNoIssue:true,revision:checked.revision}),error=>error.status===409);
  fx.client.issues=[201,202].map(number=>({number,html_url:url(number),body:fx.worker.marker(report.id)+'\n',labels:[]}));
  await fx.worker.reconcile(fx.actors.admin,report.id);checked=fx.store.registration(report.id);
  await assert.rejects(fx.worker.retryUnknown(fx.actors.admin,report.id,{confirmNoIssue:true,revision:checked.revision}),error=>error.status===409);
  assert.equal(checked.candidates.length,2);
});
test('tag changes and removal replace the snapshot; failed reads retain earlier tags',async t=>{
  const fx=fixture(t);const report=fx.report();await fx.worker.processOne();
  fx.client.labels=[{id:8,name:'入力画面',color:'abcdef'}];await fx.worker.refreshLabels(fx.actors.admin,report.id);
  assert.equal(fx.store.registration(report.id).tags.labels[0].name,'入力画面');
  const get=fx.client.getIssue;fx.client.getIssue=async()=>{throw new GitHubFailure('取得失敗',{status:403});};
  await fx.worker.refreshLabels(fx.actors.admin,report.id);
  assert.equal(fx.store.registration(report.id).tags.state,'error');assert.equal(fx.store.registration(report.id).tags.labels[0].name,'入力画面');
  fx.client.getIssue=get;fx.client.labels=[];await fx.worker.refreshLabels(fx.actors.admin,report.id);
  assert.equal(fx.store.registration(report.id).tags.state,'ok');assert.deepEqual(fx.store.registration(report.id).tags.labels,[]);
  assert.equal(fx.store.getReport(fx.actors.a,report.id).status,'received');
});
test('invalid tag snapshots never replace the last valid cache',async t=>{
  const fx=fixture(t);const report=fx.report();await fx.worker.processOne();fx.client.labels=[{...label,color:'url(javascript:x)'}];
  await fx.worker.refreshLabels(fx.actors.admin,report.id);
  assert.equal(fx.store.registration(report.id).tags.state,'error');assert.deepEqual(fx.store.registration(report.id).tags.labels,[label]);
});
async function registerAll(fx,count) {
  const reports=[];
  for(let index=0;index<count;index++){reports.push(fx.report('a','報告'+index));await fx.worker.processOne();}
  return reports;
}
const newTag={id:8,name:'入力画面',color:'abcdef'};
test('Issue一覧の読み取りは、新しい順に読み、PRを除き、境界で止まる',async()=>{
  const calls=[],base=Date.parse('2026-10-01T12:00:00Z');
  const issue=(number,minutesAgo,extra={})=>({number,html_url:url(number),body:'',created_at:new Date(base-minutesAgo*60000).toISOString(),...extra});
  const client=new GitHubClient(approvedRepository,{run:async args=>{
    calls.push(args.at(-1));const page=Number(/&page=(\d+)$/.exec(args.at(-1))[1]);
    return{status:200,headers:{},data:page===1?[issue(1000,1),issue(999,2,{pull_request:{}}),...Array.from({length:98},(_,index)=>issue(900-index,3+index*2))]:[issue(5,9000)]};
  }});
  const all=await client.listIssues();
  assert.equal(calls.length,2);assert.match(calls[0],/sort=created&direction=desc&/);
  assert.ok(all.has(1000)&&all.has(5)&&!all.has(999));assert.equal(all.size,100);
  calls.length=0;
  const bounded=await client.listIssues({createdAfter:new Date(base-60*60000).toISOString()});
  assert.equal(calls.length,1);assert.ok(bounded.has(1000));assert.ok(!bounded.has(5));
});
test('タグのまとめての取得は、一覧を1回だけ読み、登録済みの全報告のタグを取り直す',async t=>{
  const fx=fixture(t);const reports=await registerAll(fx,3);const reads=fx.client.reads.length;
  fx.client.labels=[newTag];
  assert.deepEqual(await fx.worker.refreshAllLabels(fx.actors.admin),{total:3,updated:3,failed:0});
  assert.equal(fx.client.lists,1);assert.equal(fx.client.reads.length,reads);
  for(const report of reports){const tags=fx.store.registration(report.id).tags;assert.equal(tags.state,'ok');assert.deepEqual(tags.labels,[newTag]);}
  assert.equal(fx.store.getReport(fx.actors.a,reports[0].id).status,'received');
});
test('一覧に載らなかった報告だけ、番号で個別に取得する',async t=>{
  const fx=fixture(t);await registerAll(fx,3);const reads=fx.client.reads.length;
  fx.client.notListed.add(102);fx.client.labels=[newTag];
  assert.deepEqual(await fx.worker.refreshAllLabels(fx.actors.admin),{total:3,updated:3,failed:0});
  assert.deepEqual(fx.client.reads.slice(reads),[102]);
});
test('一覧に載らなかった報告が上限を超えるときは、上限までを個別に取得し、残りは取得失敗にして前回のタグを残す',async t=>{
  const fx=fixture(t);const count=labelFallbackLimit+2;const reports=await registerAll(fx,count);const reads=fx.client.reads.length;
  for(let number=101;number<101+count;number++)fx.client.notListed.add(number);fx.client.labels=[newTag];
  assert.deepEqual(await fx.worker.refreshAllLabels(fx.actors.admin),{total:count,updated:labelFallbackLimit,failed:2});
  assert.equal(fx.client.reads.length-reads,labelFallbackLimit);
  const states=reports.map(report=>fx.store.registration(report.id).tags);
  assert.deepEqual(states.map(tags=>tags.state),[...Array(labelFallbackLimit).fill('ok'),'error','error']);
  assert.deepEqual(states.at(-1).labels,[label]);assert.match(states.at(-1).error,/もう一度/);
  fx.client.notListed.clear();
  assert.deepEqual(await fx.worker.refreshAllLabels(fx.actors.admin),{total:count,updated:count,failed:0});
});
test('Issueが見つからない報告だけが取得失敗になり、前回のタグを残す',async t=>{
  const fx=fixture(t);const reports=await registerAll(fx,2);
  fx.client.issues=fx.client.issues.filter(issue=>issue.number!==101);fx.client.labels=[newTag];
  assert.deepEqual(await fx.worker.refreshAllLabels(fx.actors.admin),{total:2,updated:1,failed:1});
  const lost=fx.store.registration(reports[0].id).tags;assert.equal(lost.state,'error');assert.deepEqual(lost.labels,[label]);
  assert.deepEqual(fx.store.registration(reports[1].id).tags.labels,[newTag]);
});
test('一覧を読めなかったときは、個別に取得せず、全報告を取得失敗にして前回のタグを残す',async t=>{
  const fx=fixture(t);const reports=await registerAll(fx,2);const reads=fx.client.reads.length;
  fx.client.listIssues=async()=>{throw new GitHubFailure('取得失敗',{status:500});};
  assert.deepEqual(await fx.worker.refreshAllLabels(fx.actors.admin),{total:2,updated:0,failed:2});
  assert.equal(fx.client.reads.length,reads);
  for(const report of reports){const tags=fx.store.registration(report.id).tags;assert.equal(tags.state,'error');assert.deepEqual(tags.labels,[label]);}
});
test('無効なタグを含むIssueだけが取得失敗になり、ほかの報告は更新される',async t=>{
  const fx=fixture(t);const reports=await registerAll(fx,2);
  const list=fx.client.listIssues.bind(fx.client);
  fx.client.listIssues=async()=>{const issues=await list();issues.get(101).labels=[{...label,color:'url(javascript:x)'}];issues.get(102).labels=[newTag];return issues;};
  assert.deepEqual(await fx.worker.refreshAllLabels(fx.actors.admin),{total:2,updated:1,failed:1});
  assert.equal(fx.store.registration(reports[0].id).tags.state,'error');assert.deepEqual(fx.store.registration(reports[0].id).tags.labels,[label]);
  assert.deepEqual(fx.store.registration(reports[1].id).tags.labels,[newTag]);
});
test('現在の接続先でない報告と、登録済みでない報告は、タグの取得の対象にしない',async t=>{
  const fx=fixture(t);const [moved]=await registerAll(fx,1);fx.report('a','登録待ちのまま');
  fx.store.db.prepare('UPDATE registration_queue SET repository=? WHERE report_id=?').run('other/repository',moved.id);
  assert.deepEqual(await fx.worker.refreshAllLabels(fx.actors.admin),{total:0,updated:0,failed:0});
  assert.equal(fx.client.lists,0);
});
test('タグのまとめての取得は、管理者だけが行え、利用制限の待機中は読み取らない',async t=>{
  const fx=fixture(t);await registerAll(fx,1);
  await assert.rejects(fx.worker.refreshAllLabels(fx.actors.a),error=>error.status===403);
  fx.store.db.prepare('UPDATE github_runtime SET cooldown_until=? WHERE id=1').run(200000);
  await assert.rejects(fx.worker.refreshAllLabels(fx.actors.admin),error=>error.status===429);
  assert.equal(fx.client.lists,0);
});
test('HTTPのタグのまとめての取得は、共通の利用者で行い、POSTのJSONだけを受け付ける',async t=>{
  const fx=fixture(t,{enabled:false});const report=fx.report();const server=createProgressServer({dataDir:fx.dir,githubClient:fx.client});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port+'/api/bugs/';
  try {
    assert.equal((await fetch(base+'reports/'+report.id+'/github/register',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200);
    await server.bugWorker.serialize(()=>server.bugWorker.processOne());
    fx.client.labels=[newTag];
    const post=(options={})=>fetch(base+'github/tags',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',...options});
    const done=await post();assert.equal(done.status,200);assert.deepEqual(await done.json(),{total:1,updated:1,failed:0});
    assert.deepEqual(fx.store.registration(report.id).tags.labels,[newTag]);
    assert.equal((await fetch(base+'github/tags')).status,404);
    assert.equal((await post({headers:{'Content-Type':'application/json',Origin:'https://other.example'}})).status,403);
    assert.equal((await post({headers:{}})).status,415);
  } finally {await server.bugWorker.stop();await new Promise(resolve=>server.close(resolve));await server.bugClosed;}
});
test('GitHubの接続が無効なら、タグのまとめての取得は503を返す',async t=>{
  const fx=fixture(t,{enabled:false});fx.report();
  const server=createProgressServer({dataDir:fx.dir});server.listen(0,'127.0.0.1');await once(server,'listening');
  try {assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/api/bugs/github/tags',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,503);}
  finally {await new Promise(resolve=>server.close(resolve));await server.bugClosed;}
});
test('report excerpts keep the full text locally and a stable first-line marker in GitHub',t=>{
  const fx=fixture(t);const body='音'.repeat(20000);const report=fx.report('a',body),payload=fx.worker.payload(report.id);
  assert.ok(payload.body.startsWith(fx.worker.marker(report.id)+'\n'));assert.match(payload.body,/抜粋/);assert.ok(Buffer.byteLength(payload.body)<65536);
  assert.equal(fx.store.getReport(fx.actors.a,report.id).body,body);
});
test('schema v1 migration preserves reports, attachments, and the pending queue',t=>{
  const fx=fixture(t,{enabled:false});const report=fx.report();
  const attached=fx.store.reserveAttachment(fx.actors.a,report.id,{name:'save',size:3,type:''});writeFileSync(fx.store.filePath(attached.id),'abc');fx.store.finishAttachment(attached.id,'hash');
  fx.store.db.exec("DROP TABLE report_events; ALTER TABLE reports DROP COLUMN status; ALTER TABLE reports DROP COLUMN target_version; ALTER TABLE reports DROP COLUMN developer_note; DROP TABLE registration_queue; CREATE TABLE registration_queue(report_id TEXT PRIMARY KEY REFERENCES reports(id),state TEXT NOT NULL DEFAULT 'pending') STRICT; DROP TABLE github_runtime; PRAGMA user_version=1;");
  fx.store.db.prepare('INSERT INTO registration_queue(report_id) VALUES(?)').run(report.id);
  // Reopen another connection only for migration; the fixture closes the original handle afterwards.
  const reopened=new BugStore(fx.dir);
  try{assert.equal(reopened.getReport(fx.actors.a,report.id).body,'バグ報告');assert.equal(reopened.registration(report.id).state,'pending');assert.equal(readFileSync(reopened.filePath(attached.id),'utf8'),'abc');assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,4);}finally{reopened.close();}
});
test('schema v3 migration treats an unconfirmed report as attempted at the update',t=>{
  const fx=fixture(t,{enabled:false});const unknown=fx.report(),failed=fx.report();
  fx.store.db.prepare("UPDATE registration_queue SET state='unknown' WHERE report_id=?").run(unknown.id);
  fx.store.db.prepare("UPDATE registration_queue SET state='failed' WHERE report_id=?").run(failed.id);
  fx.store.db.exec('ALTER TABLE registration_queue DROP COLUMN attempted_at; PRAGMA user_version=3;');
  const before=Date.now();const reopened=new BugStore(fx.dir);
  try{
    assert.ok(reopened.registration(unknown.id).holdUntil>=before+60000);
    assert.equal(reopened.registration(failed.id).holdUntil,null);
    assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,4);
  }finally{reopened.close();}
});
test('HTTP GitHub operations use the common local user and report reads use saved metadata',async t=>{
  const fx=fixture(t,{enabled:false});const report=fx.report();const server=createProgressServer({dataDir:fx.dir,githubClient:fx.client});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port+'/api/bugs/';
  try {
  const post=(action,user,input={})=>fetch(base+'reports/'+report.id+'/github/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.equal((await post('register','admin')).status,200);await server.bugWorker.serialize(()=>server.bugWorker.processOne());
  const read=await fetch(base+'reports/'+report.id,{headers:{Authorization:'Bearer '+fx.keys.a.secret}});
  assert.equal((await read.json()).report.github.state,'registered');
  const calls=fx.client.reads.length;await fetch(base+'reports',{headers:{Authorization:'Bearer '+fx.keys.a.secret}});assert.equal(fx.client.reads.length,calls);
  assert.equal((await post('tags','admin')).status,200);assert.equal((await post('tags','b')).status,200);
  } finally {await server.bugWorker.stop();await new Promise(resolve=>server.close(resolve));await server.bugClosed;}
});

test('repository configuration accepts GitHub repositories and keeps the default empty',()=>{
  for(const value of [undefined,null,'','   '])assert.equal(parseBugRepository(value),null);
  assert.equal(parseBugRepository(' qa-fixture/booking-reports '),approvedRepository);
  assert.equal(parseBugRepository('https://github.com/qa-fixture/booking-reports.git'),approvedRepository);
  for(const value of [42,{},'owner','owner/repo/issues','https://example.com/owner/repo','https://github.com/owner/repo?token=x'])assert.throws(()=>parseBugRepository(value));
});
test('unconfigured HTTP registration stores reports without GitHub writes',async t=>{
  const fx=fixture(t,{enabled:false});const report=fx.report();
  const server=createProgressServer({repositories:[],dataDir:fx.dir,githubRepository:''});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port+'/api/bugs/';
  try {
    const me=await(await fetch(base+'me')).json();
    assert.equal(me.github.enabled,false);assert.equal(me.github.repository,null);
    const registration=await fetch(base+'reports/'+report.id+'/github/register',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(registration.status,503);
    const saved=(await(await fetch(base+'reports/'+report.id)).json()).report;
    assert.equal(saved.github.repository,null);assert.equal(saved.body,'バグ報告');
    assert.equal(fx.client.posts.length,0);assert.equal(server.bugWorker,undefined);
  } finally {await new Promise(resolve=>server.close(resolve));await server.bugClosed;}
});
test('changed repository preserves old queues and processes only new reports',async t=>{
  const fx=fixture(t);const pending=fx.report(),creating=fx.report();
  fx.store.db.prepare("UPDATE registration_queue SET state='creating' WHERE report_id=?").run(creating.id);
  await fx.worker.stop();
  const client=fake('qa-fixture/another');const worker=new GitHubWorker(fx.store,client);
  await worker.processOne();assert.equal(client.posts.length,0);
  assert.equal(fx.store.registration(pending.id).state,'pending');assert.equal(fx.store.registration(creating.id).state,'creating');
  await assert.rejects(worker.register(fx.actors.admin,pending.id),error=>error.status===409);
  const fresh=fx.report();await worker.processOne();
  assert.equal(client.posts.length,1);assert.equal(fx.store.registration(fresh.id).repository,client.repository);
  assert.equal(fx.store.registration(fresh.id).url,url(101,client.repository));
});
function switchRepository(fx,repository) {
  const client=fake(repository);
  return fx.worker.stop().then(()=>({client,worker:new GitHubWorker(fx.store,client)}));
}
test('a report that failed against a wrong repository registers again after the setting is fixed',async t=>{
  const fx=fixture(t,{enabled:false});const wrong=fake('qa-fixture/booking-reportz');
  wrong.createIssue=async()=>{throw new GitHubFailure('GitHubリポジトリまたはIssueを確認してください。',{status:404});};
  const first=new GitHubWorker(fx.store,wrong);const report=fx.report();
  await first.processOne();assert.equal(fx.store.registration(report.id).state,'failed');assert.equal(fx.store.registration(report.id).repository,wrong.repository);
  await first.stop();
  const worker=new GitHubWorker(fx.store,fx.client);
  await assert.rejects(worker.reconcile(fx.actors.admin,report.id),error=>error.status===409);
  await worker.register(fx.actors.admin,report.id);
  assert.equal(fx.store.registration(report.id).repository,approvedRepository);assert.equal(fx.store.registration(report.id).state,'pending');
  await worker.serialize(()=>worker.processOne());
  const saved=fx.store.registration(report.id);
  assert.equal(saved.state,'registered');assert.equal(saved.url,url(101));assert.equal(fx.client.posts.length,1);
});
test('a registered report cannot be registered again under another repository',async t=>{
  const fx=fixture(t);const report=fx.report();await fx.worker.processOne();
  const before=fx.store.registration(report.id);assert.equal(before.state,'registered');
  const {client,worker}=await switchRepository(fx,'qa-fixture/another');
  for(const action of [()=>worker.register(fx.actors.admin,report.id),()=>worker.reconcile(fx.actors.admin,report.id),()=>worker.refreshLabels(fx.actors.admin,report.id)])await assert.rejects(action(),error=>error.status===409);
  await worker.processOne();
  const after=fx.store.registration(report.id);
  assert.equal(client.posts.length,0);assert.equal(client.reads.length,0);
  assert.deepEqual([after.repository,after.number,after.url,after.state],[before.repository,before.number,before.url,before.state]);
});
test('an unconfirmed report is reconciled and confirmed before registering, even after the repository changes',async t=>{
  const fx=fixture(t);fx.client.createIssue=async(...args)=>{fx.client.posts.push({});throw new GitHubFailure('不明',{uncertain:true});};
  const report=fx.report();await fx.worker.processOne();assert.equal(fx.store.registration(report.id).state,'unknown');
  const {client,worker}=await switchRepository(fx,'qa-fixture/another');
  for(const action of [()=>worker.register(fx.actors.admin,report.id),()=>worker.reconcile(fx.actors.admin,report.id),()=>worker.retryUnknown(fx.actors.admin,report.id,{confirmNoIssue:true,revision:fx.store.registration(report.id).revision})])await assert.rejects(action(),error=>error.status===409);
  await worker.processOne();
  assert.equal(client.posts.length,0);assert.equal(fx.store.registration(report.id).state,'unknown');assert.equal(fx.store.registration(report.id).repository,approvedRepository);
  await worker.stop();const original=new GitHubWorker(fx.store,fx.client);
  await assert.rejects(original.register(fx.actors.admin,report.id),error=>error.status===409);
  await assert.rejects(original.retryUnknown(fx.actors.admin,report.id,{confirmNoIssue:true,revision:fx.store.registration(report.id).revision}),error=>error.status===409);
  await original.reconcile(fx.actors.admin,report.id);assert.equal(fx.store.registration(report.id).candidates.length,0);
});
