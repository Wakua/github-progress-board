import assert from 'node:assert/strict';
import { attachSnapshot } from '../dist/github-snapshot.mjs';
import { STORAGE_KEY } from '../dist/workspace.mjs';
import { ganttSnapshot } from './gantt-fixture.mjs';
import { qaWorkspace } from './local-github-fixture.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined});
try {
  const page = await browser.newPage({viewport:{width:800,height:800}});
  await page.route('**/api/**', route=>route.fulfill({status:503}));
  await page.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:4340/');
  const card=page.locator('.gantt[data-milestone]'), dialog=card.locator('dialog[open]');
  const selectRelease = name => page.getByRole('button',{name:name + 'の詳細',exact:true}).click();
  const paths=card.locator('path[data-pair]');
  const button=(scope,name)=>scope.getByRole('button',{name,exact:true});
  async function start(snapshot) {
    const w=qaWorkspace(); w.projects=w.projects.slice(0,1);
    w.projects[0].repositoryUrl=snapshot.repositoryUrl; attachSnapshot(w.projects[0],snapshot);
    await page.evaluate(([k,w])=>localStorage.setItem(k,JSON.stringify(w)),[STORAGE_KEY,w]);
    await page.reload(); await page.getByRole('tab',{name:'リリース',exact:true}).click();
    await selectRelease('リリースA');
  }
  await start(ganttSnapshot('goals'));
  assert.equal(await paths.count(),0);
  const loose=button(card,'#200 → #210（目標なし）');
  await loose.press('Enter');
  assert.match(await dialog.innerText(),/登録された前提/);
  assert.equal(await dialog.locator('li').count(),2);
  await page.keyboard.press('Escape');
  await selectRelease('リリースB');
  await button(card,'#201（リリースA） → #200').press('Enter');
  assert.match(await dialog.innerText(),/#401 変更通知を再送する/);
  assert.match(await dialog.innerText(),/#401 作業進捗率：未入力/);
  await page.keyboard.press('Escape');

  await start(ganttSnapshot('dependencies'));
  const pair=button(card,'#200 → #300');
  for (const scale of ['day','week','month']) {
    await card.locator('[aria-pressed][data-scale="'+scale+'"]').click();
    assert.equal(await paths.count(),1);
    const geometry=await card.locator('[data-gantt="connections"]').evaluate(svg=>{
      const el=svg.querySelector('path[data-pair]');
      const [from,to]=JSON.parse(el.dataset.pair.slice(5));
      const end=el.getPointAtLength(el.getTotalLength());
      const tip=new DOMPoint(end.x,end.y).matrixTransform(svg.getScreenCTM());
      const target=[...el.closest('.chart').querySelectorAll('[data-goal-bar]')].find(bar=>bar.dataset.goalBar===to).getBoundingClientRect();
      return {from,to,hit:tip.y>=target.top-1 && tip.y<=target.bottom+1 && tip.x>=target.left-1 && tip.x<=target.right+1};
    });
    assert.ok(geometry.from.endsWith('/200') && geometry.to.endsWith('/300') && geometry.hit);
  }
  await card.locator('[aria-pressed][data-scale="day"]').click();
  await card.locator('.chart').scrollIntoViewIfNeeded();
  const hit=await card.locator('[data-gantt="connections"]').evaluate(svg=>{
    const el=svg.querySelector('path[data-pair]');
    const p=el.getPointAtLength(el.getTotalLength()/2).matrixTransform(el.getScreenCTM());
    return {x:p.x,y:p.y};
  });
  await page.mouse.click(hit.x,hit.y);
  assert.match(await dialog.locator('h2').innerText(),/#200 → #300/);
  await page.keyboard.press('Escape');
  assert.ok(await pair.evaluate(el=>el===document.activeElement));
  await pair.press('Enter');
  assert.equal(await dialog.locator('li').count(),2);
  await button(dialog,'#201 変更内容を保存する').first().press('Enter');
  await button(dialog,'戻る').press('Enter');
  assert.match(await dialog.locator('h2').innerText(),/#200 → #300/);
  await page.keyboard.press('Escape');
  assert.ok(await pair.evaluate(el=>el===document.activeElement));
  const internal=button(card,'#200 親内の前提 1件');
  await internal.click();
  assert.match(await dialog.innerText(),/#201 変更内容を保存する.*→.*#202 変更履歴を表示する/s);
  await page.keyboard.press('Escape');
  await card.locator('[data-parent$="/300"]').click();
  await card.locator('[data-parent$="/305"]').click();
  assert.match(await paths.first().getAttribute('data-pair'),/305/);
  await card.locator('[data-parent$="/200"]').click();
  assert.equal(await paths.count(),3);
  await card.locator('[data-parent$="/300"]').click();
  await card.locator('[data-parent$="/200"]').click();
  assert.equal(await paths.count(),1);

  const incomplete=ganttSnapshot('dependencies');
  const unknown=incomplete.planning.schedule.issues.find(i=>i.key.endsWith('/201'));
  unknown.blockedBy={keys:[],totalCount:null,complete:false,problem:'not-fetched'};
  for (const metadata of incomplete.planning.issues) {
    for (const field of ['blockedBy','pullRequests','spec']) delete metadata[field];
  }
  await start(incomplete);
  await button(card,'前提未確認 1件').click();
  assert.match(await dialog.innerText(),/#201.*未取得/s);
  await page.keyboard.press('Escape');
  await pair.press('Enter');
  assert.match(await dialog.innerText(), /#201 前提：未取得/);
  console.log('元の登録、目標間の矢印の向き、親内・別リリース・未所属、取得不足、日程未算出、重複とキー復帰を確認した。');
} finally {
  await browser.close();
}
