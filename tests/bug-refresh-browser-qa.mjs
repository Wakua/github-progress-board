// タグ取得を保留し、同じ架空の予約管理データ・操作で変更前後を確かめる。
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const codeDir=path.resolve(process.env.QA_PRODUCT_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const expected=process.env.QA_EXPECT_REGISTRATION||'unblocked';
assert.ok(['waiting','unblocked'].includes(expected));
const prefix=expected==='waiting'?'before':'after';
const artifacts=path.resolve(process.env.QA_ARTIFACT_DIR||'references/bug-refresh-browser');
const dataDir=await mkdtemp(path.join(tmpdir(),'bug-refresh-screen-'));
await mkdir(artifacts,{recursive:true});
const args=process.argv;
let fixture,browser,context,release;
const errors=[],checks=[];
try {
  // 画面用fixtureのCLIと同じ入口を使い、ポート0で空きポートを割り当てる。
  process.argv=[args[0],fileURLToPath(new URL('./bug-screens-server.mjs',import.meta.url)),dataDir,'0',codeDir];
  fixture=await import('./bug-screens-server.mjs');process.argv=args;
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined});
  context=await browser.newContext({viewport:{width:800,height:900}});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(fixture.origin+'/bugs/');await page.locator('.report-row').first().waitFor();
  const list=fixture.github.listIssues.bind(fixture.github);
  let enter;const entered=new Promise(resolve=>{enter=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  fixture.github.listIssues=async()=>{const rows=await list();enter();await held;return rows;};
  const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/bugs/github/tags');
  await page.locator('#refresh').focus();await page.keyboard.press('Enter');await entered;
  assert.equal(await page.locator('#refresh').isDisabled(),true);
  await page.locator('#new-report').focus();await page.keyboard.press('Enter');
  await page.locator('[name=body]').fill('予約一覧の更新中に保存した報告\n架空の予約管理アプリで、次の日付を選んでも前の一覧が残る。');
  await page.locator('[name=reportedVersion]').fill('S-2');
  const saved=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/bugs/reports');
  await page.locator('#submit-report').focus();await page.keyboard.press('Enter');
  const {report}=await(await saved).json();
  await page.locator('#report-dialog').waitFor({state:'hidden'});
  // 登録は1秒ごと、画面の登録状態は5秒ごとに確認する既存の動作を待つ。
  await delay(6000);
  const read=async()=>(await(await fetch(fixture.origin+'/api/bugs/reports/'+report.id)).json()).report;
  const state=(await read()).github.state;
  assert.equal(state,expected==='waiting'?'pending':'registered');
  assert.match(await page.locator('#github-status').textContent(),expected==='waiting'?/GitHub登録待ち/:/GitHub登録済み/);
  assert.equal(await page.locator('#refresh').isDisabled(),true);
  await page.screenshot({path:path.join(artifacts,prefix+'-01-registration.jpg'),type:'jpeg',quality:60,fullPage:false});
  checks.push('タグ一覧の応答を保留したまま、キーボードで報告を作り、6秒後の登録状態をAPIと画面で照合した: '+state);
  await page.setViewportSize({width:390,height:844});
  await page.locator('#github-status').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#github-status').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(artifacts,prefix+'-02-mobile-registration.jpg'),type:'jpeg',quality:60,fullPage:false});
  checks.push('幅390pxで登録状態を表示し、横方向のはみ出しがないことを確認した');
  release();assert.equal((await refreshed).status(),200);
  await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
  fixture.github.listIssues=list;
  // 一覧取得の失敗後も受付は続き、次の更新で成功状態へ戻せる。
  fixture.github.listIssues=async()=>{throw new Error('fictional list failure');};
  await page.locator('#refresh').click();await page.locator('#notice.error').waitFor();
  assert.match(await page.locator('#notice').textContent(),/タグを取得できなかった/);
  assert.equal(await page.locator('#new-report').isEnabled(),true);
  fixture.github.listIssues=list;
  await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
  assert.equal(await page.locator('#notice.error').count(),0);
  checks.push('取得失敗の通知と報告の入口を確認し、再更新で成功へ戻った');
  await page.getByRole('button',{name:'← 報告一覧へ',exact:true}).focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('.list').isVisible(),true);
  assert.match(await page.locator('.report-row.active').textContent(),/予約一覧の更新中に保存した報告/);
  await page.locator('.report-row.active').focus();await page.keyboard.press('Enter');
  await page.locator('#detail.mobile-open').waitFor();
  checks.push('キーボードで詳細から一覧へ戻り、同じ行の選択を確認し、行へフォーカスして詳細を再び開いた（自動フォーカス復元は未対応）');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(artifacts,prefix+'-summary.json'),JSON.stringify({at:new Date().toISOString(),productCommit:execFileSync('git',['-C',codeDir,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),expected,state,checks,errors},null,2)+'\n');
  console.log(JSON.stringify({expected,checks,errors}));
} finally {
  process.argv=args;release?.();await context?.close();await browser?.close();
  if(fixture){await new Promise(resolve=>fixture.server.close(resolve));await fixture.server.bugClosed;}
  const relative=path.relative(tmpdir(),dataDir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  await rm(dataDir,{recursive:true,force:true});
}
