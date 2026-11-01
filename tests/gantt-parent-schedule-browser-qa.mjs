import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { attachSnapshot } from '../dist/github-snapshot.mjs';
import { STORAGE_KEY } from '../dist/workspace.mjs';
import { ganttSnapshot } from './gantt-fixture.mjs';
import { qaWorkspace } from './local-github-fixture.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined});
try {
  const page = await browser.newPage({viewport:{width:800,height:800}});
  await page.route('**/api/**', route => route.fulfill({status:503}));
  await page.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:4340/');
  async function start(snapshot) {
    const w = qaWorkspace();
    w.projects = w.projects.slice(0,1);
    w.projects[0].repositoryUrl = snapshot.repositoryUrl;
    attachSnapshot(w.projects[0],snapshot);
    await page.evaluate(([key,data])=>localStorage.setItem(key,JSON.stringify(data)),[STORAGE_KEY,w]);
    await page.reload();
    await page.getByRole('tab',{name:'リリース',exact:true}).click();
    await page.getByRole('button',{name:'リリースAの詳細',exact:true}).click();
  }
  const card = page.locator('.gantt[data-milestone]');
  const goal = n => card.locator('[data-goal-bar$="/'+n+'"]');
  const child = n => card.locator('[data-bar$="/'+n+'"]');
  const toggle = n => card.locator('[data-parent$="/'+n+'"]');
  async function bounds(locator) {
    return locator.evaluate(el => {
      const box=el.getBoundingClientRect();
      // A zero-day diamond is centred on its coordinate.
      return el.classList.contains('point') ? [box.x+box.width/2,box.x+box.width/2] : [box.left,box.right];
    });
  }
  const same = (a,b) => a.forEach((x,i)=>assert.ok(Math.abs(x-b[i])<0.1, x+' vs '+b[i]));
  await start(ganttSnapshot('goals'));
  assert.equal(await card.locator('[data-goal-bar]:visible').count(),2);
  assert.equal(await card.locator('[data-task]:visible').count(),0);
  assert.ok(await card.locator('[data-gantt="dates"]').isVisible());
  for (const width of [1265,800]) {
    await page.setViewportSize({width,height:800});
    const height = await toggle(200).locator('..').evaluate(el => el.getBoundingClientRect().height);
    assert.ok(height <= 70, width+'px viewport: '+height+'px goal heading');
  }
  const parentPeriod = await goal(200).getAttribute('aria-label');
  assert.match(parentPeriod,/日内60%/);
  await toggle(200).press('Enter');
  await toggle(300).press('Enter');
  await toggle(305).press('Space');
  assert.ok(await goal(305).isVisible());
  assert.equal(await child(301).isVisible(),false);
  await toggle(305).press('Space');
  await page.setViewportSize({width:360,height:780});
  for (const scale of ['day','week','month']) {
    await card.locator('[data-scale="'+scale+'"][aria-pressed]').click();
    const scroll=card.locator('.timeline-scroll');
    for (const x of [0,48]) {
      await scroll.evaluate((el,v)=>el.scrollLeft=v,x);
      assert.equal(await scroll.evaluate(el=>el.scrollLeft),x);
      same(await bounds(goal(200)),await bounds(child(202)));
      same(await bounds(goal(300)),await bounds(child(301)));
      same(await bounds(goal(305)),await bounds(child(301)));
      assert.equal(await goal(200).getAttribute('aria-label'),parentPeriod);
    }
  }
  await page.getByRole('button',{name:'リリースBの詳細',exact:true}).click();
  assert.equal(await goal(200).count(),0);
  assert.ok(await card.getByText('#401 作業進捗率：未入力',{exact:true}).first().isVisible());

  const sample=ganttSnapshot('goals');
  const planning = n => sample.planning.schedule.issues.find(i=>i.key.endsWith('/'+n)).projects[0];
  planning(202).workProgressPercent.value=null;
  planning(301).workProgressPercent.value=50; // 2 pt at 50% leaves one full day.
  await start(sample);
  assert.ok(await card.getByText(/一部 1\/2件/).isVisible());
  assert.match(await goal(200).getAttribute('class'),/point/);
  assert.match(await goal(200).getAttribute('aria-label'),/一部算出/);
  assert.match(await goal(300).getAttribute('aria-label'),/開始から.*終了/);
  if (process.env.QA_ARTIFACT_DIR) {
    const dir = path.join(process.env.QA_ARTIFACT_DIR,'parent-schedule');
    await mkdir(dir,{recursive:true});
    await page.setViewportSize({width:800,height:800});
    await card.screenshot({path:path.join(dir,'partial.jpg'),quality:62});
  }
  await toggle(200).press('Enter');
  await toggle(300).press('Enter');
  for (const scale of ['day','week','month']) {
    await card.locator('[data-scale="'+scale+'"][aria-pressed]').click();
    same(await bounds(goal(200)),await bounds(child(201)));
    same(await bounds(goal(300)),await bounds(child(301)));
  }
  const mixed = ganttSnapshot('dependencies');
  const close = n => {
    const item = mixed.items.find(i => i.number === n);
    item.state = 'closed'; item.closedAt = item.updatedAt;
    mixed.planning.schedule.issues.find(i=>i.key === item.url).state.value = 'closed';
    for (const issue of mixed.planning.issues) {
      for (const link of issue.blockedBy) if (link.url === item.url) link.state = 'closed';
    }
  };
  const group = toggle(200).locator('../..');
  const active = mixed.planning.schedule.issues.find(i => i.key.endsWith('/201')).projects[0];
  close(202);
  await start(mixed);
  assert.ok(await goal(200).isVisible()); // #201 has 100% recorded but remains open.
  assert.doesNotMatch(await goal(200).getAttribute('aria-label'),/一部算出/);
  active.workProgressPercent.value = null;
  await start(mixed);
  assert.match(await group.innerText(),/#201 作業進捗率：未入力/);
  close(201);
  await start(mixed);
  assert.match(await group.innerText(),/残作業なし/);
  assert.equal(await goal(200).count(),0);
  await card.getByRole('button',{name:'#200 親内の前提 1件',exact:true}).click();
  assert.match(await card.locator('dialog[open]').innerText(),/前提完了/);
  assert.doesNotMatch(await card.locator('dialog[open]').innerText(),/日程未算出|日程情報なし|未入力/);
  await page.keyboard.press('Escape');
  console.log('閉じた2目標、中間親、部分算出・未算出、0日・単日・端数の端点を子と同じ軸で確認した。');
} finally {
  await browser.close();
}
