// Optional Chromium QA using fictional booking reports and a simulated GitHub client.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {BugStore} from '../server/bug-store.mjs';
import {createProgressServer} from '../server.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const dataDir=await mkdtemp(path.join(tmpdir(),'github-board-bug-qa-'));
const artifacts=path.resolve(process.env.QA_ARTIFACT_DIR||'references/bug-reporting-qa');
await mkdir(artifacts,{recursive:true});
const init=new BugStore(dataDir,{initialize:true});init.sharedActor();init.close();
const repository='qa-fixture/booking-reports';
const github={repository,posts:[],issues:[],
  async createIssue(title,body){const number=101+this.issues.length;const issue={number,title,body,html_url:'https://github.com/'+repository+'/issues/'+number,labels:[{id:7,name:'予約画面',color:'336699'}]};this.posts.push({title,body});this.issues.push(issue);return issue;},
  async getIssue(number){return this.issues.find(issue=>issue.number===number);},
  async findIssues(marker){return this.issues.filter(issue=>issue.body.startsWith(marker+'\n'));}
};
let server,base,browser;
const errors=[],checks=[];
async function start(client){server=createProgressServer({repositories:[],dataDir,githubRepository:client?.repository||'',githubClient:client});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;}
async function stop(){if(server){await new Promise(resolve=>server.close(resolve));await server.bugClosed;server=null;}}
const capture=async(page,name)=>page.screenshot({path:path.join(artifacts,name),fullPage:true,animations:'disabled'});
const read=async id=>(await(await fetch(base+'/api/bugs/reports/'+id)).json()).report;
try {
  await start();
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  const page=await context.newPage();await page.goto(base);
  await page.locator('.workspace-empty').waitFor();
  assert.equal(await page.locator('#bug-reporting-link').isVisible(),true);
  await page.locator('#bug-reporting-link').click();await page.waitForFunction(()=>!document.querySelector('#new-report').disabled);
  assert.equal(await page.locator('#person').textContent(),'共通の利用者');
  await capture(page,'01-empty.png');
  checks.push('進捗画面から共通の利用者として報告画面を開く');
  const body='予約表で日付を選ぶと一覧が更新されない\n架空の予約管理アプリで、次の日付を選んでも前の一覧が残る。';
  const csv=Buffer.from('booking,date\nfictional-1,2030-01-02\n');
  await page.locator('#new-report').click();
  await page.locator('[name=body]').fill(body);await page.locator('[name=reportedVersion]').fill('QA-1');
  await page.locator('[name=files]').setInputFiles({name:'fictional-booking.csv',mimeType:'text/csv',buffer:csv});
  await page.locator('#submit-report').click();await page.locator('#report-dialog').waitFor({state:'hidden'});
  await page.locator('#detail h2').waitFor();
  const id=new URL(page.url()).searchParams.get('report');assert.ok(id);
  let report=await read(id);assert.equal(report.body,body);assert.equal(report.attachmentCount,1);assert.equal(report.github.repository,null);
  assert.equal(await page.getByRole('button',{name:'GitHubに登録',exact:true}).count(),0);
  await capture(page,'02-saved-report.png');
  checks.push('未設定のGitHubへ送らず本文と再現データを保存する');
  const downloadEvent=page.waitForEvent('download');await page.getByRole('link',{name:'fictional-booking.csv',exact:true}).click();
  const download=await downloadEvent;const stream=await download.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks),csv);
  await page.locator('#detail input[type=file]').setInputFiles({name:'fictional-steps.txt',mimeType:'text/plain',buffer:Buffer.from('Select the next date.\n')});
  await page.getByRole('button',{name:'データを追加',exact:true}).click();await page.getByRole('link',{name:'fictional-steps.txt',exact:true}).waitFor();
  report=await read(id);assert.equal(report.attachmentCount,2);
  checks.push('添付を取得し、受付後のデータ追加を保持する');
  const mobileContext=await browser.newContext({viewport:{width:390,height:844}});const mobile=await mobileContext.newPage();
  await mobile.goto(base+'/bugs/?report='+id);await mobile.locator('#detail h2').waitFor();
  assert.equal(await mobile.locator('#detail h2').textContent(),body.split('\n')[0]);
  await capture(mobile,'03-mobile-detail.png');await mobile.getByRole('button',{name:'← 報告一覧へ',exact:true}).click();
  await mobile.locator('.report-row').click();await mobile.locator('#detail.mobile-open').waitFor();
  await mobileContext.close();checks.push('別のブラウザでも保存済み報告を開き、狭い画面で一覧へ戻る');
  await stop();await start(github);await page.goto(base+'/bugs/?report='+id);await page.getByRole('button',{name:'GitHubに登録',exact:true}).waitFor();
  assert.equal(github.posts.length,0);await page.getByRole('button',{name:'GitHubに登録',exact:true}).click();
  await page.getByRole('link',{name:'#101 · GitHubで開く',exact:true}).waitFor({timeout:15000});
  assert.equal(github.posts.length,1);assert.ok(github.posts[0].body.startsWith('<!-- github-progress-board-report:'));
  assert.equal((await read(id)).github.repository,repository);await capture(page,'04-github-registered.png');
  checks.push('接続前の報告は明示操作で一度だけ登録し、取得したタグを表示する');
  async function advance(name,status){await page.getByRole('button',{name,exact:true}).click();await page.locator('#detail > .workflow-'+status).waitFor();}
  await advance('対応を始める','working');await page.locator('[name=targetVersion]').fill('QA-2');
  await advance('修正済み・公開待ちにする','fixed');await advance('公開してテスターへ確認を依頼する','checking');
  await capture(page,'05-confirmation.png');
  async function confirm(version,result,status){await page.locator('[name=version]').fill(version);await page.locator('[name=result]').selectOption(result);await page.getByRole('button',{name:'確認結果を送る',exact:true}).click();await page.locator('#notice').filter({hasText:version==='QA-0'?'対象と異なる':'まだ起きる'}).waitFor();assert.equal((await read(id)).status,status);}
  await confirm('QA-0','resolved','checking');await confirm('QA-2','unresolved','working');
  await advance('修正済み・公開待ちにする','fixed');await advance('公開してテスターへ確認を依頼する','checking');
  await page.locator('[name=version]').fill('QA-2');await page.locator('[name=result]').selectOption('resolved');await page.getByRole('button',{name:'確認結果を送る',exact:true}).click();await page.locator('#detail > .workflow-complete').waitFor();
  report=await read(id);assert.equal(report.history.length,8);assert.equal(github.posts.length,1);await capture(page,'06-complete.png');
  checks.push('異なる版の確認は状態を保ち、未解消は対応中へ戻し、対象版の解消で完了する');
  await stop();await start(github);await page.goto(base+'/bugs/?report='+id);await page.locator('#detail > .workflow-complete').waitFor();
  report=await read(id);assert.equal(report.history.length,8);assert.equal(report.attachmentCount,2);assert.equal(github.posts.length,1);
  checks.push('再起動後も確認履歴・添付・Issueの関連付けを保持する');
  assert.deepEqual(errors,[]);await writeFile(path.join(artifacts,'summary.json'),JSON.stringify({checks,errors},null,2));
  console.log(JSON.stringify({checks:checks.length,errors,artifacts},null,2));
} finally {
  await browser?.close();await stop();
  const relative=path.relative(tmpdir(),dataDir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(dataDir,{recursive:true,force:true});
}
