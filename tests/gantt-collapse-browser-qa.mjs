import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { attachSnapshot } from '../dist/github-snapshot.mjs';
import { STORAGE_KEY } from '../dist/workspace.mjs';
import { ganttSnapshot, repositoryUrl } from './gantt-fixture.mjs';
import { qaWorkspace } from './local-github-fixture.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = path.join(process.env.QA_ARTIFACT_DIR || 'node_modules/.qa', 'gantt-collapse');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
  const workspace = qaWorkspace();
  workspace.projects = workspace.projects.slice(0, 1);
  workspace.projects[0].repositoryUrl = repositoryUrl;
  attachSnapshot(workspace.projects[0], ganttSnapshot('collapse'));
  await page.route('**/api/local-github', route => route.fulfill({ json: {
    schemaVersion: 1, csrfToken: 'a'.repeat(64), repositories: [repositoryUrl],
  } }));
  let holdRefresh;
  await page.route('**/api/github/refresh', async route => {
    if (holdRefresh) await holdRefresh;
    await route.fulfill({ json: ganttSnapshot('collapse', null, new Date().toISOString()) });
  });
  await page.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:4340/');
  await page.evaluate(([key,data]) => localStorage.setItem(key, JSON.stringify(data)), [STORAGE_KEY,workspace]);
  await page.reload();
  const releaseTab = page.getByRole('tab', { name:'リリース', exact:true });
  await releaseTab.click();
  const selectRelease = name => page.getByRole('button',{name:name + 'の詳細',exact:true}).click();
  const showA = () => selectRelease('リリースA');
  const showB = () => selectRelease('リリースB');
  assert.equal(await page.locator('#release-panel .gantt').count(),0);
  await showA();
  await page.getByLabel('計算に使うProject').selectOption('sample-project');
  const panel = page.locator('#release-panel');
  const a = panel.getByRole('region', { name:'リリースA', exact:true });
  const b = panel.getByRole('region', { name:'リリースB', exact:true });
  const button = (scope,name) => scope.getByRole('button', { name, exact:true });
  const parent = button(a,'#200 機能A'), release = button(a,'リリースA');
  const visibleTasks = card => card.locator('[data-task]:visible').evaluateAll(nodes => nodes.map(n => Number(n.dataset.task.split('/').at(-1))));
  const facts = card => card.evaluate(el => ({
    summary: el.querySelector('[data-gantt="summary"]').textContent,
    alerts: el.querySelector('[data-gantt="alerts"]').textContent,
    goalCounts: [...el.querySelectorAll('.goal-metrics')].map(n => n.textContent),
    bars: [...el.querySelectorAll('[data-bar]')].map(n => n.getAttribute('aria-label')),
  }));
  const lines = () => a.locator('svg.connections path[marker-end]').evaluateAll(nodes => nodes.map(n => n.getAttribute('d')));
  const shot = name => panel.screenshot({ path:path.join(artifacts,name+'.jpg'),quality:58 });
  const state = async (toggle, expanded) => assert.equal(await toggle.getAttribute('aria-expanded'),String(expanded));
  assert.deepEqual(await visibleTasks(a),[]);
  assert.match(await parent.locator('..').innerText(),/0\/2/);
  await showB();
  assert.equal(await a.count(),0);
  assert.deepEqual(await visibleTasks(b),[]);
  const solo = '目標のない・特定できない作業';
  assert.equal(await b.locator('.goal-heading').count(),0);
  await button(b,'その他の作業').click();
  assert.ok(await button(b,solo).isVisible());
  const initialB = await facts(b), otherRows = await visibleTasks(b);
  assert.deepEqual([...otherRows].sort(),[201,401]);
  await showA();
  for (const toggle of [parent,button(a,'#300 通知'),button(a,'その他の作業')]) await toggle.press('Enter');
  await a.locator('[data-scale="day"][aria-pressed]').click();
  assert.match(await a.locator('.goal-issue:visible').first().getAttribute('href'),/\/issues\/200$/);
  const initialA = await facts(a), initialLines = await lines();
  assert.deepEqual((await visibleTasks(a)).sort(),[201,202,210,301]);
  assert.ok(initialLines.length >= 2);
  await shot('expanded');
  await parent.press('Space');
  await state(parent,false);
  assert.deepEqual((await visibleTasks(a)).sort(),[210,301]);
  assert.equal(await b.count(),0);
  assert.equal((await lines()).length,1);
  await shot('parent-closed');

  const nested = button(a,'#305 メール通知'), outer = button(a,'#300 通知');
  await nested.press('Enter'); await outer.click(); await outer.click();
  await state(nested,false);
  assert.deepEqual(await visibleTasks(a),[210]);
  await nested.click();
  const detail = a.getByRole('button',{name:/^#210 .*の詳細/});
  await detail.press('Enter');
  let dialog = a.locator('dialog[open]');
  await button(dialog,'#202 実装B').click();
  await button(dialog,'#210 結合確認').click();
  await button(dialog,'戻る').click();
  assert.match(await dialog.locator('h2').innerText(),/#202/);
  await button(dialog,'閉じる').press('Escape');
  await page.waitForFunction(() => document.activeElement?.dataset.task?.endsWith('/210'));
  for (const scale of ['week','month','day']) {
    await a.locator('[data-scale="'+scale+'"][aria-pressed]').click();
    await state(parent,false);
    assert.deepEqual(await facts(a),initialA);
    assert.equal((await lines()).length,1);
  }
  await release.press('Enter');
  await state(release,false);
  assert.equal(await a.locator('.card').isVisible(),false);
  assert.equal(await a.locator('[data-gantt="summary"]').isVisible(),true);
  assert.deepEqual(await facts(a),initialA);
  assert.equal(await b.count(),0);
  await shot('release-closed');
  await button(a,'リリースAの計算根拠').click();
  assert.match(await a.locator('dialog[open]').innerText(),/完了見込み/);
  await page.keyboard.press('Escape');
  await showB();
  assert.deepEqual(await visibleTasks(b),otherRows);
  const bToggle=button(b,'リリースB');
  await bToggle.click();
  await b.screenshot({path:path.join(artifacts,'closed-alerts.jpg'),quality:58});
  await button(b,'情報不足 1件').click();
  assert.match(await b.locator('dialog[open]').innerText(),/未入力/);
  await page.keyboard.press('Escape');
  await bToggle.click();
  await showA();
  const oldCard = await a.elementHandle();
  let resumeRefresh;
  holdRefresh = new Promise(resolve => { resumeRefresh = resolve; });
  const pending = page.waitForRequest('**/api/github/refresh');
  await button(panel,'GitHubを再取得').click();
  await pending;
  await release.focus();
  resumeRefresh();
  await page.waitForFunction(el => !el.isConnected, oldCard);
  await state(release,false);
  assert.ok(await release.evaluate(el => el === document.activeElement));
  await page.getByRole('tab',{name:'自分の作業',exact:true}).click();
  await releaseTab.click();
  await state(release,false);
  await release.press('Space');
  await state(parent,false);
  assert.deepEqual((await visibleTasks(a)).sort(),[210,301]);
  await parent.press('Enter');
  await state(parent,true);
  assert.deepEqual((await visibleTasks(a)).sort(),[201,202,210,301]);
  assert.deepEqual(await facts(a),initialA);
  await showB();
  assert.deepEqual(await facts(b),initialB);
  await showA();
  assert.deepEqual(await lines(),initialLines);
  await shot('restored');
  await page.setViewportSize({width:320,height:720});
  await page.addStyleTag({content:'.gantt .fold-button {font-size:200%}'});
  await parent.press('Enter');
  assert.ok(await parent.evaluate(el => el === document.activeElement && el.getBoundingClientRect().right <= innerWidth));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const ax = await a.locator('.title-row').ariaSnapshot();
  assert.match(ax,/button "リリースA" \[expanded\]/);
  await writeFile(path.join(artifacts,'results.json'),JSON.stringify({initialA,initialB,otherRows,initialLines,ax},null,2));
  console.log('親・リリースの独立開閉、計算結果、依存線、再取得・タブ復帰とキーボード操作を確認した。');

  const fitPage = await browser.newPage({ viewport: { width: 800, height: 820 } });
  await fitPage.clock.setFixedTime(new Date('2026-11-27T12:00:00+09:00'));
  await fitPage.route('**/api/**', route => route.fulfill({ status: 503 }));
  const fitSnapshot = ganttSnapshot('collapse');
  fitSnapshot.planning.milestones[0].dueOn = '2029-02-26T00:00:00Z';
  fitSnapshot.planning.milestones[1].dueOn = '2026-12-11T00:00:00Z';
  const fitWorkspace = qaWorkspace();
  fitWorkspace.projects = fitWorkspace.projects.slice(0, 1);
  fitWorkspace.projects[0].repositoryUrl = repositoryUrl;
  attachSnapshot(fitWorkspace.projects[0], fitSnapshot);
  const saveWorkspace = () => fitPage.evaluate(([key,data]) => localStorage.setItem(key, JSON.stringify(data)), [STORAGE_KEY,fitWorkspace]);
  await fitPage.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:4340/');
  await saveWorkspace();
  await fitPage.reload();
  const openRelease = name => fitPage.getByRole('button', {name: name + 'の詳細', exact: true}).click();
  const fitCard = fitPage.locator('.gantt[data-milestone]');
  const scale = unit => fitCard.locator('[data-scale="'+unit+'"][aria-pressed="true"]');
  const inspectTimeline = () => fitCard.locator('.timeline-scroll').evaluate(el => {
    const viewport = el.getBoundingClientRect();
    const due = el.querySelector('.due-marker').getBoundingClientRect();
    return {
      fits: el.scrollWidth === el.clientWidth,
      dueVisible: due.left >= viewport.left && due.right <= viewport.right,
      scroll: el.scrollLeft,
    };
  });
  async function checkFit(unit) {
    await scale(unit).waitFor();
    assert.deepEqual(await inspectTimeline(), { fits: true, dueVisible: true, scroll: 0 });
  }
  async function returnToMonth() {
    const timeline = fitCard.locator('.timeline-scroll');
    const scroll = await timeline.evaluate(el => {
      el.scrollLeft = el.scrollWidth - el.clientWidth;
      return el.scrollLeft;
    });
    assert.ok(scroll > 0);
    await fitCard.locator('button[data-scale="month"]').press('Enter');
    await checkFit('month');
  }
  await fitPage.getByRole('tab', {name:'リリース', exact:true}).click();
  await openRelease('リリースA');
  await checkFit('month');
  await fitCard.locator('button[data-scale="day"]').press('Enter');
  await returnToMonth();
  await openRelease('リリースB');
  await checkFit('week');
  await fitPage.setViewportSize({width: 320, height: 720});
  await checkFit('month');
  await openRelease('リリースA');
  await checkFit('month');
  const headerBorders = await fitCard.locator('.dates > span:empty').evaluateAll(
    cells => cells.map(cell => getComputedStyle(cell).borderLeftColor),
  );
  assert.ok(headerBorders.length > 0);
  assert.ok(headerBorders.every(color => color === 'rgba(0, 0, 0, 0)'));
  await fitCard.locator('button[data-scale="day"]').press('Enter');
  await scale('day').waitFor();
  assert.equal((await inspectTimeline()).fits, false);
  await openRelease('リリースB');
  await checkFit('month');
  await openRelease('リリースA');
  await scale('day').waitFor();
  await returnToMonth();
  await fitCard.locator('button[data-scale="day"]').press('Enter');
  await fitPage.reload();
  await openRelease('リリースA');
  await checkFit('month');

  fitSnapshot.planning.milestones[0].dueOn = '2026-10-15T00:00:00Z';
  fitWorkspace.projects[0].githubSnapshot = null;
  attachSnapshot(fitWorkspace.projects[0], fitSnapshot);
  await saveWorkspace();
  await fitPage.reload();
  await openRelease('リリースA');
  await checkFit('month');
  assert.equal(await fitCard.locator('[data-gantt="visible-range"]').innerText(), '2026/10/1–2026/12/31');
  console.log('初期表示、目盛り、期日、800px・320pxでの日から月への切替、再読み込みと年末の表示期間を確認した。');
} finally { await browser.close(); }
