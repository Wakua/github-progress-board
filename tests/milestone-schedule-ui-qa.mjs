// Compare the existing release screen while the new schedule engine is unconnected.
// Usage: QA_MAIN_ROOT=<clean main checkout> node tests/milestone-schedule-ui-qa.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { createProgressServer } from '../server.mjs';
import { bookingSampleWorkspace } from '../scripts/make-booking-sample.mjs';
import { STORAGE_KEY } from '../dist/workspace.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mainRoot = process.env.QA_MAIN_ROOT;
assert.ok(mainRoot, 'QA_MAIN_ROOT must identify the clean main checkout');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
assert.equal(git(mainRoot, 'branch', '--show-current'), 'main');
assert.equal(git(mainRoot, 'status', '--porcelain'), '');
const currentRoot = process.cwd();
const output = path.resolve('docs/screens/124');
const logPath = process.env.QA_RESULT_PATH || path.join(os.tmpdir(), 'issue-124-ui-results.json');
await mkdir(output, { recursive: true });
const sample = bookingSampleWorkspace(new Date('2026-10-05T12:00:00Z'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
const runs = [], servers = [], errors = [];
const screens = [
  { name: 'release', width: 800, colorScheme: 'light', zoom: 1 },
  { name: 'release-narrow', width: 390, colorScheme: 'light', zoom: 1 },
  { name: 'release-zoom-dark', width: 800, colorScheme: 'dark', zoom: 2 },
];
try {
  for (const [version, root] of [['before', mainRoot], ['after', currentRoot]]) {
    const server = createProgressServer({ root: path.join(root, 'dist'), repositories: [], dataDir: path.join(os.tmpdir(), 'issue-124-unused-bug-data') });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}/`;
    const run = { version, head: git(root, 'rev-parse', 'HEAD'), scenarios: [] };
    for (const [index, screen] of screens.entries()) {
      const context = await browser.newContext({ viewport: { width: screen.width, height: 900 }, colorScheme: screen.colorScheme });
      await context.route(/\/api\//, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"qa-disabled"}' }));
      const page = await context.newPage(), modules = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (request.url().endsWith('.mjs')) modules.push(new URL(request.url()).pathname); });
      await page.clock.install({ time: new Date('2026-10-05T12:00:00Z') });
      await page.goto(base);
      await page.evaluate(({ key, sample }) => {
        localStorage.setItem(key, JSON.stringify(sample));
        localStorage.setItem('progress-tool.view.v1', JSON.stringify({ tab: 'release' }));
      }, { key: STORAGE_KEY, sample });
      await page.reload(); await page.locator('.release-card').first().waitFor();
      if (screen.zoom !== 1) await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, screen.zoom);
      const saved = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
      const releaseText = await page.locator('#release-panel').innerText();
      assert.match(releaseText, /残り9.5pt/);
      assert.match(releaseText, /見積なし/);
      assert.doesNotMatch(releaseText, /完了予定|クリティカルパス/);
      const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(horizontalOverflow, false);
      const screenshot = `${version}-${String(index + 1).padStart(2, '0')}-${screen.name}.jpg`;
      await page.screenshot({ path: path.join(output, screenshot), type: 'jpeg', quality: 60, fullPage: true, animations: 'disabled', style: '#toast { visibility: hidden !important; }' });
      const opener = page.locator('#release-panel [data-action="github-item"][data-id="issue:3"]');
      await page.getByRole('tab', { name: 'リリース', exact: true }).click();
      for (let step = 0; step < 30 && !await opener.evaluate(el => el === document.activeElement); step++) await page.keyboard.press('Tab');
      assert.equal(await opener.evaluate(el => el === document.activeElement), true, 'Issue #3 is reachable with Tab');
      const scrollBefore = await page.evaluate(() => scrollY);
      await page.keyboard.press('Enter');
      await page.locator('#detail-dialog').waitFor({ state: 'visible' });
      assert.match(await page.locator('#drawer-title').innerText(), /入力欄を作る/);
      assert.match(await page.locator('#drawer-body').innerText(), /2pt/);
      if (index === 0) await page.screenshot({ path: path.join(output, `${version}-04-release-detail.jpg`), type: 'jpeg', quality: 60, animations: 'disabled', style: '#toast { visibility: hidden !important; }' });
      await page.keyboard.press('Escape');
      await page.locator('#detail-dialog').waitFor({ state: 'hidden' });
      assert.equal(await opener.evaluate(el => el === document.activeElement), true);
      assert.equal(await page.evaluate(() => scrollY), scrollBefore);
      assert.equal(await page.getByRole('tab', { name: 'リリース', exact: true }).getAttribute('aria-selected'), 'true');
      assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY), saved);
      assert.ok(!modules.some(url => url.includes('milestone-schedule')), 'schedule engine is not imported by the UI');
      run.scenarios.push({ ...screen, screenshot, releaseText, horizontalOverflow, keyboardOpenClose: true, focusAndScrollRestored: true, storageUnchanged: true, scheduleModuleRequested: false });
      await context.close();
    }
    runs.push(run);
  }
  for (let i = 0; i < screens.length; i++) assert.equal(runs[0].scenarios[i].releaseText, runs[1].scenarios[i].releaseText);
  assert.deepEqual(errors, []);
  const result = { runs, pageErrors: errors, fixtureOnly: true, scope: 'Existing release screen; no schedule UI, GitHub access, production storage, or user-comprehension test' };
  await writeFile(logPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ versions: runs.map(r => ({ version: r.version, head: r.head })), scenarios: 6, screenshots: 8, pageErrors: errors, logPath }));
} finally {
  await browser.close();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}
