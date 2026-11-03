// #66: 架空の予約管理データで、更新失敗 → 抽出 → 詳細 → 再取得を確認する。
// QA_PRODUCT_ROOTで比較元、QA_EXPECT_FILTER=absentで変更前を撮影する。
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=path.resolve(process.env.QA_PRODUCT_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const artifacts=path.resolve(process.env.QA_ARTIFACT_DIR||'artifacts/bug-tag-failures');
const before=process.env.QA_EXPECT_FILTER==='absent',prefix=before?'before':'after';
const data=await mkdtemp(path.join(tmpdir(),'bug-tag-failures-')),args=[...process.argv];
const checks=[],errors=[];let fixture,browser,context;
await mkdir(artifacts,{recursive:true});
try {
  process.argv=[args[0],args[1],data,'0',root];
  fixture=await import('./bug-screens-server.mjs');process.argv=args;
  const list=fixture.github.listIssues.bind(fixture.github),get=fixture.github.getIssue.bind(fixture.github);
  const failures=[101,107];
  fixture.github.listIssues=async()=>{const rows=await list();for(const number of failures)rows.delete(number);return rows;};
  fixture.github.getIssue=async number=>{if(failures.includes(number))throw Error('fictional tag failure');return get(number);};
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined});
  context=await browser.newContext({viewport:{width:800,height:900}});
  context.setDefaultTimeout(10000);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(fixture.origin+'/bugs/');await page.locator('.report-row').first().waitFor();
  const update=async()=>{await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);};
  await update();
  const reports=(await(await fetch(fixture.origin+'/api/bugs/reports')).json()).reports;
  const failed=reports.filter(report=>report.github.tags.state==='error');
  assert.deepEqual(failed.map(report=>report.github.number).sort((a,b)=>a-b),failures);
  assert.match(await page.locator('#notice').textContent(),/2件/);
  assert.equal(await page.locator('.report-row').count(),19);
  const shot=async name=>page.screenshot({path:path.join(artifacts,prefix+'-'+name+'.jpg'),type:'jpeg',quality:60});
  await shot('01-notice');
  await page.setViewportSize({width:390,height:844});await shot('03-mobile-notice');
  checks.push('幅800/390pxで同じ2件の取得失敗を再現し、通知と全19件の一覧を撮影');
  if(before) {
    assert.equal(await page.locator('[data-filter=tags]').count(),0);
    checks.push('変更前にはタグ取得状況の絞り込みがない');
  } else {
    const chooseFailures=async()=>{
      await page.locator('[data-filter=tags] summary').press('Enter');
      await page.getByRole('checkbox',{name:'取得失敗',exact:true}).press('Space');
      await page.getByRole('checkbox',{name:'取得失敗',exact:true}).press('Escape');
      assert.equal(await page.locator('[data-filter=tags] summary').evaluate(node=>node===document.activeElement),true);
    };
    const rowNumbers=async()=>page.locator('.report-row .report-number').allTextContents();
    const overflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await chooseFailures();await overflow();
    assert.deepEqual((await rowNumbers()).sort(),['#101','#107']);
    assert.equal(await page.locator('#report-count').textContent(),'2 / 19件');
    assert.equal(await page.locator('.report-row .status-failed').count(),2);
    await shot('04-mobile-filtered');
    checks.push('幅390pxでキーボードにより取得失敗を選び、Escapeでメニューを閉じ、フォーカスと通知に一致する2件を確認');
    await page.locator('.report-row').filter({hasText:'#107'}).press('Enter');
    await page.locator('#detail.mobile-open').waitFor();
    assert.match(await page.locator('#detail').textContent(),/タグ取得失敗 · 前回の取得結果/);
    assert.match(await page.locator('.report-row.active .report-area').textContent(),/通知 \/ 画面/);
    await page.getByRole('button',{name:'← 報告一覧へ',exact:true}).press('Enter');
    assert.equal(await page.locator('.report-row').count(),2);
    assert.match(await page.locator('.report-row.active').textContent(),/#107/);
    checks.push('詳細で前回のタグと取得失敗を確認し、一覧へ戻って選択と絞り込みを維持（既存の自動フォーカス復元は対象外）');
    await page.setViewportSize({width:800,height:900});await overflow();
    await page.locator('#list-heading').scrollIntoViewIfNeeded();await shot('02-filtered');
    await page.locator('#search').fill('予約一覧');
    await page.waitForFunction(()=>document.querySelector('#report-count').textContent==='1 / 19件');
    assert.deepEqual(await rowNumbers(),['#101']);
    await page.locator('#search').fill('');
    await page.waitForFunction(()=>document.querySelector('#report-count').textContent==='2 / 19件');
    await page.locator('[data-filter=main] summary').click();
    await page.locator('[data-filter=main] input[value="label:3"]').check();
    await page.locator('[data-filter=main] input[value="label:3"]').press('Escape');
    assert.deepEqual(await rowNumbers(),['#107']);
    await page.locator('[data-filter=main] summary').click();
    await page.locator('[data-filter=main] .filter-clear').click();
    await page.locator('[data-filter=main] summary').press('Escape');
    assert.equal(await page.locator('.report-row').count(),2);
    checks.push('本文検索とメインカテゴリを重ね、各条件だけを解除して取得失敗2件へ戻る');
    await page.locator('#view-board').click();
    assert.equal(await page.locator('.board-card').count(),2);
    assert.equal(await page.locator('.board-card .status-failed').count(),2);
    await page.locator('#view-list').click();
    checks.push('かんばんへの切替でも同じ2件と失敗の印を表示');
    await page.reload();await page.waitForFunction(()=>document.querySelector('#report-count').textContent==='19 / 19件');
    assert.equal(await page.locator('.report-row .status-failed').count(),2);
    await chooseFailures();
    fixture.github.listIssues=list;fixture.github.getIssue=get;
    await update();
    assert.equal(await page.locator('#report-count').textContent(),'0 / 19件');
    assert.match(await page.locator('#reports').textContent(),/条件に一致する報告はありません/);
    assert.equal(await page.locator('#notice.error').count(),0);
    await page.locator('[data-filter=tags] summary').click();
    await page.locator('[data-filter=tags] .filter-clear').click();
    assert.equal(await page.locator('.report-row').count(),19);
    assert.equal(await page.locator('.report-row .status-failed').count(),0);
    checks.push('再読込みで条件だけが解除され、保存された失敗は残る。再取得成功で0件となり、解除で全19件に戻る');
  }
  assert.deepEqual(errors,[]);
  const result={at:new Date().toISOString(),productCommit:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),checks,errors};
  await writeFile(path.join(artifacts,prefix+'-summary.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {
  process.argv=args;await context?.close();await browser?.close();
  if(fixture){await new Promise(resolve=>fixture.server.close(resolve));await fixture.server.bugClosed;}
  const relative=path.relative(tmpdir(),data);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  await rm(data,{recursive:true,force:true});
}
