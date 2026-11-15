import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setup} from './bug-repository-recovery-fixture.mjs';
import {fileURLToPath} from 'node:url';
const root=process.env.QA_PRODUCT_ROOT||fileURLToPath(new URL('..',import.meta.url)),artifacts=process.env.QA_ARTIFACT_DIR||'artifacts/bug-repository-recovery',before=process.env.QA_EXPECT_RECOVERY==='absent',prefix=before?'before':'after';
const checks=[],errors=[];let fx,browser;
await mkdir(artifacts,{recursive:true});
try {
 fx=await setup(root);
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined});
 const context=await browser.newContext({viewport:{width:800,height:900}});context.setDefaultTimeout(10000);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const open=async report=>{await page.goto(fx.origin+'/bugs/');await page.locator('.report-row').filter({hasText:report.title}).press('Enter');await page.locator('.github-panel').waitFor();};
 const shot=async name=>{await page.locator('.github-panel').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifacts,prefix+'-'+name+'.jpg'),type:'jpeg',quality:60});};
 const api=async(id,action)=>fetch(fx.origin+'/api/bugs/reports/'+id+'/github/'+action,{method:'POST',headers:{'Content-Type':'application/json',Origin:fx.origin},body:'{}'});
 const registration=id=>fx.server.bugStore.registration(id);
 assert.equal(registration(fx.pending.id).repository,fx.original.repository);assert.equal(fx.calls.length,0);
 checks.push('再起動後、旧接続先の登録待ちは自動付替え・GitHub呼出しなし');
 for(const width of [800,390]) {
  await page.setViewportSize({width,height:900});await open(fx.pending);
  assert.equal(await page.getByRole('button',{name:'GitHubに登録',exact:true}).count(),before?0:1);
  assert.match(await page.locator('.github-panel').textContent(),before?/登録先：qa-fixture\/booking-reports$/:/登録先：qa-fixture\/booking-reports-next（変更前：qa-fixture\/booking-reports）/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await shot(width===800?'01-pending':'03-mobile-pending');checks.push('幅'+width+'px：登録待ちの接続先・操作・横あふれなし');
 }
 await page.setViewportSize({width:800,height:900});await open(fx.unknown);
 if(before) {await page.getByRole('button',{name:'既存のIssueと照合',exact:true}).click();await page.getByText('保存されたGitHub接続先が一致しません。',{exact:true}).waitFor();}
 else {assert.equal(await page.getByRole('button',{name:'既存のIssueと照合',exact:true}).count(),0);assert.match(await page.locator('.github-panel').textContent(),/接続先をqa-fixture\/booking-reportsへ戻して照合してください。/);}
 await shot('02-unknown');checks.push('結果未確認：'+(before?'照合は接続先不一致で失敗':'元の接続先を示し、照合・再試行を出さない'));
 assert.equal((await api(fx.unknown.id,'register')).status,409);assert.equal((await api(fx.unknown.id,'reconcile')).status,409);
 assert.equal(fx.calls.length,0);checks.push('結果未確認のAPI操作を409で拒否し、GitHub呼出しなし');
 await page.setViewportSize({width:390,height:900});await open(fx.creating);
 assert.equal(registration(fx.creating.id).state,before?'creating':'unknown');
 assert.match(await page.locator('.github-panel').textContent(),before?/GitHub登録中/:/GitHub作成結果が未確認/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await shot('04-mobile-recovered');checks.push('幅390px：接続先変更・DB再読込み後の作成中は'+(before?'作成中に残る':'結果未確認へ復旧'));
 if(!before) {
  await open(fx.pending);await page.getByRole('button',{name:'GitHubに登録',exact:true}).press('Enter');
  await page.getByText('GitHub登録を受け付けました。',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.github-panel').textContent.includes('GitHub登録済み'));
  assert.equal(fx.calls.filter(c=>c.kind==='create').length,1);assert.equal(registration(fx.pending.id).repository,fx.github.repository);
  assert.match(await page.locator('.github-panel a').getAttribute('href'),/booking-reports-next\/issues\/201$/);
  checks.push('Enterによる手動登録だけで新しい接続先へ1件作成し、登録済み・Issueリンクを表示');
  await page.reload();await page.getByText('GitHub登録済み',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'GitHubに登録',exact:true}).count(),0);assert.equal(fx.calls.filter(c=>c.kind==='create').length,1);
  checks.push('再読込み後も登録済み・新しい接続先を保持し、再作成なし');
  await page.setViewportSize({width:800,height:900});await shot('05-registered');
  fx.origin=await fx.restart(fx.original);await open(fx.creating);
  await page.getByRole('button',{name:'既存のIssueと照合',exact:true}).press('Enter');
  await page.getByText('既存のIssueと関連付けました。',{exact:true}).waitFor();
  assert.equal(registration(fx.creating.id).number,fx.creating.github.number);assert.equal(registration(fx.creating.id).repository,fx.original.repository);
  assert.equal((await fx.original.listIssues()).size,18);checks.push('元の接続先へ戻した後、復旧した報告を既存のIssueへ照合し、元のIssue数18件を維持');
 }
 assert.deepEqual(errors,[]);checks.push('ブラウザ例外なし');
 await writeFile(path.join(artifacts,prefix+'-result.json'),JSON.stringify({date:new Date().toISOString(),root,browser:await browser.version(),before,checks},null,2)+'\n');
 console.log(JSON.stringify({checks:checks.length,before,artifacts}));
} finally {
 await browser?.close();await fx?.close();
 if(fx){const relative=path.relative(tmpdir(),fx.data);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(fx.data,{recursive:true,force:true});}
}
