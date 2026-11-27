// A has one missing estimate. Only B has a dependency cycle in this snapshot.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { attachSnapshot } from '../dist/github-snapshot.mjs';
import { STORAGE_KEY } from '../dist/workspace.mjs';
import { ganttSnapshot } from './gantt-fixture.mjs';
import { qaWorkspace } from './local-github-fixture.mjs';

function mixedWarnings() {
  const snapshot = ganttSnapshot('cycle');
  const planning = snapshot.planning;
  const second = planning.milestones[1];
  Object.assign(second, { title: 'リリースB', state: 'open', closedAt: null, dueOn: planning.milestones[0].dueOn });
  for (const issue of planning.issues) {
    if (issue.number === 220) issue.projects[0].estimatePoints = null;
    else issue.milestoneNumber = second.number;
  }
  const independent = planning.schedule.issues.find(issue => issue.key.endsWith('/220'));
  independent.projects[0].estimatePoints.value = null;
  return workspaceWithSnapshot(snapshot);
}

function workspaceWithSnapshot(snapshot) {
  const workspace = qaWorkspace();
  workspace.projects = workspace.projects.slice(0, 1);
  workspace.projects[0].repositoryUrl = snapshot.repositoryUrl;
  attachSnapshot(workspace.projects[0], snapshot);
  return workspace;
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = path.join(process.env.QA_ARTIFACT_DIR || 'node_modules/.qa', 'gantt-warning');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 800, height: 900 } });
  await context.route(/\/api\/(?:local-github|github\/refresh)/, route => route.fulfill({ status: 503 }));
  const page = await context.newPage();
  await page.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:4340/');
  await page.evaluate(([key, data]) => localStorage.setItem(key, JSON.stringify(data)), [STORAGE_KEY, mixedWarnings()]);
  await page.reload();
  await page.getByRole('tab', { name: 'リリース', exact: true }).click();
  const selectRelease = name => page.getByRole('button',{name:name + 'の詳細',exact:true}).click();
  await selectRelease('リリースA');
  await page.getByLabel('計算に使うProject').selectOption('sample-project');

  const results = [];
  for (const name of ['リリースA', 'リリースB']) {
    await selectRelease(name);
    const card = page.getByRole('region', { name, exact: true });
    const warning = card.locator('[data-panel="diagnostics"]');
    const label = await warning.innerText();
    await warning.press('Enter');
    const dialog = card.locator('dialog[open]');
    const reason = await dialog.innerText();
    await dialog.getByRole('button', { name: '閉じる' }).press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.matches('[data-panel="diagnostics"]'));
    assert.ok(await warning.evaluate(el => el === document.activeElement));
    results.push({ name, label, reason });
  }
  await page.locator('#release-panel').screenshot({ path: path.join(artifacts, 'warnings.jpg'), quality: 65 });
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  assert.match(results[0].reason, /見積：未入力/);
  assert.doesNotMatch(results[0].reason, /循環/);
  assert.match(results[1].reason, /循環/);
  assert.deepEqual(results.map(item => item.label), ['情報不足 1件', '循環・情報不足 1件']);

  await page.setViewportSize({ width: 320, height: 720 });
  await selectRelease('リリースA');
  const normalSize = await page.getByRole('button', { name: '情報不足 1件', exact: true })
    .evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  const enlargedSize = normalSize * 2;
  await page.addStyleTag({ content: `.gantt [data-panel] { font-size: ${enlargedSize}px !important; }` });
  for (const {name,label} of results) {
    await selectRelease(name);
    const warning = page.getByRole('button', { name: label, exact: true });
    const fits = await warning.evaluate((el, size) => {
      const rect = el.getBoundingClientRect();
      return parseFloat(getComputedStyle(el).fontSize) === size &&
        rect.left >= 0 && rect.right <= innerWidth && el.scrollWidth <= el.clientWidth;
    }, enlargedSize);
    assert.ok(fits, label);
  }
  await page.locator('#release-panel').screenshot({ path: path.join(artifacts, 'narrow-large.jpg'), quality: 65 });
  console.log('各リリースの警告名と詳細が、そのリリースの原因に一致した。');

  const forecastPage = await context.newPage();
  await forecastPage.clock.setFixedTime(new Date('2026-11-02T12:00:00+09:00'));
  await forecastPage.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:4340/');
  const release = forecastPage.getByRole('region', { name: 'リリースA', exact: true });
  const summary = release.locator('[data-gantt="summary"]');
  const basis = release.getByRole('button', { name: 'リリースAの計算根拠', exact: true });
  const details = release.locator('dialog');
  const snapshot = ganttSnapshot('overlap');
  async function showForecast(due) {
    snapshot.planning.milestones[0].dueOn = due + 'T00:00:00Z';
    await forecastPage.evaluate(([key, data]) => localStorage.setItem(key, JSON.stringify(data)), [STORAGE_KEY, workspaceWithSnapshot(snapshot)]);
    await forecastPage.reload();
    await forecastPage.getByRole('tab', { name: 'リリース', exact: true }).click();
    await forecastPage.getByRole('button', { name: 'リリースAの詳細', exact: true }).click();
  }
  await showForecast('2026-11-05');
  assert.match(await summary.innerText(), /完了まで少なくとも5平日.*担当者の作業量.*期日超過/);
  await basis.press('Enter');
  assert.match(await details.innerText(), /依存関係と開始条件\s+4平日/);
  assert.match(await details.innerText(), /担当者の作業量\s+5平日（担当A）/);
  assert.match(await details.innerText(), /少なくとも1平日超過/);
  await forecastPage.keyboard.press('Escape');
  await details.waitFor({ state: 'hidden' });
  await forecastPage.waitForFunction(() => document.activeElement?.matches('[data-gantt="release-details"]'));
  await forecastPage.setViewportSize({ width: 320, height: 760 });
  await showForecast('2026-11-06');
  assert.doesNotMatch(await summary.innerText(), /期日どおり|期日超過|余裕/);
  assert.ok(await forecastPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await basis.press('Enter');
  assert.match(await details.innerText(), /期日までに完了できるかは未確定/);
  await forecastPage.keyboard.press('Escape');
  snapshot.planning.schedule.issues.find(issue => issue.key.endsWith('/202')).projects[0].owner.value = null;
  snapshot.planning.issues.find(issue => issue.number === 202).projects[0].owner = null;
  await showForecast('2026-11-06');
  assert.match(await summary.innerText(), /完了まで少なくとも4平日.*担当別の下限は未算出/);
  await basis.press('Enter');
  assert.match(await details.innerText(), /実装B\s+担当不明/);
  console.log('担当者の下限、期日超過と未確定の区別、担当不明の作業を実画面で確認した。');
} finally {
  await browser.close();
}
