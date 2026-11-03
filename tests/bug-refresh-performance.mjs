// Optional measurement on fictional reports and an in-memory GitHub client.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir,cpus,platform,release} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {BugStore} from '../server/bug-store.mjs';
import {GitHubWorker} from '../server/bug-github-worker.mjs';
import {createProgressServer} from '../server.mjs';

const summarize=samples=>{
  const sorted=samples.toSorted((a,b)=>a-b),middle=Math.floor(sorted.length/2),round=n=>Math.round(n*100)/100;
  return {samples:samples.length,p50Ms:round(sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2),p95Ms:round(sorted[Math.ceil(sorted.length*.95)-1]),maxMs:round(sorted.at(-1)),samplesMs:samples};
};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const artifactDir=path.resolve(process.env.QA_ARTIFACT_DIR||'references/bug-refresh-performance');
await mkdir(artifactDir,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined});
const result={at:new Date().toISOString(),productCommit:'e65878a',node:process.version,platform:platform()+' '+release(),cpu:cpus()[0].model,browser:await browser.version(),externalGitHub:false,conditions:[],errors:[]};
try {
  for(const count of [50,250,500]) {
    const dataDir=await mkdtemp(path.join(tmpdir(),'bug-refresh-measure-'));
    let store,seedWorker,server,context,gate,listStarted;
    const issues=new Map(),events=[];
    const client={
      repository:'qa-fixture/booking-reports',
      async listIssues(){
        if(gate){events.push({event:'list-start',at:performance.now()});listStarted.resolve();await gate.promise;events.push({event:'list-return',at:performance.now()});}
        return new Map(issues);
      },
      async findIssues(marker){events.push({event:'registration-search',at:performance.now()});return [...issues.values()].filter(issue=>issue.body.startsWith(marker+'\n'));},
      async createIssue(title,body){
        events.push({event:'create-issue',at:performance.now()});
        const number=issues.size+1,issue={number,title,body,html_url:'https://github.com/'+this.repository+'/issues/'+number,labels:[]};
        issues.set(number,issue);return issue;
      },
      async getIssue(number){assert.ok(issues.has(number));return issues.get(number);}
    };
    try {
      store=new BugStore(dataDir,{initialize:true});seedWorker=new GitHubWorker(store,client);
      const actor=store.sharedActor();
      for(let i=1;i<=count;i++){
        const report=store.createReport(actor,{body:('架空の予約一覧 '+i+'\n').padEnd(2048,'予約表示の検証。'),reportedVersion:'QA',requestId:'refresh-seed-'+i,uploadIds:[]});
        const issue={number:i,html_url:'https://github.com/'+client.repository+'/issues/'+i,body:seedWorker.marker(report.id)+'\nfixture',labels:[]};
        issues.set(i,issue);seedWorker.link(report.id,issue);seedWorker.saveLabels(report.id,[]);
      }
      await seedWorker.stop();seedWorker=null;store.close();store=null;
      server=createProgressServer({repositories:[],dataDir,githubRepository:client.repository,githubClient:client});
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      const base='http://127.0.0.1:'+server.address().port;
      const get=async route=>{const response=await fetch(base+'/api/bugs/'+route);assert.equal(response.status,200);return response.json();};
      const post=async(route,body,status=200)=>{const response=await fetch(base+'/api/bugs/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,status);return response.json();};
      const http=[];
      for(let i=0;i<23;i++){
        const start=performance.now();assert.equal((await get('reports')).reports.length,count);
        if(i>=3)http.push(performance.now()-start);
      }
      context=await browser.newContext({viewport:{width:1280,height:900}});
      const page=await context.newPage();page.on('pageerror',error=>result.errors.push(error.message));
      const initial=[];
      for(let i=0;i<8;i++){
        const start=performance.now();await page.goto(base+'/bugs/');
        await page.waitForFunction(n=>document.querySelectorAll('.report-row').length===n,count);
        if(i>=2)initial.push(performance.now()-start);
      }
      await page.locator('#search').fill('予約');
      await page.waitForResponse(response=>new URL(response.url()).pathname==='/api/bugs/reports/search');
      const refresh=[],stages=[];
      for(let i=0;i<8;i++){
        await page.evaluate(()=>performance.clearResourceTimings());
        const done=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/bugs/reports/search');
        const start=performance.now();await page.locator('#refresh').click();assert.equal((await done).status(),200);
        await page.waitForFunction(n=>!document.querySelector('#refresh').disabled&&document.querySelectorAll('.report-row').length===n,count);
        const elapsed=performance.now()-start;
        const trace=await page.evaluate(()=>performance.getEntriesByType('resource').filter(item=>item.name.includes('/api/bugs/')).map(item=>({route:new URL(item.name).pathname,startMs:item.startTime,endMs:item.responseEnd,durationMs:item.duration})));
        assert.deepEqual(trace.map(item=>item.route),['/api/bugs/github/tags','/api/bugs/reports','/api/bugs/tag-roles','/api/bugs/reports/search']);
        if(i>=2){refresh.push(elapsed);stages.push(trace.map(item=>({...item,startMs:item.startMs-trace[0].startMs,endMs:item.endMs-trace[0].startMs})));}
      }
      await context.close();context=null;
      gate=deferred();listStarted=deferred();
      const updating=post('github/tags',{});await listStarted.promise;
      const saveStart=performance.now();
      const {report}=await post('reports',{body:'架空の予約報告：更新中の登録確認',reportedVersion:'QA',requestId:'during-refresh-'+count,uploadIds:[]},201);
      const saveEnd=performance.now();
      await delay(2000);
      const beforeRelease=(await get('reports/'+report.id)).report.github.state;
      const createdBeforeRelease=events.some(event=>event.event==='create-issue');
      const releasedAt=performance.now();gate.resolve();await updating;
      const deadline=performance.now()+10000;
      while((await get('reports/'+report.id)).report.github.state!=='registered'){
        assert.ok(performance.now()<deadline,'registration did not finish after releasing the list');await delay(20);
      }
      const createdAt=events.find(event=>event.event==='create-issue')?.at;
      assert.equal(beforeRelease,'pending');assert.equal(createdBeforeRelease,false);assert.ok(createdAt>=releasedAt);
      const condition={count,bodyLengthCharacters:2048,listHttp:summarize(http),initialPage:summarize(initial),refreshWithSearch:summarize(refresh),refreshRequestStages:stages,registrationDuringRefresh:{saveMs:saveEnd-saveStart,heldAfterSaveMs:releasedAt-saveEnd,stateBeforeRelease:beforeRelease,createdBeforeRelease,createAfterSaveMs:createdAt-saveEnd,createAfterReleaseMs:createdAt-releasedAt,events:events.map(event=>({event:event.event,msFromSave:event.at-saveStart}))}};
      result.conditions.push(condition);console.log(JSON.stringify({count,listP50:condition.listHttp.p50Ms,pageP50:condition.initialPage.p50Ms,refreshP50:condition.refreshWithSearch.p50Ms,registration:condition.registrationDuringRefresh}));
    } finally {
      gate?.resolve();await context?.close();await seedWorker?.stop();store?.close();
      if(server){await new Promise(resolve=>server.close(resolve));await server.bugClosed;}
      const relative=path.relative(tmpdir(),dataDir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(dataDir,{recursive:true,force:true});
    }
  }
  assert.deepEqual(result.errors,[]);await writeFile(path.join(artifactDir,'summary.json'),JSON.stringify(result,null,2)+'\n');
} finally {await browser.close();}
