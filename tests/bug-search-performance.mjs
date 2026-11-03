// Optional measurement using isolated fictional reports. No external GitHub client.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir,cpus,platform,release} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {BugStore} from '../server/bug-store.mjs';
import {createProgressServer} from '../server.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const artifactDir=path.resolve(process.env.QA_ARTIFACT_DIR||'references/bug-search-performance');
await mkdir(artifactDir,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined});
const summarize=samples=>{
  const sorted=[...samples].sort((a,b)=>a-b),round=n=>Math.round(n*100)/100,middle=Math.floor(sorted.length/2);
  const median=sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
  return {samples:samples.length,p50Ms:round(median),p95Ms:round(sorted[Math.ceil(sorted.length*.95)-1]),maxMs:round(sorted.at(-1)),samplesMs:samples};
};
const result={at:new Date().toISOString(),node:process.version,platform:platform()+' '+release(),cpu:cpus()[0].model,browser:await browser.version(),externalGitHub:false,conditions:[],errors:[]};
try {
  for(const [count,bodyLength] of [[50,2048],[250,2048],[500,2048],[500,16384]]) {
    const dataDir=await mkdtemp(path.join(tmpdir(),'bug-search-measure-'));
    let store,server,context;
    try {
      store=new BugStore(dataDir,{initialize:true});const actor=store.sharedActor();
      for(let i=0;i<count;i++){
        const suffix='\n'+(i%10===0?'検索対象 ':'通常対象 ')+'alpha beta gamma delta epsilon zeta eta theta iota kappa';
        const body=('架空の予約管理：一覧の表示を確認する '+i+'\n').padEnd(bodyLength-suffix.length,'予約表示の検証。')+suffix;
        assert.equal(body.length,bodyLength);
        store.createReport(actor,{body,reportedVersion:'QA',requestId:'measure-'+i,uploadIds:[]});
      }
      const queries=['検索対象','存在しない語','alpha beta gamma delta epsilon zeta eta theta iota kappa'];
      const condition={count,bodyLengthCharacters:bodyLength,storeSearch:[],httpSearch:[],reload:null};
      for(const query of queries){const samples=[];for(let i=0;i<33;i++){const start=performance.now();const ids=store.searchReports(query);if(i>=3)samples.push(performance.now()-start);assert.equal(ids.length,query==='検索対象'?count/10:query==='存在しない語'?0:count);}condition.storeSearch.push({query,...summarize(samples)});}
      store.close();store=null;
      server=createProgressServer({repositories:[],dataDir,githubRepository:''});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const base='http://127.0.0.1:'+server.address().port;
      for(const query of queries){const samples=[];for(let i=0;i<33;i++){const start=performance.now();const response=await fetch(base+'/api/bugs/reports/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query})});assert.equal(response.status,200);await response.json();if(i>=3)samples.push(performance.now()-start);}condition.httpSearch.push({query,...summarize(samples)});}
      context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage();page.on('pageerror',error=>result.errors.push(error.message));
      await page.goto(base+'/bugs/');await page.locator('.report-row').first().waitFor();
      await page.locator('#search').fill('検索対象');await page.waitForFunction(n=>document.querySelectorAll('.report-row').length===n,count/10);
      const samples=[],requests=[];
      page.on('request',request=>{if(new URL(request.url()).pathname==='/api/bugs/reports/search')requests.push(request.url());});
      for(let i=0;i<15;i++){
        const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/bugs/reports/search');
        const start=performance.now();await page.locator('#refresh').click();assert.equal((await response).status(),200);
        await page.waitForFunction(n=>!document.querySelector('#refresh').disabled&&document.querySelectorAll('.report-row').length===n,count/10);
        if(i>=3)samples.push(performance.now()-start);
      }
      assert.equal(requests.length,15);condition.reload={...summarize(samples),searchRequests:requests.length,refreshClicks:15};
      await context.close();context=null;
      result.conditions.push(condition);console.log(JSON.stringify(condition));
    } finally {
      await context?.close();store?.close();
      if(server){await new Promise(resolve=>server.close(resolve));await server.bugClosed;}
      const relative=path.relative(tmpdir(),dataDir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(dataDir,{recursive:true,force:true});
    }
  }
  assert.deepEqual(result.errors,[]);await writeFile(path.join(artifactDir,'summary.json'),JSON.stringify(result,null,2)+'\n');
} finally {await browser.close();}
