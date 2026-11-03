// #63: 同じ架空データで、題名の各行・2行の上限・状態と詳細の幅を測る。
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=path.resolve(process.env.QA_PRODUCT_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const previous=process.env.QA_EXPECT_WRAP==='previous',prefix=previous?'before':'after';
const artifacts=path.resolve(process.env.QA_ARTIFACT_DIR||'references/bug-title-wrap');
const data=await mkdtemp(path.join(tmpdir(),'bug-title-wrap-')),args=[...process.argv],checks=[],errors=[],measurements=[];
const oldFixtureOption=process.env.QA_TITLE_WRAPPING;
let fixture,browser,context;
await mkdir(artifacts,{recursive:true});
try {
  process.env.QA_TITLE_WRAPPING='1';process.argv=[args[0],args[1],data,'0',root];
  fixture=await import('./bug-screens-server.mjs');process.argv=args;
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined});
  context=await browser.newContext();context.setDefaultTimeout(10000);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const shot=name=>page.screenshot({path:path.join(artifacts,prefix+'-'+name+'.jpg'),type:'jpeg',quality:60});
  const title=fixture.titleWrappingCases[0],row=()=>page.locator('.report-row').filter({has:page.getByText(title,{exact:true})});
  const metrics=()=>page.locator('.report-row .report-title').evaluateAll(nodes=>nodes.map(node=>{
    const text=node.textContent,rect=node.getBoundingClientRect(),lines=new Map();
    for(let index=0;index<text.length;index++) {
      const range=document.createRange();range.setStart(node.firstChild,index);range.setEnd(node.firstChild,index+1);
      const char=range.getBoundingClientRect(),key=Math.round(char.top);
      lines.set(key,(lines.get(key)||'')+text[index]);
    }
    return {text,lines:[...lines.values()],height:rect.height,lineHeight:parseFloat(getComputedStyle(node).lineHeight),width:rect.width};
  }));
  for(const width of [800,761,999,390,320,1100]) {
    await page.setViewportSize({width,height:900});await page.goto(fixture.origin+'/bugs/');
    await page.waitForFunction(()=>document.querySelector('#report-count').textContent==='23 / 23件');
    const rows=await metrics();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    for(const item of rows)assert.ok(item.height<=item.lineHeight*2+1,'題名は2行を超えない: '+item.text);
    const target=rows.find(item=>item.text===title);assert.ok(target);
    measurements.push({width,titleCount:rows.length,titles:rows.filter(item=>fixture.titleWrappingCases.includes(item.text)||item.text==='会員登録の確認画面で電話番号が消える')});
    if(!previous)for(const item of rows.filter(item=>item.lines.length===2))assert.ok(item.lines.at(-1).trim().length>1,'末尾1文字だけを2行目にしない: '+item.text);
    if(width===800) {
      assert.equal(rows.find(item=>item.text==='会員登録の確認画面で電話番号が消える').lines.length,1,'元の例は#120の一覧幅で1行に収まる');
      assert.equal(target.lines.length,2);
      if(previous)assert.equal(target.lines[1],'る','変更前の末尾1文字を同じ題名で再現');
      else assert.ok(Math.abs(target.lines[0].length-target.lines[1].length)<10);
      await page.locator('#search').fill('会員登録');
      await page.waitForFunction(()=>document.querySelector('#report-count').textContent==='2 / 23件');
      await shot('01-list');
      await row().press('Enter');await page.locator('#detail h2').waitFor();
      const detail=await page.locator('#detail').boundingBox();measurements.push({width,detailWidth:detail.width});
      assert.ok(detail.width>=700,'#120後の詳細の幅を保つ');
      assert.equal(await page.locator('#detail h2').textContent(),title);
      await shot('02-detail');
      await page.getByRole('button',{name:'← 報告一覧へ',exact:true}).press('Enter');
      assert.equal(await row().evaluate(node=>node===document.activeElement),true);
      assert.equal(await page.locator('#search').inputValue(),'会員登録');
      assert.equal(await page.locator('.report-row').count(),2);
      checks.push('幅800pxで元の題名と再現用の長い題名を確認し、詳細の幅・題名全文・検索・フォーカスを保持');
    }
    if(width===390){await page.locator('#search').fill('会員登録');await page.waitForFunction(()=>document.querySelector('#report-count').textContent==='2 / 23件');await shot('03-mobile-list');}
    checks.push('幅'+width+'pxで日本語・英文・空白のない英数字を表示し、2行の上限と横はみ出しなしを確認'+(previous?'':'、2行に収まる題名に末尾1文字の行なし'));
  }
  // フィルターの状態や、かんばんの題名・カード幅は今回の指定の影響を受けない。
  await page.setViewportSize({width:800,height:900});await page.goto(fixture.origin+'/bugs/');await page.locator('.report-row').first().waitFor();
  await page.locator('[data-filter=main] summary').click();
  await page.locator('[data-filter=main] input[value="label:1"]').check();
  await page.locator('[data-filter=main] input[value="label:1"]').press('Escape');
  const filtered=await page.locator('.report-row').count();assert.ok(filtered>4&&filtered<23);
  await row().press('Enter');await page.locator('#detail h2').waitFor();
  await page.getByRole('button',{name:'← 報告一覧へ',exact:true}).press('Enter');
  assert.equal(await page.locator('.report-row').count(),filtered);
  assert.equal(await page.locator('[data-filter=main] input[value="label:1"]').isChecked(),true);
  await page.locator('#view-board').click();
  assert.equal(await page.locator('.board-card .report-title').first().evaluate(node=>getComputedStyle(node).textWrapStyle),'auto');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  checks.push('カテゴリ絞り込み後の往復を保ち、かんばんの題名の折り返し指定を変えない');
  assert.deepEqual(errors,[]);
  const result={at:new Date().toISOString(),checkoutHeadAtRun:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),checks,measurements,errors};
  await writeFile(path.join(artifacts,prefix+'-summary.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({checks:checks.length,errors,detail:measurements.find(item=>item.detailWidth),target:measurements[0].titles.find(item=>item.text===title)}));
} finally {
  process.argv=args;if(oldFixtureOption===undefined)delete process.env.QA_TITLE_WRAPPING;else process.env.QA_TITLE_WRAPPING=oldFixtureOption;
  await context?.close();await browser?.close();
  if(fixture){await new Promise(resolve=>fixture.server.close(resolve));await fixture.server.bugClosed;}
  const relative=path.relative(tmpdir(),data);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  await rm(data,{recursive:true,force:true});
}
