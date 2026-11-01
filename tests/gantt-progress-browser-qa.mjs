// Use the normal release tab and a fresh, fictional workspace for each read state.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { attachSnapshot } from '../dist/github-snapshot.mjs';
import { STORAGE_KEY } from '../dist/workspace.mjs';
import { ganttSnapshot } from './gantt-fixture.mjs';
import { qaWorkspace } from './local-github-fixture.mjs';

const cases = [
  { id: 'invalid', value: 101, label: '不正な値', capture: true },
  { id: 'legacy', label: '未取得', capture: true },
  { id: 'negative', value: -1, label: '不正な値' },
  { id: 'fraction', value: 60.5, label: '不正な値' },
  { id: 'empty', value: null, label: '未入力' },
  { id: 'forbidden', problem: 'forbidden', label: '取得権限なし' },
  { id: 'failed', problem: 'failed', label: '取得失敗' },
  ...[0, 60, 100].map(value => ({ id: String(value), value, label: value + '%', bar: true })),
];
function workspaceFor(example) {
  const snapshot = ganttSnapshot('basic', example.id === 'invalid' ? 101 : 0);
  if (example.id === 'legacy') delete snapshot.planning.schedule;
  else {
    const issue = snapshot.planning.schedule.issues.find(issue => issue.key.endsWith('/201'));
    issue.projects[0].workProgressPercent = { value: example.value ?? null, problem: example.problem ?? null };
  }
  const workspace = qaWorkspace();
  workspace.projects = workspace.projects.slice(0, 1);
  workspace.projects[0].repositoryUrl = snapshot.repositoryUrl;
  attachSnapshot(workspace.projects[0], snapshot);
  return workspace;
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = path.join(process.env.QA_ARTIFACT_DIR || 'node_modules/.qa', 'gantt-progress');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const results = [];
try {
  for (const example of cases) {
    const context = await browser.newContext({ viewport: { width: 800, height: 800 } });
    await context.route(/\/api\/(?:local-github|github\/refresh)/, route => route.fulfill({ status: 503 }));
    const page = await context.newPage();
    await page.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:4340/');
    await page.evaluate(([key, data]) => localStorage.setItem(key, JSON.stringify(data)), [STORAGE_KEY, workspaceFor(example)]);
    await page.reload();
    await page.getByRole('tab', { name: 'リリース', exact: true }).click();
    await page.getByRole('button',{name:'リリースAの詳細',exact:true}).click();
    assert.equal(await page.getByLabel('計算に使うProject').inputValue(),'sample-project');
    const card = page.getByRole('region', { name: 'リリースA', exact: true });
    const goal = card.locator('.goal-heading').filter({hasText:'#200 機能A'});
    assert.match(await goal.innerText(), /0\/2/);
    assert.doesNotMatch(await goal.innerText(), /%|✓/);
    await goal.getByRole('button').press('Enter');
    const opener = card.getByRole('button', { name: /^#201 .*の詳細/ });
    const row = opener.locator('../..');
    assert.equal(await row.getByRole('progressbar').count(), 0);
    assert.doesNotMatch(await row.innerText(), /%/);
    if (example.capture) await card.screenshot({ path: path.join(artifacts, example.id + '-list.jpg'), quality: 65 });
    await opener.press('Enter');
    const dialog = card.locator('dialog[open]');
    const fact = dialog.locator('dt').filter({ hasText: /^作業進捗率$/ }).locator('..');
    const value = fact.locator('dd');
    const detail = await value.innerText();
    const detailAX = await fact.ariaSnapshot();
    const cdp = await context.newCDPSession(page);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const axBar = nodes.find(node => node.role?.value === 'progressbar' && node.name?.value === '#201 実装Aの作業進捗率');
    const range = axBar?.properties.filter(property => ['valuemin', 'valuemax'].includes(property.name))
      .map(property => [property.name, property.value.value]);
    await cdp.detach();
    const bars = await value.getByRole('progressbar').evaluateAll(nodes => nodes.map(node => ({
      value: node.getAttribute('aria-valuenow'), width: node.firstElementChild.style.width,
    })));
    if (example.capture) await dialog.screenshot({ path: path.join(artifacts, example.id + '-detail.jpg'), quality: 65 });
    if (example.capture || example.id === 'forbidden') {
      await page.setViewportSize({ width: 320, height: 720 });
      const fontSize = await value.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
      await page.addStyleTag({ content: `.gantt dialog dd { font-size: ${fontSize * 2}px; }` });
      assert.ok(await value.evaluate(el => el.scrollWidth <= el.clientWidth + 1 &&
        el.getBoundingClientRect().right <= innerWidth));
    }
    await dialog.getByRole('button', { name: '閉じる' }).press('Escape');
    await page.waitForFunction(() => document.activeElement?.matches('[data-task]'));
    assert.ok(await opener.evaluate(node => node === document.activeElement));
    results.push({ id: example.id, bars, axValue: axBar?.value?.value, range, detail, detailAX });
    await context.close();
  }
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
  for (const [i, example] of cases.entries()) {
    const actual = results[i];
    const expectedDetail = example.label + (example.value === 100 ? '・未完了' : '') + '（見積 2pt）';
    assert.equal(actual.detail, expectedDetail);
    assert.ok(actual.detailAX.includes(expectedDetail));
    assert.deepEqual(actual.bars, example.bar ? [{ value: String(example.value), width: example.label }] : []);
    if (example.bar) {
      assert.match(actual.detailAX, /progressbar "#201 実装Aの作業進捗率"/);
      assert.equal(actual.axValue, example.value);
      assert.deepEqual(Object.fromEntries(actual.range), { valuemin: 0, valuemax: 100 });
    }
    else {
      assert.doesNotMatch(actual.detailAX, /progressbar/);
    }
  }
  const workspace = workspaceFor(cases.find(example => example.id === 'legacy'));
  const project = workspace.projects[0].githubSnapshot.planning.issues[0].projects[0];
  workspace.projects[0].githubSnapshot.planning.issues[0].projects.push({...project,id:'second-project',title:'別のProject',url:'https://github.com/users/example/projects/2'});
  const page = await browser.newPage();
  await page.route(/\/api\//,route => route.fulfill({status:503}));
  await page.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:4340/');
  await page.evaluate(([key,data]) => localStorage.setItem(key,JSON.stringify(data)),[STORAGE_KEY,workspace]);
  await page.reload();
  await page.getByRole('tab',{name:'リリース',exact:true}).click();
  await page.getByRole('button',{name:'リリースAの詳細',exact:true}).click();
  assert.equal(await page.getByLabel('計算に使うProject').inputValue(),'');
  assert.equal(await page.locator('.goal-heading').count(),0);
  await page.getByLabel('計算に使うProject').selectOption('sample-project');
  await page.locator('.goal-heading').first().waitFor();
  console.log('進捗10条件と、1件・複数候補の出典選択を確認した。');
} finally {
  await browser.close();
}
