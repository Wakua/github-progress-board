// Optional Chromium QA with mocked gh REST pages; no GitHub credentials/network.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createProgressServer } from '../server.mjs';
import { createGithubRefresher } from '../scripts/local-github-refresh.mjs';
import { qaWorkspace, mockGh, QA_REPOSITORIES } from './local-github-fixture.mjs';
import { STORAGE_KEY } from '../dist/workspace.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = path.join(process.env.QA_ARTIFACT_DIR || '/tmp/progress-tool-browser-qa', 'local-github');
const sourceFiles = ['dist/app.mjs', 'dist/engine.mjs', 'dist/workspace.mjs', 'dist/github-snapshot.mjs', 'dist/local-github.mjs', 'dist/index.html', 'dist/projects.css', 'dist/my-work.css', 'dist/style.css', 'dist/dark.css', 'dist/goals.css', 'dist/list.css', 'server.mjs', 'scripts/local-github-refresh.mjs', 'scripts/github-planning-fetch.mjs', 'dist/github-planning.mjs', 'dist/github-planning-view.mjs', 'dist/github-work.mjs', 'dist/github-planning.css', 'scripts/fetch-github-snapshot.mjs', 'tests/local-github.test.mjs', 'tests/local-github-browser-qa.mjs', 'tests/local-github-fixture.mjs', 'package.json'];
const testedHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const testedWorkingTreeClean = !execFileSync('git', ['status', '--porcelain', '--', ...sourceFiles], { encoding: 'utf8' }).trim();
const sourceBlobs = () => Object.fromEntries(execFileSync('git', ['hash-object', ...sourceFiles], { encoding: 'utf8' }).trim().split('\n').map((hash, index) => [sourceFiles[index], hash]));
const testedBlobs = sourceBlobs();
await mkdir(artifacts, { recursive: true });
let version = 1, mode = 'ok', reads = 0, gate = null, unblock = null, prState = 'draft';
const gh = mockGh({ version: () => version, beforeRead: async () => {
  reads++; if (gate) await gate;
  if (mode === 'fail') throw new Error('QA SECRET stderr must never reach browser');
} });
const server = createProgressServer({ repositories: QA_REPOSITORIES, refresher: createGithubRefresher({ repositories: QA_REPOSITORIES, cacheMs: 0, run: async (...args) => {
  const result = await gh(...args), pulls = args[1].at(-1).includes('/pulls?');
  let records = JSON.parse(result.stdout);
  if (prState === 'missing' && Array.isArray(records)) records = records.filter(record => !pulls && !record.pull_request);
  else if (pulls && prState === 'merged') for (const record of records) Object.assign(record, {
    title: 'QA Merged PR', state: 'closed', draft: false,
    closed_at: '2026-10-03T12:00:00Z', merged_at: '2026-10-03T12:00:00Z', updated_at: '2026-10-03T12:00:00Z',
  });
  return { stdout: JSON.stringify(records) };
} }) });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const attacker = http.createServer((req, res) => res.end('<html><body>QA different origin</body></html>'));
await new Promise(resolve => attacker.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const errors = [], checks = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
const page = await context.newPage();
await page.clock.install();
const workspace = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
const raw = () => page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
const capture = name => page.screenshot({ path: path.join(artifacts, name), fullPage: true, animations: 'disabled', style: '#toast { visibility: hidden !important; }' });
const saved = () => page.waitForFunction(() => !document.querySelector('main').hasAttribute('aria-busy'));
const close = async () => { if (await page.locator('#detail-dialog').isVisible()) await page.locator('#close-dialog').click(); };
// snapshot・取得状態・再取得は「登録・取込」の詳細に置く。
const openManage = async () => { await close(); await page.getByRole('button', { name: '登録・取込', exact: true }).click(); await page.locator('#github-snapshot').waitFor(); };
const openManualWork = async () => { const manual = page.locator('#my-work-panel .manual-work'); if (!await manual.evaluate(element => element.open)) await manual.locator(':scope > summary').click(); };
const switchTo = async id => { await close(); await page.locator('#project-switch').selectOption(id || ''); await saved(); };
const updated = async expected => page.waitForFunction(({ key, expected }) => {
  const workspace = JSON.parse(localStorage.getItem(key));
  return workspace?.projects.filter(project => project.id !== 'other').every(project => project.githubSnapshot?.items.some(item => item.title === `QA GitHub Issue v${expected}`));
}, { key: STORAGE_KEY, expected });
try {
  await page.goto(base); await page.locator('.workspace-empty').waitFor();
  assert.equal(await raw(), null); assert.equal(reads, 0);
  await page.evaluate(({ key, data }) => localStorage.setItem(key, JSON.stringify(data)), { key: STORAGE_KEY, data: qaWorkspace() });
  await page.reload(); await updated(1);
  assert.equal(await page.getByRole('tab', { name: '自分の作業', exact: true }).getAttribute('aria-selected'), 'true');
  await openManualWork();
  await page.locator('#my-work-panel').getByRole('button', { name: 'QA担当', exact: true }).click();
  await page.getByRole('tab', { name: 'イテレーション', exact: true }).click();
  const first = await workspace(), original = qaWorkspace();
  first.projects.forEach((project, i) => assert.deepEqual(project.data, original.projects[i].data));
  assert.equal(first.projects[3].githubSnapshot, undefined);
  assert.ok(!JSON.stringify(first).includes('csrfToken')); assert.ok(!JSON.stringify(first).includes('SECRET'));
  await openManage();
  await page.locator('[data-snapshot-kind="issue"] summary').click();
  assert.match(await page.locator('#github-snapshot').innerText(), /自動更新済み/);
  await capture('automatic-registered-project.png');
  checks.push('初回は無保存・取得なし。既存登録3repoだけをGETし自動保存、手動計画・他repo・未知値を保持する');

  // A configured project with no snapshot must show an initial failure without tab navigation.
  const initialFailure = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const initialPage = await initialFailure.newPage();
  initialPage.on('pageerror', error => errors.push(error.message));
  let initialReads = 0;
  await initialPage.route('**/api/local-github', async route => {
    await new Promise(resolve => setTimeout(resolve, 100));
    await route.continue();
  });
  await initialPage.route('**/api/github/refresh', async route => {
    initialReads++;
    await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"gh_failed"}' });
  });
  try {
    await initialPage.goto(base);
    const initialWorkspace = qaWorkspace(); initialWorkspace.projects = initialWorkspace.projects.slice(0, 1);
    await initialPage.evaluate(({ key, data }) => { localStorage.setItem(key, JSON.stringify(data)); }, { key: STORAGE_KEY, data: initialWorkspace });
    await initialPage.reload();
    const status = initialPage.locator('#my-work-panel [data-local-github]');
    await status.filter({ hasText: 'GitHubを取得できません' }).waitFor();
    const retry = status.getByRole('button', { name: 'GitHubを再取得', exact: true });
    assert.equal(await retry.isEnabled(), true); assert.equal(initialReads, 1);
    assert.deepEqual(await initialPage.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY), initialWorkspace);
    await initialPage.screenshot({ path: path.join(artifacts, 'initial-failure-with-retry.png'), fullPage: true });
    await retry.click();
    await status.filter({ hasText: 'GitHubを取得できません' }).waitFor();
    assert.equal(initialReads, 2);
    checks.push('snapshotのない登録済みrepositoryで初回取得が失敗しても、タブを切り替えずにエラーと再取得を表示し、手動計画を保持する');
  } finally { await initialFailure.close(); await page.bringToFront(); }

  // Start a refresh, then edit while gh is waiting. The drawer must survive it.
  version = 2; let release; gate = new Promise(resolve => { release = resolve; unblock = resolve; });
  await page.locator('#detail-dialog').getByRole('button', { name: 'GitHubを再取得', exact: true }).click();
  await page.locator('#detail-dialog [data-local-github]').filter({ hasText: '取得中' }).waitFor();
  await close();
  await page.locator('#iterations-board [data-action="task"][data-id="task"]').first().click();
  await page.locator('#task-estimate').fill('2.5');
  await page.getByRole('button', { name: 'Estimateを更新', exact: true }).click(); await saved();
  await page.locator('#task-estimate').fill('7.5'); await page.locator('#task-owner').fill('QA未保存の担当');
  release(); gate = null; await updated(2);
  assert.equal(await page.locator('#task-estimate').inputValue(), '7.5');
  assert.equal(await page.locator('#task-owner').inputValue(), 'QA未保存の担当');
  assert.equal((await workspace()).projects[0].data.tasks[0].estimatePoints, 2.5);
  assert.equal((await workspace()).projects[0].data.tasks[0].owner, 'QA担当');
  assert.equal((await workspace()).projects[0].data.tasks[0].status, 'todo');
  await capture('manual-draft-preserved.png');
  checks.push('取得中の手動保存2.5ptを保持。取得後も未保存7.5pt・担当欄、drawer、Closed≠done、依存と確認条件を保持する');
  await close();

  // Failure preserves the complete previously saved workspace, including facts.
  const beforeFailure = await raw(); mode = 'fail';
  await openManage();
  await page.locator('#detail-dialog').getByRole('button', { name: 'GitHubを再取得', exact: true }).click();
  await page.locator('#detail-dialog [data-local-github]').filter({ hasText: '更新できません' }).waitFor();
  assert.equal(await raw(), beforeFailure);
  assert.ok(!(await page.locator('#detail-dialog [data-local-github]').innerText()).includes('SECRET'));
  await capture('failed-refresh-preserves-snapshot.png');
  mode = 'ok'; version = 3; await page.locator('#detail-dialog').getByRole('button', { name: 'GitHubを再取得', exact: true }).click(); await updated(3);
  await page.locator('#github-snapshot').filter({ hasText: 'QA GitHub Issue v3' }).waitFor();
  checks.push('gh失敗時は旧snapshot・手動計画のJSONが一字も変わらず、認証情報やstderrを出さず再取得で復帰する。開いている登録・取込のsnapshot一覧も更新する');

  const switched = await workspace();
  for (let i = 0; i < 12; i++) await switchTo(['alpha', 'beta', 'other', 'progress'][i % 4]);
  assert.equal((await workspace()).selectedProjectId, 'progress');
  (await workspace()).projects.forEach((project, i) => assert.deepEqual(project, switched.projects[i]));
  await page.reload(); await openManage();
  await page.waitForFunction(() => document.querySelector('[data-local-github]')?.textContent.includes('自動更新済み'));
  assert.equal((await workspace()).projects[0].data.tasks[0].estimatePoints, 2.5);
  checks.push('同番号Issueを持つ4repoを12回切り替えても混入しない。再読込後に手動計画を復元しsnapshotを再取得する');

  await close(); await page.getByRole('tab', { name: '自分の作業', exact: true }).click();
  version = 4; await page.clock.fastForward(5 * 60 * 1000); await updated(4);
  assert.equal((await workspace()).projects[0].data.tasks[0].estimatePoints, 2.5);
  assert.equal(await page.getByRole('tab', { name: '自分の作業', exact: true }).getAttribute('aria-selected'), 'true');
  await openManualWork();
  assert.equal(await page.locator('#my-work-panel').getByRole('button', { name: 'QA担当', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('tab', { name: 'イテレーション', exact: true }).click();
  checks.push('Chromiumの時計を5分進めると、自分の作業タブでも定期取得がIssueを反映し、表示タブ・担当の絞り込み・手動見積を保持する');

  // Real browser requests from another origin must not launch gh.
  const evil = await context.newPage(); await evil.goto(`http://127.0.0.1:${attacker.address().port}`);
  const readsBefore = reads;
  const outcomes = await evil.evaluate(async base => {
    const results = [];
    for (const options of [{ headers: { 'X-Progress-Client': '1' } }, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Progress-CSRF': 'a'.repeat(64) }, body: JSON.stringify({ repository: 'https://github.com/qa-local/board' }) }]) {
      try { const response = await fetch(base + (options.method ? '/api/github/refresh' : '/api/local-github'), options); results.push(response.status); } catch { results.push('blocked'); }
    }
    return results;
  }, base);
  assert.deepEqual(outcomes, ['blocked', 'blocked']); assert.equal(reads, readsBefore);
  await evil.close(); await page.bringToFront();
  checks.push('Chromiumの別origin GET/POSTはCORS/preflightで拒否され、ghが一度も起動しない');

  // Another tab owns its change. The waiting refresh may not overwrite it.
  let releaseStale; gate = new Promise(resolve => { releaseStale = resolve; unblock = resolve; }); version = 5;
  await openManage();
  await page.locator('#detail-dialog').getByRole('button', { name: 'GitHubを再取得', exact: true }).click();
  await page.locator('#detail-dialog [data-local-github]').filter({ hasText: '取得中' }).waitFor();
  const second = await context.newPage(); await second.goto(base);
  const newerRaw = await second.evaluate(key => { const value = JSON.parse(localStorage.getItem(key)); value.projects[0].data.tasks[0].evidence = 'QA別タブの証拠'; const serialized = JSON.stringify(value); localStorage.setItem(key, serialized); return serialized; }, STORAGE_KEY);
  await page.locator('#storage-warning').waitFor(); releaseStale(); gate = null;
  await page.locator('#detail-dialog [data-local-github]').filter({ hasText: '保存を見送り' }).waitFor();
  assert.equal(await raw(), newerRaw);
  assert.equal(await page.locator('#detail-dialog').getByRole('button', { name: 'GitHubを再取得', exact: true }).isDisabled(), true);
  await capture('stale-tab-keeps-newer-data.png'); await second.close();
  checks.push('別タブの保存後に到着したsnapshotを拒否し、新しい手動証拠を保持、古いタブの編集・再取得を停止する');

  // Keep a GitHub detail open while the saved facts change or disappear.
  await page.evaluate(({ key, data }) => {
    localStorage.clear(); localStorage.setItem(key, JSON.stringify(data));
    localStorage.setItem('progress-tool.view.v1', JSON.stringify({ tab: 'iterations' }));
  }, { key: STORAGE_KEY, data: qaWorkspace() });
  version = 6; await page.reload(); await updated(6); await openManage();
  await page.locator('[data-action="github-item"][data-id="pull_request:8"]').click();
  assert.equal(await page.locator('#drawer-body .github-state').innerText(), 'Draft / Open');
  await capture('github-detail-before-refresh.png');
  const beforeDetailRefresh = (await workspace()).projects[0].githubSnapshot.fetchedAt;
  prState = 'merged'; version = 7; await page.clock.fastForward(5 * 60 * 1000); await updated(7);
  assert.equal(await page.locator('#detail-dialog').isVisible(), true);
  assert.equal(await page.locator('#drawer-title').innerText(), 'PR #8 QA Merged PR');
  assert.equal(await page.locator('#drawer-body .github-state').innerText(), 'Merged');
  assert.match(await page.locator('#drawer-body').innerText(), /2026-10-03 12:00:00 UTC/);
  assert.notEqual((await workspace()).projects[0].githubSnapshot.fetchedAt, beforeDetailRefresh);
  await capture('github-detail-after-refresh.png');
  checks.push('GitHub詳細を開いたまま定期取得すると、PRのタイトル・Merged状態・日時を更新し、drawerを保持する');
  prState = 'missing'; version = 8; await page.clock.fastForward(5 * 60 * 1000); await updated(8);
  assert.equal(await page.locator('#detail-dialog').isVisible(), true);
  assert.equal(await page.locator('#drawer-title').innerText(), 'PR #8');
  assert.match(await page.locator('#drawer-body').innerText(), /最新snapshotにこのIssue・PRは含まれていません/);
  assert.equal(await page.locator('#drawer-body .github-state').count(), 0);
  await capture('github-detail-removed.png'); await close();
  checks.push('開いたPRが最新snapshotから消えた場合は、古い状態を残さず未掲載の表示へ更新する');

  // Registration and an explicit retry during another fetch must be processed.
  const single = qaWorkspace(); single.projects = single.projects.slice(0, 1);
  await page.evaluate(({ key, data }) => { localStorage.clear(); localStorage.setItem(key, JSON.stringify(data)); localStorage.setItem('progress-tool.view.v1', JSON.stringify({ tab: 'iterations' })); }, { key: STORAGE_KEY, data: single });
  prState = 'draft'; version = 9; await page.reload(); await updated(9); await openManage();
  let releaseRegistration; gate = new Promise(resolve => { releaseRegistration = resolve; unblock = resolve; }); version = 10;
  await page.locator('#detail-dialog').getByRole('button', { name: 'GitHubを再取得', exact: true }).click();
  await page.locator('#detail-dialog [data-local-github]').filter({ hasText: '取得中' }).waitFor();
  await page.getByRole('button', { name: 'プロジェクトを登録', exact: true }).click();
  await page.getByLabel('プロジェクト名', { exact: true }).fill('取得中に登録したAlpha（QA用）');
  await page.getByLabel('repository URL（任意）').fill(QA_REPOSITORIES[0]);
  await page.getByRole('button', { name: '登録して保存', exact: true }).click(); await saved();
  await page.locator('#drawer-title').filter({ hasText: '登録・取込' }).waitFor();
  assert.match(await page.locator('#drawer-project').innerText(), /取得中に登録したAlpha/);
  const addedProjectId = (await workspace()).selectedProjectId;
  await capture('registration-during-refresh-before.png');
  await page.locator('#detail-dialog').getByRole('button', { name: 'GitHubを再取得', exact: true }).click();
  releaseRegistration(); gate = null; await updated(10);
  assert.equal((await workspace()).selectedProjectId, addedProjectId);
  assert.equal((await workspace()).projects.find(project => project.id === addedProjectId).githubSnapshot.projectId, addedProjectId);
  assert.deepEqual((await workspace()).projects[0].data, single.projects[0].data);
  await capture('registration-during-refresh-after.png');
  checks.push('取得中に別repoを登録し再取得を押すと、定期更新を待たず新projectIdへ反映し、手動計画と選択を保持する');

  assert.deepEqual(errors, []); assert.deepEqual(sourceBlobs(), testedBlobs);
  const evidence = { testedAt: new Date().toISOString(), testedHead, testedWorkingTreeClean, sourceFiles: testedBlobs, githubTransport: 'mock gh REST pages (fabricated QA data)', runtime: 'real loopback Node + Chromium', checks, pageErrors: errors, screenshots: ['automatic-registered-project.png', 'initial-failure-with-retry.png', 'manual-draft-preserved.png', 'failed-refresh-preserves-snapshot.png', 'stale-tab-keeps-newer-data.png', 'github-detail-before-refresh.png', 'github-detail-after-refresh.png', 'github-detail-removed.png', 'registration-during-refresh-before.png', 'registration-during-refresh-after.png'] };
  await writeFile(path.join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ testedHead, testedWorkingTreeClean, checks: checks.length, pageErrors: errors, artifacts }) + '\n');
} finally {
  unblock?.(); gate = null; await browser.close();
  server.closeAllConnections(); attacker.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => attacker.close(resolve))]);
}
