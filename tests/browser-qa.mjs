// Optional integration QA. Playwright is provided by the cloud environment;
// the application and npm test require no third-party packages.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { STORAGE_KEY, BACKUP_KEY, RECOVERY_KEY, emptyWorkspace } from '../dist/workspace.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = process.env.QA_ARTIFACT_DIR || '/tmp/progress-tool-browser-qa';
const testedHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceFiles = ['dist/app.mjs', 'dist/local-github.mjs', 'dist/github-planning.mjs', 'dist/github-planning-view.mjs', 'dist/github-planning.css', 'dist/engine.mjs', 'dist/workspace.mjs', 'dist/github-snapshot.mjs', 'dist/github-snapshot.json', 'dist/index.html', 'dist/projects.css', 'dist/my-work.css', 'dist/style.css', 'dist/dark.css', 'dist/goals.css', 'dist/list.css', 'server.mjs', 'scripts/fetch-github-snapshot.mjs', 'tests/browser-qa.mjs', 'tests/snapshot-browser-qa.mjs', 'tests/iteration-browser-qa.mjs', 'tests/github-snapshot.test.mjs', 'tests/snapshot-fixture.mjs', 'tests/engine.test.mjs', 'tests/workspace.test.mjs', 'package.json'];
const testedWorkingTreeClean = execFileSync('git', ['status', '--porcelain', '--', ...sourceFiles], { encoding: 'utf8' }).trim() === '';
const sourceBlobs = () => Object.fromEntries(execFileSync('git', ['hash-object', ...sourceFiles], { encoding: 'utf8' }).trim().split('\n').map((hash, index) => [sourceFiles[index], hash]));
const testedBlobs = sourceBlobs();
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
// すべての保存・復旧用contextで実gh取得を停止する。別タブも同じ模擬応答を使う。
async function isolatedContext(options = {}) {
  const context = await browser.newContext(options);
  await context.route(/\/api\/(?:local-github|github\/refresh)(?:\?|$)/, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'gh_unavailable' }) }));
  return context;
}
const context = await isolatedContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [], checks = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
page.on('pageerror', error => errors.push(error.message));
const url = process.env.QA_BASE_URL || 'http://127.0.0.1:4319/';
const capture = (name, fullPage = true) => page.screenshot({ path: path.join(artifacts, name), fullPage, animations: 'disabled', style: '#toast { visibility: hidden !important; }' });
const workspace = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
const saved = async () => page.waitForFunction(() => !document.querySelector('main').hasAttribute('aria-busy'));
const click = async name => { if (['目標を登録', '作業を登録'].includes(name)) { await close(); await page.getByRole('button', { name: '登録・取込', exact: true }).click(); } await page.getByRole('button', { name, exact: true }).click(); await saved(); };
const close = async () => { if (await page.locator('#detail-dialog').isVisible()) await page.locator('#close-dialog').click(); };
// 作業の一覧はイテレーション、登録は「登録・取込」から開く。
const showIterations = async (target = page) => { const tab = target.getByRole('tab', { name: 'イテレーション', exact: true }); if (await tab.getAttribute('aria-selected') !== 'true') await tab.click(); };
const switchTo = async projectId => { await close(); await page.locator('#project-switch').selectOption(projectId || ''); await saved(); };
async function register(name, repositoryUrl) {
  await close(); await page.getByRole('button', { name: '登録・取込', exact: true }).click(); await page.locator('#drawer-body').getByRole('button', { name: 'プロジェクトを登録', exact: true }).click();
  await page.getByLabel('プロジェクト名', { exact: true }).fill(name);
  if (repositoryUrl) await page.getByLabel('repository URL（任意）').fill(repositoryUrl);
  await click('登録して保存');
  assert.equal(await page.locator('#drawer-title').innerText(), '登録・取込');
  await close();
  return (await workspace(page)).selectedProjectId;
}
async function goal(title, number = 1) {
  await click('目標を登録'); await page.getByLabel('目標名', { exact: true }).fill(title);
  await page.getByLabel('Issue番号（任意）').fill(String(number)); await click('登録して保存'); await close();
}
async function task(title, number = 7, status = 'unknown') {
  await click('作業を登録'); await page.getByLabel('作業名', { exact: true }).fill(title);
  await page.getByLabel('Issue番号（任意）').fill(String(number)); await page.getByLabel('状態', { exact: true }).selectOption(status);
  await page.getByLabel('完了条件（任意・1行に1件）').fill('QAの確認'); await click('登録して保存'); await close();
}
async function openTask(title) {
  await close(); await page.locator('.period-task-name').getByRole('button', { name: title, exact: true }).click();
}
try {
  await page.goto(url);
  await page.getByRole('heading', { name: '管理するプロジェクトを登録' }).waitFor();
  assert.equal(await workspace(page), null);
  await capture('empty.jpg');
  checks.push('初回は空の一覧で、架空の進捗や自動保存がない');

  const alpha = await register('Alpha', 'https://github.com/qa-fixture/alpha');
  assert.equal(await page.getByRole('tab', { name: '自分の作業', exact: true }).getAttribute('aria-selected'), 'true');
  await showIterations();
  await goal('QA：Alphaの目標'); await task('QA：Alphaの作業');
  await openTask('QA：Alphaの作業');
  assert.match(await page.locator('#drawer-project').innerText(), /Alpha/);
  assert.match(await page.locator('.issue-breadcrumbs').innerText(), /qa-fixture\/alpha #7/);
  assert.equal(await page.locator('#task-estimate').inputValue(), '');
  assert.equal(await page.locator('#task-iteration').inputValue(), '');
  await click('未着手として確認'); await click('作業を開始');
  await page.locator('#task-estimate').fill('2.5'); await click('Estimateを更新');
  await page.locator('#task-owner').fill('QA担当'); await click('担当を更新');
  await page.locator('#task-evidence').fill('QA用の証拠 Alpha'); await click('根拠を記録');
  await page.locator('[data-criterion]').check(); await saved(); await click('確認待ちにする');
  const alphaData = (await workspace(page)).projects.find(project => project.id === alpha);
  await capture('alpha-detail.jpg', false);

  const beta = await register('Beta', 'https://github.com/qa-fixture/beta');
  await goal('QA：Betaの目標'); await task('QA：Betaの作業', 7, 'todo'); await task('QA：Betaの後続', 8, 'todo');
  await openTask('QA：Betaの後続');
  const betaTaskId = (await workspace(page)).projects.find(project => project.id === beta).data.tasks[0].id;
  await page.locator('#task-deps').selectOption([betaTaskId]); await click('前提を更新');
  await openTask('QA：Betaの作業');
  await page.locator('#wait-reason').fill('QA：判断待ち'); await click('待ちを登録');
  const tool = await register('progress-tool', 'https://github.com/Wakua/github-progress-board');
  assert.equal((await workspace(page)).projects.find(project => project.id === tool).data.tasks.length, 0);
  await switchTo(null);
  assert.equal(await page.locator('.project-card').count(), 3);
  assert.match(await page.locator(`[data-project-card="${alpha}"]`).innerText(), /確認待ち 1件/);
  assert.match(await page.locator(`[data-project-card="${beta}"]`).innerText(), /要対応 1件/);
  assert.equal(await page.locator('#project-detail').isVisible(), false);
  await capture('overview.jpg');
  checks.push('Alpha・Beta・本ツールの登録、全体一覧と選択時の詳細を表示');

  for (let index = 0; index < 12; index++) await switchTo(index % 2 ? beta : alpha);
  await page.reload(); await page.locator('.period-task-name').first().waitFor();
  assert.equal(await page.locator('#project-switch').inputValue(), beta);
  let snapshot = await workspace(page);
  assert.deepEqual(snapshot.projects.find(project => project.id === alpha), alphaData);
  const betaData = snapshot.projects.find(project => project.id === beta).data;
  assert.equal(betaData.tasks[0].issueNumber, alphaData.data.tasks[0].issueNumber);
  assert.equal(betaData.tasks[0].estimatePoints, null);
  assert.equal(betaData.tasks[0].evidence, '');
  assert.equal(betaData.tasks[1].deps[0], betaTaskId);
  checks.push('同じIssue #7を混同せず、12回の切替と再読込後も条件・証拠・担当・依存・状態を保持');

  const downloadEvent = page.waitForEvent('download'); await page.locator('#export-workspace').click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'progress-tool-workspace.json');
  assert.deepEqual(JSON.parse(await readFile(await download.path(), 'utf8')), await workspace(page));
  checks.push('JSON書出しのファイル内容が保存済みの全プロジェクトと一致する');

  await task('QA：重複Issue', 7, 'todo');
  assert.match(await page.locator('#panel-error').innerText(), /Issue番号が重複/);
  assert.equal((await workspace(page)).projects.find(project => project.id === beta).data.tasks.length, 2);
  await close();
  await openTask('QA：Betaの作業');
  const nextId = betaData.tasks[1].id;
  await page.locator('#task-deps').selectOption([nextId]); await click('前提を更新');
  assert.match(await page.locator('#panel-error').innerText(), /循環/);
  assert.deepEqual((await workspace(page)).projects.find(project => project.id === beta).data.tasks[0].deps, []);
  checks.push('同一プロジェクトの重複Issue・循環する依存を保存しない');

  const beforeQuota = await workspace(page);
  await page.evaluate(key => {
    window.qaSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (target, value) { if (target === key) throw new DOMException('QA quota', 'QuotaExceededError'); return window.qaSetItem.call(this, target, value); };
  }, STORAGE_KEY);
  await page.locator('[data-criterion]').check(); await saved();
  assert.match(await page.locator('#panel-error').innerText(), /保存できません/);
  assert.equal(await page.locator('[data-criterion]').isChecked(), false);
  assert.deepEqual(await workspace(page), beforeQuota);
  await page.evaluate(() => { Storage.prototype.setItem = window.qaSetItem; });
  await page.locator('#task-evidence').fill('QA用の証拠 Beta'); await click('根拠を記録');
  checks.push('保存容量エラーで保存済みデータとチェック表示を維持し、再試行で保存できる');

  const stale = await context.newPage(); await stale.goto(url); await stale.locator('#project-switch').waitFor();
  await stale.locator('.period-task-name').getByRole('button', { name: 'QA：Betaの作業', exact: true }).click();
  await page.locator('#task-estimate').fill('4.5'); await click('Estimateを更新');
  await stale.locator('#storage-warning').waitFor();
  assert.match(await stale.locator('#storage-problem').innerText(), /別のタブ/);
  assert.match(await stale.locator('#panel-error').innerText(), /別のタブ/);
  await stale.locator('#close-dialog').click();
  await stale.getByRole('button', { name: '登録・取込', exact: true }).click();
  assert.equal(await stale.locator('#drawer-body').getByRole('button', { name: 'プロジェクトを登録', exact: true }).isDisabled(), true);
  await stale.locator('#close-dialog').click();
  await stale.locator('#project-switch').selectOption(alpha);
  await stale.locator('#project-name').filter({ hasText: 'Alpha' }).waitFor();
  assert.equal((await workspace(page)).selectedProjectId, beta);
  await stale.reload(); await stale.locator('#project-name').filter({ hasText: 'Beta' }).waitFor();
  await stale.getByRole('button', { name: '登録・取込', exact: true }).click();
  assert.equal(await stale.locator('#drawer-body').getByRole('button', { name: 'プロジェクトを登録', exact: true }).isDisabled(), false);
  await stale.close();
  checks.push('別タブの更新を検出して編集を停止し、閲覧切替は保存せず、再読込で再開');

  // Regression coverage: keep drafts while
  // updating other fields and return to the original workload scope.
  const draftContext = await isolatedContext(); const draftPage = await draftContext.newPage();
  draftPage.on('pageerror', error => errors.push(error.message));
  await draftPage.goto(url);
  const draftFixture = structuredClone(beforeQuota);
  draftFixture.selectedProjectId = beta;
  const fixtureData = draftFixture.projects.find(project => project.id === beta).data;
  fixtureData.iterations.push({ id: 'qa-period', projectId: beta, title: 'QA期間', startDate: null, durationDays: null });
  fixtureData.tasks[0].owner = 'QA元'; fixtureData.tasks[0].waitReason = '';
  fixtureData.tasks[1].deps = [];
  fixtureData.tasks.push({ ...structuredClone(fixtureData.tasks[1]), id: 'qa-extra', title: 'QA：追加の前提', issueNumber: 9 });
  fixtureData.order.push('qa-extra');
  fixtureData.tasks.forEach(task => { task.iterationId = 'qa-period'; });
  await draftPage.evaluate(({ key, value }) => { localStorage.setItem(key, JSON.stringify(value)); localStorage.setItem('progress-tool.view.v1', JSON.stringify({ tab: 'iterations' })); }, { key: STORAGE_KEY, value: draftFixture });
  await draftPage.reload();
  const draftSaved = () => draftPage.waitForFunction(() => !document.querySelector('main').hasAttribute('aria-busy'));
  const draftClick = async name => { await draftPage.getByRole('button', { name, exact: true }).click(); await draftSaved(); };
  await draftPage.locator('#goal-list').getByRole('button').click(); await draftClick('期間の内訳');
  await draftPage.locator('#drawer-body .period-summary').click();
  await draftPage.locator('#drawer-body [data-workload-owner="QA元"]').click();
  await draftClick('QA：Betaの作業');
  await draftPage.locator('#task-evidence').fill('未保存の根拠');
  await draftPage.locator('#wait-reason').fill('未保存の待ち');
  await draftPage.locator('#task-estimate').fill('7.5');
  await draftPage.locator('#task-criteria').fill('QAの確認\n追加条件');
  const selectedDeps = [fixtureData.tasks[1].id, 'qa-extra'];
  await draftPage.locator('#task-deps').selectOption(selectedDeps);
  await draftPage.locator('#task-owner').fill('QA別'); await draftClick('担当を更新');
  async function assertDrafts() {
    assert.equal(await draftPage.locator('#task-evidence').inputValue(), '未保存の根拠');
    assert.equal(await draftPage.locator('#wait-reason').inputValue(), '未保存の待ち');
    assert.equal(await draftPage.locator('#task-estimate').inputValue(), '7.5');
    assert.equal(await draftPage.locator('#task-criteria').inputValue(), 'QAの確認\n追加条件');
    assert.deepEqual(await draftPage.locator('#task-deps').evaluate(input => [...input.selectedOptions].map(option => option.value)), selectedDeps);
  }
  await assertDrafts(); await draftClick('理由・前提を確認'); await draftClick('作業を開く'); await assertDrafts();
  const committedTask = (await workspace(draftPage)).projects.find(project => project.id === beta).data.tasks[0];
  assert.equal(committedTask.owner, 'QA別'); assert.equal(committedTask.evidence, '');
  assert.equal(committedTask.estimatePoints, null); assert.deepEqual(committedTask.deps, []);
  await draftPage.locator('#back-workload').click();
  assert.equal(await draftPage.locator('#drawer-title').innerText(), 'QA元の未完了作業');
  assert.match(await draftPage.locator('.panel-goal').innerText(), /QA期間.*QA：Betaの目標/);
  await draftPage.screenshot({ path: path.join(artifacts, 'merged-workload-return.jpg'), style: '#toast { visibility: hidden !important; }' });
  await draftPage.locator('#close-dialog').click();
  await draftPage.locator('#project-switch').selectOption(alpha); await draftSaved();
  await draftPage.locator('#project-switch').selectOption(beta); await draftSaved();
  await draftPage.locator('[data-period-id="qa-period"] > summary').click();
  await draftPage.locator('.period-task-name').getByRole('button', { name: 'QA：Betaの作業', exact: true }).click();
  assert.equal(await draftPage.locator('#task-evidence').inputValue(), '');
  assert.deepEqual(await draftPage.locator('#task-deps').evaluate(input => [...input.selectedOptions].map(option => option.value)), []);

  const locker = await draftContext.newPage(); await locker.goto(url);
  const holdSave = async () => {
    await locker.evaluate(key => { window.qaRelease = null; navigator.locks.request(key, () => new Promise(resolve => { window.qaRelease = resolve; })); }, STORAGE_KEY);
    await locker.waitForFunction(() => typeof window.qaRelease === 'function');
  };
  await holdSave();
  await draftPage.locator('#task-evidence').fill('保存待ち前の未保存入力');
  await draftPage.locator('#task-owner').fill('QA担当2');
  await draftPage.getByRole('button', { name: '担当を更新', exact: true }).click();
  await draftPage.waitForFunction(() => document.querySelector('main').getAttribute('aria-busy') === 'true');
  assert.equal(await draftPage.locator('#task-evidence').isDisabled(), true);
  assert.equal(await draftPage.locator('[data-criterion]').isDisabled(), true);
  await locker.evaluate(() => window.qaRelease()); await draftSaved();
  assert.equal(await draftPage.locator('#task-evidence').inputValue(), '保存待ち前の未保存入力');
  assert.equal(await draftPage.locator('#task-evidence').isDisabled(), false);
  assert.equal((await workspace(draftPage)).projects.find(project => project.id === beta).data.tasks[0].evidence, '');
  checks.push('保存待ち中は入力を一時停止し、元の未保存入力を保持して完了後に再開する');

  await holdSave(); const beforeClosedFailure = await workspace(draftPage);
  await draftPage.evaluate(key => {
    window.qaSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (target, value) { if (target === key) throw new DOMException('QA quota', 'QuotaExceededError'); return window.qaSetItem.call(this, target, value); };
  }, STORAGE_KEY);
  await draftPage.locator('[data-criterion]').check();
  await draftPage.waitForFunction(() => document.querySelector('main').getAttribute('aria-busy') === 'true');
  await draftPage.locator('#close-dialog').click();
  await locker.evaluate(() => window.qaRelease()); await draftSaved();
  await draftPage.locator('#toast').filter({ hasText: '保存できません' }).waitFor();
  assert.equal(await draftPage.locator('#detail-dialog').isVisible(), false);
  assert.deepEqual(await workspace(draftPage), beforeClosedFailure);
  await draftPage.evaluate(() => { Storage.prototype.setItem = window.qaSetItem; });
  await locker.close();
  checks.push('保存待ち中に詳細を閉じ、その保存が失敗しても保存済みデータを保持し、ページエラーを出さない');
  await draftContext.close();
  checks.push('未保存入力を保持し、他項目の保存・詳細移動で復元、元の期間・担当・目標の負荷へ戻り、プロジェクト切替時に混入しない');

  await close(); await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture('mobile-beta.jpg');
  await openTask('QA：Betaの作業');
  assert.equal(await page.evaluate(() => document.querySelector('#detail-dialog').scrollWidth <= document.querySelector('#detail-dialog').clientWidth), true);
  await close(); await switchTo(null);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture('mobile-overview.jpg');
  checks.push('390px幅の全体一覧・選択したプロジェクト・詳細で横方向のはみ出しがない');

  await page.setViewportSize({ width: 1440, height: 1000 });
  const backupRaw = await page.evaluate(key => localStorage.getItem(key), BACKUP_KEY);
  await page.evaluate(key => localStorage.setItem(key, '{QA broken'), STORAGE_KEY); await page.reload();
  await page.locator('#storage-warning').waitFor();
  await page.getByRole('button', { name: '登録・取込', exact: true }).click();
  assert.equal(await page.locator('#drawer-body').getByRole('button', { name: 'プロジェクトを登録', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY), '{QA broken');
  await capture('corrupt-backup.jpg');
  await close(); await page.locator('#recover-backup').click(); await page.locator('#storage-warning').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(key => localStorage.getItem(key), RECOVERY_KEY), '{QA broken');
  assert.deepEqual(await workspace(page), JSON.parse(backupRaw));
  await page.getByRole('button', { name: '登録・取込', exact: true }).click();
  assert.equal(await page.locator('#drawer-body').getByRole('button', { name: 'プロジェクトを登録', exact: true }).isDisabled(), false); await close();
  checks.push('破損JSONを上書きせず停止し、有効なバックアップから明示復旧して破損原本を退避');

  const recoveryContext = await isolatedContext(); const recoveryPage = await recoveryContext.newPage();
  await recoveryPage.goto(url);
  await recoveryPage.evaluate(key => localStorage.setItem(key, 'broken without backup'), STORAGE_KEY); await recoveryPage.reload();
  await recoveryPage.locator('#storage-warning').waitFor();
  assert.equal(await recoveryPage.locator('#recover-backup').isVisible(), false);
  await recoveryPage.locator('#recovery-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await recoveryPage.locator('#toast').filter({ hasText: 'バージョン' }).waitFor();
  assert.equal(await recoveryPage.evaluate(key => localStorage.getItem(key), STORAGE_KEY), 'broken without backup');
  await recoveryPage.locator('#recovery-file').setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(emptyWorkspace())) });
  await recoveryPage.locator('#storage-warning').waitFor({ state: 'hidden' });
  assert.equal(await recoveryPage.evaluate(key => localStorage.getItem(key), RECOVERY_KEY), 'broken without backup');
  await recoveryContext.close();
  checks.push('バックアップがない場合は不正な復旧JSONを拒否し、有効なJSONだけを読み込む');

  const deniedContext = await isolatedContext();
  await deniedContext.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('QA denied', 'SecurityError'); } }));
  const denied = await deniedContext.newPage(); denied.on('pageerror', error => errors.push(error.message));
  await denied.goto(url); await denied.locator('#storage-warning').waitFor();
  assert.match(await denied.locator('#storage-problem').innerText(), /保存領域/);
  await deniedContext.close();
  checks.push('ブラウザが保存領域を拒否しても画面が起動し、編集を停止する');
  assert.deepEqual(errors, []);
  assert.deepEqual(sourceBlobs(), testedBlobs, '検証中にソースが変更された');
  const result = { checkedAt: new Date().toISOString(), browser: await browser.version(), baseUrl: url,
    testedHead, testedWorkingTreeClean, testedBlobs, fixtureOnly: true, checks, pageErrors: errors, screenshots: ['empty.jpg', 'overview.jpg', 'alpha-detail.jpg', 'mobile-beta.jpg', 'mobile-overview.jpg', 'corrupt-backup.jpg', 'merged-workload-return.jpg'] };
  await writeFile(path.join(artifacts, 'qa-results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
