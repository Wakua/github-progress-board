// #120: 同じ架空の報告で、一覧の下部 → 詳細 → 一覧の位置と操作を確認する。
// QA_EXPECT_NAVIGATION=previous と QA_PRODUCT_ROOT=<main> で変更前を撮影する。
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=path.resolve(process.env.QA_PRODUCT_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const previous=process.env.QA_EXPECT_NAVIGATION==='previous',prefix=previous?'before':'after';
const artifacts=path.resolve(process.env.QA_ARTIFACT_DIR||'references/bug-navigation-qa');
const data=await mkdtemp(path.join(tmpdir(),'bug-navigation-')),args=[...process.argv],checks=[],errors=[],positions=[];
let fixture,browser,context;
await mkdir(artifacts,{recursive:true});
try {
  process.argv=[args[0],args[1],data,'0',root];fixture=await import('./bug-screens-server.mjs');process.argv=args;
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined});
  context=await browser.newContext();context.setDefaultTimeout(10000);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const back=()=>page.getByRole('button',{name:'← 報告一覧へ',exact:true});
  const focused=locator=>locator.evaluate(node=>node===document.activeElement);
  const location=()=>page.evaluate(()=>({x:scrollX,y:scrollY,boardX:document.querySelector('.board')?.scrollLeft??0}));
  const screenshot=name=>page.screenshot({path:path.join(artifacts,prefix+'-'+name+'.jpg'),type:'jpeg',quality:60});
  for(const width of [1100,800,390]) {
    await page.setViewportSize({width,height:width===390?844:700});
    await page.goto(fixture.origin+'/bugs/');await page.locator('.report-row').first().waitFor();
    const searched=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/bugs/reports/search');
    await page.locator('#search').fill('架空');await(await searched).finished();
    await page.locator('[data-filter=status] summary').click();
    await page.getByRole('checkbox',{name:'確認完了を除く',exact:true}).check();
    await page.getByRole('checkbox',{name:'確認完了を除く',exact:true}).press('Escape');
    await page.waitForFunction(()=>document.querySelector('#report-count').textContent==='17 / 19件');
    const row=page.locator('.report-row').filter({hasText:'#101'});
    await row.scrollIntoViewIfNeeded();await row.focus();
    const start=await location();assert.ok(start.y>0,'一覧下部から開始する');
    if(width===800)await screenshot('01-list-bottom');
    await row.press('Enter');await page.locator('#detail h2').filter({hasText:'予約一覧が更新されない'}).waitFor();
    if(width===800)await screenshot('02-detail');
    if(width===390)await screenshot('03-mobile-detail');
    if(previous&&width>760) {
      assert.equal(await page.locator('.list').isVisible(),true);
      assert.equal(await back().isVisible(),false);
      checks.push('変更前・幅'+width+'pxは一覧と詳細を併記し、一覧へ戻るボタンを表示しない');
      continue;
    }
    assert.equal(await page.locator('.list').isVisible(),false);
    assert.equal(await back().isVisible(),true);
    const detailTop=await back().evaluate(node=>node.getBoundingClientRect().top);
    assert.ok(detailTop>=0&&detailTop<180,'詳細の先頭が画面内にある');
    if(!previous)assert.equal(await focused(back()),true,'詳細へフォーカスを移す');
    await back().press('Enter');
    assert.equal(await page.locator('.list').isVisible(),true);
    const restored=await location();
    positions.push({width,start,restored,focused:await focused(page.locator('.report-row.active'))});
    if(width===390)await screenshot('04-mobile-return');
    if(!previous) {
      assert.ok(Math.abs(start.y-restored.y)<=1,'一覧の位置を復元する');
      assert.equal(await focused(page.locator('.report-row.active')),true);
      assert.equal(new URL(page.url()).searchParams.has('report'),false);
      assert.equal(await page.locator('#search').inputValue(),'架空');
      assert.equal(await page.locator('[data-filter=status] input[value=incomplete]').isChecked(),true);
      await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
      assert.equal(await page.locator('#detail').isVisible(),false,'一覧で更新しても詳細を開き直さない');
      assert.equal(new URL(page.url()).searchParams.has('report'),false);
      checks.push('幅'+width+'pxで詳細先頭・フォーカス移動、一覧の位置・検索・絞り込み・行のフォーカスを復元し、更新後も一覧を維持');
    } else checks.push('変更前・幅390pxの詳細と戻った一覧を撮影し、復元位置とフォーカスを記録');
  }
  if(!previous) {
    for(const width of [1100,390]) {
      await page.setViewportSize({width,height:700});await page.goto(fixture.origin+'/bugs/');
      await page.locator('.report-row').first().waitFor();await page.locator('#view-board').click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'かんばんはページ全体を横にはみ出させない');
      const card=page.locator('.board-card').filter({hasText:'#103'});
      await card.scrollIntoViewIfNeeded();await card.focus();const start=await location();
      await card.press('Enter');await back().waitFor();
      assert.equal(await focused(back()),true);await back().press('Enter');
      const restored=await location();
      assert.ok(Math.abs(start.y-restored.y)<=1);assert.ok(Math.abs(start.boardX-restored.boardX)<=1);
      assert.equal(await focused(page.locator('.board-card.active')),true);
      positions.push({width,mode:'board',start,restored});
      await page.locator('#view-list').click();
      checks.push('幅'+width+'pxのかんばんで、元の札・ページ位置・横スクロール位置を復元');
    }
    await page.goto(fixture.origin+'/bugs/');await page.locator('.report-row').first().waitFor();
    // 最初の詳細取得の失敗後も一覧を維持し、同じ行から再試行できる。
    let fail=true;
    await page.route('**/api/bugs/reports/*',async route=>{
      if(fail&&route.request().method()==='GET'){fail=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'架空の読込失敗'})});}
      else await route.continue();
    });
    const first=page.locator('.report-row').first();await first.click();await page.locator('#notice.error').waitFor();
    assert.equal(await page.locator('.list').isVisible(),true);
    await first.click();await back().waitFor();await page.unroute('**/api/bugs/reports/*');
    const deepUrl=page.url();await page.reload();await back().waitFor();
    assert.equal(await page.locator('.list').isVisible(),false);await back().press('Enter');
    await page.reload();await page.locator('.report-row').first().waitFor();
    assert.equal(await page.locator('#detail').isVisible(),false);
    checks.push('詳細取得の失敗から再試行し、詳細URLの再読込みと、一覧へ戻った後の再読込みを確認');
    // 詳細の更新を待つ間に戻っても、遅い応答で再び詳細を開かない。
    await page.goto(deepUrl);await back().waitFor();
    let release,entered;const held=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{entered=resolve;});
    await page.route('**/api/bugs/reports/*',async route=>{entered();await held;await route.continue();});
    await page.locator('#refresh').click();await Promise.race([requested,new Promise((_,reject)=>setTimeout(()=>reject(Error('詳細更新が始まらない')),10000))]);await back().click();release();
    await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
    assert.equal(await page.locator('.list').isVisible(),true);assert.equal(await page.locator('#detail').isVisible(),false);
    assert.equal(new URL(page.url()).searchParams.has('report'),false);
    await page.unroute('**/api/bugs/reports/*');
    checks.push('詳細の再読込中に戻ると、遅い応答が来ても一覧とURLを維持');
    await page.goto(fixture.origin+'/bugs/');await page.locator('.report-row').first().waitFor();
    await page.locator('[data-filter=status] summary').click();
    await page.locator('[data-filter=status] input[value=working]').check();
    await page.locator('[data-filter=status] input[value=working]').press('Escape');
    await page.locator('.report-row').filter({hasText:'#101'}).click();await back().waitFor();
    await page.getByRole('button',{name:'修正済み・公開待ちにする',exact:true}).click();
    await page.locator('#detail > .workflow-fixed').waitFor();await back().click();
    assert.equal(await page.locator('.report-row.active').count(),0);
    assert.equal(await focused(page.locator('#list-heading')),true);
    assert.equal(await page.locator('#list-heading').evaluate(node=>{const rect=node.getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight;}),true);
    assert.equal(await page.locator('[data-filter=status] input[value=working]').isChecked(),true);
    checks.push('詳細で対応状況を進めて絞り込みから外れた報告は、一覧の見出しを画面内に表示してフォーカスを戻す');
  }
  assert.deepEqual(errors,[]);
  const result={at:new Date().toISOString(),productCommit:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),checks,positions,errors};
  await writeFile(path.join(artifacts,prefix+'-summary.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} finally {
  process.argv=args;await context?.close();await browser?.close();
  if(fixture){await new Promise(resolve=>fixture.server.close(resolve));await fixture.server.bugClosed;}
  const relative=path.relative(tmpdir(),data);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  await rm(data,{recursive:true,force:true});
}
