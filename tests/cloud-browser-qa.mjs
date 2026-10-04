import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startCloudPreview } from './cloud-preview.mjs';
import { fixtureWorkspace } from './cloud-fixtures.mjs';
import { fixture as snapshotFixture } from './snapshot-fixture.mjs';
import { STORAGE_KEY, addTask } from '../dist/workspace.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = process.env.CLOUD_QA_ARTIFACT_DIR || '/tmp/progress-tool-cloud-browser-qa';
const sourceFiles = ['dist/app.mjs', 'dist/workspace.mjs', 'dist/engine.mjs', 'dist/cloud-workspace.mjs', 'dist/progress-tools.mjs', 'dist/github-snapshot.mjs', 'dist/github-snapshot.json', 'dist/index.html', 'dist/projects.css', 'server/worker.mjs', 'server/cloud-db.mjs', 'scripts/build-cloud.mjs', 'db/schema.ts', 'drizzle.config.ts', 'drizzle/0000_opposite_venus.sql', 'tests/cloud-fixtures.mjs', 'tests/cloud-preview.mjs', 'tests/cloud-browser-qa.mjs', 'tests/cloud-api.test.mjs', 'tests/cloud-store.test.mjs', 'tests/workspace.test.mjs', 'package.json', 'package-lock.json'];
const sourceBlobs = () => Object.fromEntries(execFileSync('git', ['hash-object', ...sourceFiles], { encoding: 'utf8' }).trim().split('\n').map((hash, index) => [sourceFiles[index], hash]));
sourceFiles.push('dist/local-github.mjs', 'dist/my-work.css');
const testedBlobs = sourceBlobs();
await mkdir(artifacts, { recursive: true });
const preview = await startCloudPreview();
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const contexts = [], errors = [], checks = [], localGithubRequests = [];
const makeContext = async (user, viewport = { width: 1440, height: 1000 }) => {
  const context = await browser.newContext({ viewport }); contexts.push(context);
  context.on('request', request => { if (/\/api\/(local-github|github\/refresh)/.test(new URL(request.url()).pathname)) localGithubRequests.push(request.url()); });
  await context.addCookies([{ name: 'qa-user', value: user, url: preview.origin }]);
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return context;
};
const pcContext = await makeContext('qa-owner'), phoneContext = await makeContext('qa-owner', { width: 390, height: 844 });
const original = JSON.stringify(fixtureWorkspace());
await pcContext.addInitScript(({ key, value, origin }) => { if (location.origin !== origin) return; try { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); } catch { /* about:blank/sandbox frames are not QA app storage */ } }, { key: STORAGE_KEY, value: original, origin: preview.origin });
const pc = await pcContext.newPage(), phone = await phoneContext.newPage();
const ready = page => page.waitForFunction(() => document.querySelector('#storage-label').textContent === 'クラウド保存');
const saved = page => page.waitForFunction(() => !document.querySelector('main').hasAttribute('aria-busy'));
const click = async (page, name) => {
  const registration = ['プロジェクトを登録', '目標を登録', '作業を登録', 'GitHub snapshotを読み込む'].includes(name);
  if (registration) { await close(page); await page.getByRole('button', { name: '登録・取込', exact: true }).click(); }
  const target = registration ? page.locator('#drawer-body') : page;
  await target.getByRole('button', { name, exact: true }).first().click(); await saved(page);
};
const close = async page => { if (await page.locator('#detail-dialog').isVisible()) await page.locator('#close-dialog').click(); };
const showIterations = async page => { const tab = page.getByRole('tab', { name: 'イテレーション', exact: true }); if (await tab.getAttribute('aria-selected') !== 'true') await tab.click(); };
const select = async (page, id) => { await close(page); await page.locator('#project-switch').selectOption(id || ''); await saved(page); if (id) await showIterations(page); };
const cloud = page => page.evaluate(async () => (await fetch('/api/workspace')).json());
const capture = (page, name) => page.screenshot({ path: path.join(artifacts, name), fullPage: true, animations: 'disabled' });
async function download(page, name, action) {
  const event = page.waitForEvent('download'); await action(); const file = await event;
  const target = path.join(artifacts, name); await file.saveAs(target); return JSON.parse(await readFile(target, 'utf8'));
}
async function register(page, name, repositoryUrl) {
  await close(page); await click(page, 'プロジェクトを登録'); await page.getByLabel('プロジェクト名', { exact: true }).fill(name);
  if (repositoryUrl) await page.getByLabel('repository URL（任意）').fill(repositoryUrl);
  await click(page, '登録して保存');
  if (!await page.locator('#storage-warning').isVisible()) await close(page);
}
async function openTask(page) { await close(page); await page.locator('.period-task-name').getByRole('button', { name: '検証用作業', exact: true }).click(); }

try {
  await Promise.all([pc.goto(preview.origin), phone.goto(preview.origin)]); await ready(pc); await ready(phone);
  assert.equal((await cloud(pc)).version, 0); assert.equal(await pc.locator('[data-project-card]').count(), 0);
  assert.equal(await pc.evaluate(key => localStorage.getItem(key), STORAGE_KEY), original);
  await capture(pc, '01-cloud-empty-legacy-preserved.jpg');
  checks.push('クラウド初回読込は空・version0。既存ブラウザ保存を自動で取り込まず、原本を保持');

  await click(pc, 'ブラウザ保存から移行'); await click(pc, 'このブラウザの保存を確認');
  assert.equal(await pc.locator('[data-form="migrate-workspace"] [type="submit"]').isDisabled(), true);
  await capture(pc, '02-migration-preview.jpg');
  await pc.setViewportSize({ width: 390, height: 844 });
  assert.equal(await pc.locator('#detail-dialog').evaluate(dialog => Math.max(0, dialog.scrollWidth - dialog.clientWidth)), 0);
  await capture(pc, '02b-phone-migration-preview.jpg');
  await pc.setViewportSize({ width: 1440, height: 1000 });
  const backup = await download(pc, 'qa-migration-original.json', () => click(pc, '移行元のバックアップを書き出す'));
  assert.equal(backup.primary, original);
  await pc.locator('#migration-backup-confirmed').check(); await click(pc, '確認したデータをクラウドに追加');
  assert.equal((await cloud(pc)).version, 1); assert.deepEqual((await cloud(pc)).workspace.projects, fixtureWorkspace().projects);
  assert.equal(await pc.evaluate(key => localStorage.getItem(key), STORAGE_KEY), original);
  checks.push('移行は出典project ID/URLのpreviewと原本バックアップ・明示確認を必須とし、同じID・条件・状態・unknown値を保存。390px移行画面も横はみ出しなし');

  assert.equal(await pc.getByRole('tab', { name: '自分の作業', exact: true }).getAttribute('aria-selected'), 'true');
  await pc.locator('[data-owner-filter="none"]').click();
  assert.equal(await pc.locator('[data-owner-filter="none"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await pc.locator('[data-my-work-task="task-one"]').count(), 1);
  assert.equal((await cloud(pc)).version, 1);
  checks.push('クラウドでも自分の作業を初期表示し、未担当の絞り込みを保存データの更新なしで切り替える');

  await register(phone, '隔離QA：競合した電話入力', 'https://github.com/qa/phone');
  await phone.locator('#storage-warning').waitFor(); assert.match(await phone.locator('#storage-problem').innerText(), /別の端末/);
  assert.equal(await phone.getByLabel('プロジェクト名', { exact: true }).inputValue(), '隔離QA：競合した電話入力');
  const conflict = await download(phone, 'qa-conflict-pending.json', () => click(phone, '変更候補・未保存入力を退避'));
  assert.equal(conflict.confirmed.version, 0); assert.equal(conflict.pending.workspace.projects[0].name, '隔離QA：競合した電話入力');
  assert.equal((await cloud(pc)).version, 1); await capture(phone, '03-phone-conflict-preserved.jpg');
  await close(phone); await phone.reload(); await ready(phone);
  await select(phone, 'project-one'); assert.equal(await phone.locator('.period-task-name').getByRole('button', { name: '検証用作業', exact: true }).count(), 1);
  assert.equal(await phone.evaluate(key => localStorage.getItem(key), STORAGE_KEY), null);
  checks.push('独立したPC/電話contextで同じアカウントを共有。古いversionの電話保存を409で停止し、入力を退避して再読込後にPCの保存を復元');

  const otherContext = await makeContext('qa-other'), other = await otherContext.newPage(); await other.goto(preview.origin); await ready(other);
  assert.equal((await cloud(other)).version, 0); assert.equal(await other.locator('[data-project-card]').count(), 0);
  checks.push('別アカウントの新規contextではPC/電話のプロジェクトが表示されず、別の未保存workspaceとなる');

  await register(pc, '隔離QA：別プロジェクト', 'https://github.com/qa/two');
  await showIterations(pc);
  let document = await cloud(pc); const two = document.workspace.projects.find(project => project.id !== 'project-one').id;
  await click(pc, '目標を登録'); await pc.getByLabel('目標名', { exact: true }).fill('別プロジェクトのQA目標'); await pc.getByLabel('Issue番号（任意）').fill('1'); await click(pc, '登録して保存');
  assert.equal(await pc.locator('#drawer-title').innerText(), '登録・取込');
  assert.equal(await pc.getByRole('button', { name: '作業を登録', exact: true }).isEnabled(), true);
  await click(pc, '作業を登録'); await pc.getByLabel('作業名', { exact: true }).fill('別プロジェクトのQA作業'); await pc.getByLabel('Issue番号（任意）').fill('2'); await pc.getByLabel('完了条件（任意・1行に1件）').fill('QAの条件'); await click(pc, '登録して保存');
  assert.equal(await pc.locator('#drawer-title').innerText(), '登録・取込');
  await capture(pc, '11-cloud-registration-return.jpg');
  const beforeSnapshot = structuredClone((await cloud(pc)).workspace.projects[0].data);
  await click(pc, 'GitHub snapshotを読み込む');
  await pc.locator('#snapshot-file').setInputFiles({ name: 'isolated-qa-snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshotFixture('https://github.com/qa/one'))) });
  await pc.locator('[data-form="import-snapshot"]').waitFor(); await click(pc, '取込先を確認して保存');
  assert.equal(await pc.locator('#drawer-title').innerText(), '登録・取込');
  document = await cloud(pc); assert.deepEqual(document.workspace.projects[0].data, beforeSnapshot); assert.equal(document.workspace.projects[0].githubSnapshot.projectId, 'project-one');
  assert.equal(document.workspace.projects[1].githubSnapshot, undefined);
  assert.equal(document.workspace.projects[0].data.tasks[0].issueNumber, document.workspace.projects[1].data.tasks[0].issueNumber);
  checks.push('既存の目標・作業・Issue番号表示・snapshot取込を維持し、同番号の作業とsnapshotをproject別に分離');
  checks.push('クラウド保存でも登録・取込から目標・作業・snapshotを保存した後に元の管理パネルへ戻り、目標に続けて作業を登録できる');

  const version = document.version;
  for (let i = 0; i < 9; i++) await select(pc, i % 2 ? two : 'project-one');
  assert.equal((await cloud(pc)).version, version); await pc.reload(); await ready(pc); assert.equal(await pc.locator('#project-switch').inputValue(), 'project-one');
  await phone.reload(); await ready(phone); assert.equal((await cloud(phone)).workspace.projects.length, 2); assert.equal(await phone.locator('#project-switch').inputValue(), 'project-one');
  await openTask(pc); assert.equal(await pc.locator('#task-estimate').inputValue(), ''); assert.equal(await pc.locator('#task-iteration').inputValue(), '');
  checks.push('9回の切替はクラウドversionを書き換えず、端末ごとの表示選択を復元。再読込で別端末の追加も取得し、見積・期限は不明を維持');

  await pc.route('**/api/workspace', route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA保存先停止' }) }) : route.continue());
  await pc.locator('#task-owner').fill('保存していないQA担当'); await pc.locator('#task-evidence').fill('失敗するQA証拠'); await click(pc, '根拠を記録');
  assert.equal(await pc.locator('#task-evidence').inputValue(), '失敗するQA証拠'); assert.equal(await pc.locator('#task-owner').inputValue(), '保存していないQA担当');
  assert.equal((await cloud(pc)).version, version); assert.equal((await cloud(pc)).workspace.projects[0].data.tasks[0].evidence, '');
  const failed = await download(pc, 'qa-failed-save-pending.json', () => click(pc, '変更候補・未保存入力を退避'));
  assert.equal(failed.pending.workspace.projects[0].data.tasks[0].evidence, '失敗するQA証拠');
  assert.ok(failed.browserUnsavedInputs.visibleInputs.some(input => input.id === 'task-owner' && input.value === '保存していないQA担当'));
  await capture(pc, '04-save-failure-inputs.jpg'); await pc.unroute('**/api/workspace'); await close(pc); await pc.reload(); await ready(pc);
  checks.push('503保存失敗は画面の保存済みデータを保持し、送信候補と別項目の未保存入力をmodal内から書き出せる');

  await select(pc, 'project-one'); await openTask(pc);
  await pc.route('**/api/workspace', async route => {
    if (route.request().method() === 'PUT') { await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await pc.locator('#task-evidence').fill('応答喪失後にサーバーが保存したQA証拠'); await click(pc, '根拠を記録');
  assert.match(await pc.locator('#storage-problem').innerText(), /保存結果を確認/);
  assert.equal((await cloud(pc)).version, version + 1);
  await pc.unroute('**/api/workspace'); await close(pc); await pc.reload(); await ready(pc); await select(pc, 'project-one'); await openTask(pc);
  assert.equal(await pc.locator('#task-evidence').inputValue(), '応答喪失後にサーバーが保存したQA証拠');
  checks.push('サーバー保存後の応答喪失は成功と表示せず編集を停止。自動再送せず、再読込で実際の保存結果を確認');

  await close(pc); await select(pc, ''); await capture(pc, '05-shared-overview.jpg');
  const duplicate = fixtureWorkspace(); duplicate.projects[0].data.tasks[0].evidence = '別内容の同じID';
  await click(pc, 'ブラウザ保存から移行'); await pc.locator('#migration-file').setInputFiles({ name: 'conflicting-workspace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(duplicate)) });
  await pc.locator('#drawer-body .inline-error').waitFor(); assert.match(await pc.locator('#drawer-body').innerText(), /同じプロジェクトID/);
  assert.equal(await pc.locator('[data-form="migrate-workspace"]').count(), 0);
  assert.equal((await cloud(pc)).version, version + 1); await close(pc);
  checks.push('正常なクラウドデータと異なる同一IDの移行は全件拒否し、部分取込・上書きをしない');

  const forged = await fetch(preview.origin + '/api/workspace', { headers: { 'oai-authenticated-user-id': 'qa-owner' } });
  assert.equal(forged.status, 401);
  const otherForged = await fetch(preview.origin + '/api/workspace', { headers: { Cookie: 'qa-user=qa-other', 'oai-authenticated-user-id': 'qa-owner' } });
  assert.equal((await otherForged.json()).userId, 'qa-other');
  const forgedWrite = await fetch(preview.origin + '/api/workspace', { method: 'PUT', headers: { Cookie: 'qa-user=qa-other', 'oai-authenticated-user-id': 'qa-owner', Origin: preview.origin, 'Content-Type': 'application/json', 'X-Progress-Write': '1' }, body: JSON.stringify({ baseVersion: 0, operationId: crypto.randomUUID(), expectedUserId: 'qa-owner', workspace: fixtureWorkspace('forged') }) });
  assert.equal(forgedWrite.status, 401); assert.equal((await cloud(other)).version, 0);
  checks.push('loopback認証境界は偽造user headerを破棄し、匿名は401、別userは実cookie IDで読む。これはSitesの本番偽造耐性の検証ではない');

  const migrationContext = await makeContext('qa-review-migration'), migration = await migrationContext.newPage(); await migration.goto(preview.origin); await ready(migration);
  await click(migration, 'ブラウザ保存から移行');
  const migrationFile = (name, workspace) => ({ name, mimeType: 'application/json', buffer: Buffer.from(typeof workspace === 'string' ? workspace : JSON.stringify(workspace)) });
  await migration.locator('#migration-file').setInputFiles(migrationFile('qa-first-valid.json', fixtureWorkspace('first-valid')));
  await download(migration, 'qa-before-invalid-original.json', () => click(migration, '移行元のバックアップを書き出す'));
  await migration.locator('#migration-backup-confirmed').check();
  await migration.locator('#migration-file').setInputFiles(migrationFile('qa-invalid-next.json', '{broken'));
  await migration.locator('#panel-error').waitFor(); assert.equal(await migration.locator('[data-form="migrate-workspace"]').count(), 0);
  assert.equal((await cloud(migration)).version, 0);
  await migration.evaluate(() => {
    const originalText = File.prototype.text;
    File.prototype.text = async function () {
      if (this.name !== 'qa-slow-first.json') return originalText.call(this);
      await new Promise(resolve => { window.__releaseMigrationRead = resolve; });
      const result = await originalText.call(this); window.__slowMigrationFinished = true; return result;
    };
  });
  await migration.locator('#migration-file').setInputFiles(migrationFile('qa-slow-first.json', fixtureWorkspace('slow-first')));
  await migration.waitForFunction(() => typeof window.__releaseMigrationRead === 'function');
  assert.equal(await migration.locator('[data-form="migrate-workspace"]').count(), 0);
  await migration.locator('#migration-file').setInputFiles(migrationFile('qa-fast-latest.json', fixtureWorkspace('fast-latest')));
  await migration.locator('.migration-projects').waitFor(); assert.match(await migration.locator('.migration-projects').innerText(), /project-fast-latest/);
  await migration.evaluate(() => window.__releaseMigrationRead()); await migration.waitForFunction(() => window.__slowMigrationFinished);
  assert.match(await migration.locator('.migration-projects').innerText(), /project-fast-latest/);
  assert.equal(await migration.locator('#migration-backup-confirmed').isDisabled(), true);
  await migration.evaluate(key => localStorage.setItem(key, '{bad-local-source'), STORAGE_KEY);
  await click(migration, 'このブラウザの保存を確認');
  assert.equal(await migration.locator('[data-form="migrate-workspace"]').count(), 0);
  assert.equal(await migration.evaluate(key => localStorage.getItem(key), STORAGE_KEY), '{bad-local-source');
  await capture(migration, '07-invalid-migration-cleared.jpg');
  checks.push('移行元の選び直しは候補・確認を即時解除。不正JSON・破損local保存で以前の候補を保存できず、遅い旧fileも最新previewを置換しない');

  const exportContext = await makeContext('qa-review-export'), exportedPage = await exportContext.newPage(); await exportedPage.goto(preview.origin); await ready(exportedPage);
  const seed = fixtureWorkspace('export');
  assert.equal(await exportedPage.evaluate(async workspace => (await fetch('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Progress-Write': '1' }, body: JSON.stringify({ baseVersion: 0, expectedUserId: 'qa-review-export', operationId: crypto.randomUUID(), workspace }) })).status, seed), 200);
  await exportedPage.reload(); await ready(exportedPage); await select(exportedPage, 'project-export'); await openTask(exportedPage);
  assert.match(await exportedPage.locator('#drawer-body').innerText(), /変更はクラウドに保存/);
  await exportedPage.locator('#task-owner').fill('QA退避する担当入力'); await exportedPage.locator('#task-evidence').fill('QA閉じる前の未保存証拠');
  await exportedPage.route('**/api/workspace', route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA保存停止' }) }) : route.continue());
  await click(exportedPage, '担当を更新'); await exportedPage.locator('#export-pending-inputs').waitFor();
  let releaseBackup, markBackupStarted;
  const backupGate = new Promise(resolve => { releaseBackup = resolve; }), backupStarted = new Promise(resolve => { markBackupStarted = resolve; });
  await exportedPage.route('**/api/workspace/backup', async route => { markBackupStarted(); await backupGate; await route.continue(); });
  const exportEvent = exportedPage.waitForEvent('download'); await click(exportedPage, '変更候補・未保存入力を退避'); await backupStarted;
  await close(exportedPage); releaseBackup(); const exportedFile = await exportEvent;
  await exportedFile.saveAs(path.join(artifacts, 'qa-export-before-dialog-close.json'));
  const captured = JSON.parse(await readFile(path.join(artifacts, 'qa-export-before-dialog-close.json'), 'utf8'));
  assert.equal(captured.browserUnsavedInputs.panel.id, 'task-export');
  assert.equal(captured.browserUnsavedInputs.visibleInputs.find(input => input.id === 'task-evidence').value, 'QA閉じる前の未保存証拠');
  assert.equal(captured.pending.workspace.projects[0].data.tasks[0].owner, 'QA退避する担当入力');
  checks.push('raw取得が遅く詳細を閉じても、退避クリック時の未保存入力・panel・送信候補を保持する');
  for (const selector of ['#refresh-cloud', '#reload-workspace']) {
    let asked = false; exportedPage.once('dialog', async dialog => { asked = true; await dialog.dismiss(); });
    await exportedPage.locator(selector).click(); assert.equal(asked, true); assert.equal(await exportedPage.locator('#storage-warning').isVisible(), true);
  }
  exportedPage.once('dialog', dialog => dialog.accept());
  await Promise.all([exportedPage.waitForNavigation(), exportedPage.locator('#refresh-cloud').click()]); await ready(exportedPage);
  assert.equal((await cloud(exportedPage)).workspace.projects[0].data.tasks[0].owner, null);
  checks.push('詳細を閉じた保存結果不明の状態でも両方の再読込ボタンが退避確認を要求し、cancelは入力候補を残す');

  for (const committed of [false, true]) {
    const phase = committed ? 'after-commit' : 'before-commit';
    const timeoutContext = await makeContext(`qa-timeout-${phase}`), timeoutPage = await timeoutContext.newPage();
    await timeoutPage.goto(preview.origin); await ready(timeoutPage);
    const timeoutSeed = fixtureWorkspace(`timeout-${phase}`);
    assert.equal(await timeoutPage.evaluate(async workspace => (await fetch('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Progress-Write': '1' }, body: JSON.stringify({ baseVersion: 0, expectedUserId: workspace.userId, operationId: crypto.randomUUID(), workspace: workspace.data }) })).status, { userId: `qa-timeout-${phase}`, data: timeoutSeed }), 200);
    await timeoutPage.reload(); await ready(timeoutPage); await select(timeoutPage, timeoutSeed.projects[0].id); await openTask(timeoutPage);
    let puts = 0, release, markStarted;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { markStarted = resolve; });
    await timeoutPage.route('**/api/workspace', async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      puts++;
      if (committed) assert.equal((await route.fetch()).status(), 200);
      markStarted(); await gate; await route.abort('failed');
    });
    const candidateEvidence = `QA timeout ${phase} evidence`, unsentOwner = `QA timeout ${phase} unsent owner`;
    await timeoutPage.locator('#task-evidence').fill(candidateEvidence); await timeoutPage.locator('#task-owner').fill(unsentOwner);
    const saveStartedAt = Date.now();
    await timeoutPage.getByRole('button', { name: '根拠を記録', exact: true }).click(); await started;
    await timeoutPage.waitForFunction(() => document.querySelector('#storage-problem').textContent.includes('保存結果を確認'), undefined, { timeout: 20000 });
    assert.ok(Date.now() - saveStartedAt >= 14000, '実際の15秒タイムアウトより前に失敗していない');
    release(); await saved(timeoutPage);
    assert.equal(puts, 1); assert.equal(await timeoutPage.getByRole('button', { name: '根拠を記録', exact: true }).isDisabled(), true);
    assert.equal(await timeoutPage.locator('#task-evidence').inputValue(), candidateEvidence);
    const exportedTimeout = await download(timeoutPage, `qa-timeout-${phase}-pending.json`, () => click(timeoutPage, '変更候補・未保存入力を退避'));
    assert.equal(exportedTimeout.confirmed.version, 1); assert.equal(exportedTimeout.confirmed.workspace.projects[0].data.tasks[0].evidence, '');
    assert.equal(exportedTimeout.pending.workspace.projects[0].data.tasks[0].evidence, candidateEvidence);
    assert.equal(exportedTimeout.pending.workspace.projects[0].data.tasks[0].owner, null);
    assert.ok(exportedTimeout.browserUnsavedInputs.visibleInputs.some(input => input.id === 'task-owner' && input.value === unsentOwner));
    const serverAfterTimeout = await cloud(timeoutPage);
    assert.equal(serverAfterTimeout.version, committed ? 2 : 1);
    assert.equal(serverAfterTimeout.workspace.projects[0].data.tasks[0].evidence, committed ? candidateEvidence : '');
    await capture(timeoutPage, `12-timeout-${phase}.jpg`); await close(timeoutPage);
    for (const selector of ['#refresh-cloud', '#reload-workspace']) {
      let asked = false; timeoutPage.once('dialog', async dialog => { asked = true; await dialog.dismiss(); });
      await timeoutPage.locator(selector).click(); assert.equal(asked, true);
      assert.equal(await timeoutPage.locator('#storage-warning').isVisible(), true);
    }
    const afterCancel = await download(timeoutPage, `qa-timeout-${phase}-after-cancel.json`, () => timeoutPage.locator('#export-raw').click());
    assert.deepEqual(afterCancel.pending, exportedTimeout.pending); assert.equal(puts, 1);
    await timeoutPage.unroute('**/api/workspace'); timeoutPage.once('dialog', dialog => dialog.accept());
    await Promise.all([timeoutPage.waitForNavigation(), timeoutPage.locator('#refresh-cloud').click()]); await ready(timeoutPage);
    await select(timeoutPage, timeoutSeed.projects[0].id); await openTask(timeoutPage);
    assert.equal(await timeoutPage.locator('#task-evidence').inputValue(), committed ? candidateEvidence : '');
    assert.equal(await timeoutPage.locator('#task-owner').inputValue(), '');
    assert.equal(await timeoutPage.locator('#storage-warning').isVisible(), false);
    assert.equal((await cloud(timeoutPage)).version, committed ? 2 : 1); assert.equal(puts, 1);
    checks.push(`15秒の実保存タイムアウト（${committed ? 'サーバー保存後の応答停止' : 'サーバー保存前の停止'}）で表示を旧版に留め、候補・別項目入力を退避し、編集・自動再送を停止する`);
    checks.push(`タイムアウト${phase}の詳細を閉じても両方の再読込cancelで候補を保持。確認後の再読込は候補を破棄し、サーバーの${committed ? '保存済み' : '未保存'}結果だけを取得する`);
  }

  const pendingContext = await makeContext('qa-review-pending-view'), pendingPage = await pendingContext.newPage(); await pendingPage.goto(preview.origin); await ready(pendingPage);
  const pendingSeed = fixtureWorkspace(); pendingSeed.projects.push(fixtureWorkspace('two').projects[0]);
  assert.equal(await pendingPage.evaluate(async workspace => (await fetch('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Progress-Write': '1' }, body: JSON.stringify({ baseVersion: 0, expectedUserId: 'qa-review-pending-view', operationId: crypto.randomUUID(), workspace }) })).status, pendingSeed), 200);
  await pendingPage.reload(); await ready(pendingPage); await select(pendingPage, 'project-one'); await openTask(pendingPage);
  for (const change of ['owner', 'register']) {
    let releaseWrite, markWriteStarted;
    const writeGate = new Promise(resolve => { releaseWrite = resolve; }), writeStarted = new Promise(resolve => { markWriteStarted = resolve; });
    await pendingPage.route('**/api/workspace', async route => { if (route.request().method() === 'PUT') { markWriteStarted(); await writeGate; } await route.continue(); });
    if (change === 'owner') {
      await pendingPage.locator('#task-owner').fill('QA保存待ち担当'); await pendingPage.getByRole('button', { name: '担当を更新', exact: true }).click();
    } else {
      await select(pendingPage, ''); await click(pendingPage, 'プロジェクトを登録');
      await pendingPage.getByLabel('プロジェクト名', { exact: true }).fill('QA保存待ちの新project'); await pendingPage.getByRole('button', { name: '登録して保存', exact: true }).click();
    }
    await writeStarted; await close(pendingPage);
    if (change === 'owner') {
      await pendingPage.locator('.period-task-name').getByRole('button', { name: '検証用作業', exact: true }).click();
      await pendingPage.locator('#project-switch').selectOption('project-two');
      assert.equal(await pendingPage.locator('#project-switch').inputValue(), 'project-one');
    } else {
      await pendingPage.locator('[data-action="select-project"][data-id="project-two"]').click();
      await pendingPage.getByRole('button', { name: '登録・取込', exact: true }).click();
      assert.equal(await pendingPage.locator('#project-switch').inputValue(), '');
    }
    assert.equal(await pendingPage.locator('#detail-dialog').isVisible(), false);
    releaseWrite(); await saved(pendingPage); await pendingPage.unroute('**/api/workspace');
  }
  const pendingResult = (await cloud(pendingPage)).workspace;
  assert.equal(pendingResult.projects[0].data.tasks[0].owner, 'QA保存待ち担当'); assert.equal(pendingResult.projects[1].data.tasks[0].owner, null);
  assert.equal(pendingResult.projects[2].name, 'QA保存待ちの新project');
  checks.push('保存待ち中に詳細を閉じても、別の入力詳細やcardからのproject切替を開かない。応答後は元の変更だけを反映し、別projectを変更しない');

  const hostileContext = await makeContext('qa-review-import'), hostilePage = await hostileContext.newPage(); await hostilePage.goto(preview.origin); await ready(hostilePage);
  const hostile = fixtureWorkspace('hostile'), markup = '<img data-xss src=x onerror="window.__qaXss=true">';
  hostile.projects[0].name = markup; hostile.projects[0].data.project = markup; hostile.projects[0].data.goals[0].title = markup;
  const hostileTask = hostile.projects[0].data.tasks[0]; hostileTask.title = markup; hostileTask.group = markup; hostileTask.evidence = '</textarea>' + markup; hostileTask.criteria[0].text = markup;
  await click(hostilePage, 'ブラウザ保存から移行'); await hostilePage.locator('#migration-file').setInputFiles(migrationFile('qa-markup-as-text.json', hostile));
  await download(hostilePage, 'qa-markup-original.json', () => click(hostilePage, '移行元のバックアップを書き出す'));
  await hostilePage.locator('#migration-backup-confirmed').check(); await click(hostilePage, '確認したデータをクラウドに追加');
  await select(hostilePage, 'project-hostile'); await hostilePage.locator('.period-task-name').getByRole('button', { name: markup, exact: true }).click();
  assert.equal(await hostilePage.locator('#task-evidence').inputValue(), '</textarea>' + markup);
  assert.equal(await hostilePage.locator('[data-xss]').count(), 0); assert.equal(await hostilePage.evaluate(() => window.__qaXss), undefined);
  await close(hostilePage); await click(hostilePage, 'ブラウザ保存から移行');
  const unsafe = '{"schemaVersion":1,"selectedProjectId":null,"projects":[],"__proto__":{"injected":true}}';
  await hostilePage.locator('#migration-file').setInputFiles(migrationFile('qa-prototype.json', unsafe)); await hostilePage.locator('#drawer-body .inline-error').waitFor();
  assert.equal(await hostilePage.locator('[data-form="migrate-workspace"]').count(), 0);
  const refusedRaw = await download(hostilePage, 'qa-prototype-original.json', () => click(hostilePage, '移行元のバックアップを書き出す'));
  assert.equal(Object.hasOwn(refusedRaw, '__proto__'), true); assert.equal((await cloud(hostilePage)).version, 1);
  await capture(hostilePage, '08-unsafe-import-original-export.jpg');
  checks.push('移行したHTML風の名前・条件・証拠を文字列として表示しscript/属性を実行しない。prototypeキーは保存前に拒否し原本を退避できる');

  await phone.reload(); await ready(phone); await select(phone, ''); await capture(phone, '06-phone-shared-overview.jpg');
  assert.equal(await phone.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth)), 0);
  assert.equal(await phone.locator('[data-project-card]').count(), 2);
  checks.push('390px電話画面で同じ2projectの全体一覧を表示し、横はみ出しなし');

  const unavailableContext = await makeContext('qa-owner'), unavailable = await unavailableContext.newPage();
  await unavailable.route('**/api/workspace', route => route.abort('internetdisconnected'));
  await unavailable.goto(preview.origin); await unavailable.locator('#storage-warning').waitFor();
  assert.equal(await unavailable.locator('#export-workspace').isDisabled(), true);
  await unavailable.getByRole('button', { name: '登録・取込', exact: true }).click();
  assert.equal(await unavailable.locator('[data-action="add-project"]').first().isDisabled(), true);
  assert.match(await unavailable.locator('#storage-problem').innerText(), /自動で空データを保存せず/);
  checks.push('初回API通信失敗は空workspaceを保存済みとして書き出せず、端末保存へ切り替えず編集を停止');

  preview.DB.sqlite.prepare('UPDATE progress_workspace_chunks SET payload = ? WHERE user_id = ? AND version = ?').run('{corrupt-qa', 'qa-owner', version + 1);
  const corruptContext = await makeContext('qa-owner'), corrupt = await corruptContext.newPage(); await corrupt.goto(preview.origin); await corrupt.locator('#storage-warning').waitFor();
  assert.match(await corrupt.locator('#storage-problem').innerText(), /上書きを停止/);
  const corruptBackup = await download(corrupt, 'qa-corrupt-cloud-backup.json', () => click(corrupt, '保存データ・変更候補を退避'));
  assert.ok(corruptBackup.serverBackup.chunks.some(chunk => chunk.payload === '{corrupt-qa'));
  assert.ok(corruptBackup.serverBackup.chunks.some(chunk => chunk.version === version));
  checks.push('保存済みクラウドJSONの破損は編集を停止し、破損原本と直前版を退避できる');

  const workContext = await makeContext('qa-my-work'), workPage = await workContext.newPage(); await workPage.goto(preview.origin); await ready(workPage);
  const workFixture = fixtureWorkspace('my-work'), workProject = workFixture.projects[0], actionTask = workProject.data.tasks[0];
  actionTask.owner = 'Codex'; actionTask.waitReason = '仕様を確認する';
  const waitingTask = addTask(workProject.data, workProject.id, { title: '前提を待つClaudeの作業', goalId: actionTask.goalId, status: 'todo' }, () => 'task-waiting');
  waitingTask.owner = 'Claude'; waitingTask.deps = [actionTask.id];
  const workRecord = await cloud(workPage);
  const savedStatus = await workPage.evaluate(async ({ record, workspace }) => (await fetch('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Progress-Write': '1' }, body: JSON.stringify({ baseVersion: record.version, expectedUserId: record.userId, operationId: 'qa-my-work-integration-0001', workspace }) })).status, { record: workRecord, workspace: workFixture });
  assert.equal(savedStatus, 200); await workPage.reload(); await ready(workPage); await select(workPage, workProject.id);
  await workPage.getByRole('tab', { name: '自分の作業', exact: true }).click();
  await workPage.locator('[data-owner-name="Codex"]').click();
  assert.equal(await workPage.locator('[data-my-work-section="action"] [data-my-work-task]').count(), 1);
  assert.equal(await workPage.locator('[data-my-work-task="task-waiting"]').count(), 0);
  await capture(workPage, '09-cloud-my-work-codex.jpg');
  await workPage.locator('[data-owner-name="Claude"]').click();
  assert.equal(await workPage.locator('[data-my-work-section="action"]').count(), 0);
  assert.equal(await workPage.locator('[data-my-work-section="waiting"] [data-my-work-task]').count(), 1);
  await workPage.locator('[data-my-work-section="waiting"] summary').click();
  await workPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await workPage.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth)), 0);
  await capture(workPage, '10-cloud-my-work-claude-phone.jpg');
  assert.deepEqual((await cloud(workPage)).workspace.projects, workFixture.projects);
  assert.equal((await cloud(workPage)).version, 1);
  checks.push('共有保存の手動計画をCodexの要対応・Claudeの前提待ちへ分け、担当絞り込み・390px表示でversionと手入力を保持する');

  const seedDecisionPage = async (page, workspace) => {
    const result = await page.evaluate(async workspace => {
      const record = await (await fetch('/api/workspace')).json();
      return (await fetch('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Progress-Write': '1' }, body: JSON.stringify({ baseVersion: record.version, expectedUserId: record.userId, operationId: crypto.randomUUID(), workspace }) })).status;
    }, workspace);
    assert.equal(result, 200); await page.reload(); await ready(page); await select(page, workspace.projects[0].id); await openTask(page);
  };
  const fillDecision = async (page, title) => {
    await page.locator('#decision-title').fill(title); await page.locator('#decision-options').fill('A\nB');
    await page.locator('#decision-evidence').fill('QA判断材料'); await page.locator('#decision-decider').fill('Wakua');
    await page.locator('#decision-estimate').fill('0.5');
  };
  for (const status of ['active', 'review']) {
    const user = `qa-decision-${status}`, viewport = status === 'review' ? { width: 390, height: 844 } : { width: 1440, height: 1000 };
    const decisionContext = await makeContext(user, viewport), decisionPage = await decisionContext.newPage();
    await decisionPage.goto(preview.origin); await ready(decisionPage);
    const decisionSeed = fixtureWorkspace(); decisionSeed.projects.push(fixtureWorkspace('decision-other').projects[0]);
    Object.assign(decisionSeed.projects[0].data.tasks[0], { owner: 'Claude', status, estimatePoints: 1 });
    decisionSeed.projects[0].data.tasks[0].criteria[0].checked = status === 'review';
    await seedDecisionPage(decisionPage, decisionSeed);
    const title = `QA共有${status}判断`; await fillDecision(decisionPage, title);
    await decisionPage.locator('#decision-title').scrollIntoViewIfNeeded();
    assert.equal(await decisionPage.locator('#detail-dialog').evaluate(dialog => Math.max(0, dialog.scrollWidth - dialog.clientWidth)), 0);
    await capture(decisionPage, `13-decision-${status}-before.jpg`); await click(decisionPage, '判断待ちを登録');
    const registered = await cloud(decisionPage), data = registered.workspace.projects[0].data;
    const decision = data.decisions[0], decisionTask = data.tasks.find(task => task.id === decision.taskId), originalTask = data.tasks.find(task => task.id === 'task-one');
    assert.equal(registered.version, 2); assert.equal(originalTask.status, 'todo'); assert.equal(originalTask.estimatePoints, 1);
    assert.deepEqual(originalTask.criteria, decisionSeed.projects[0].data.tasks[0].criteria); assert.deepEqual(originalTask.deps, [decisionTask.id]);
    assert.deepEqual([decisionTask.owner, decisionTask.estimatePoints, decisionTask.status], ['Wakua', 0.5, 'todo']);
    assert.deepEqual(registered.workspace.projects[1], decisionSeed.projects[1]); await close(decisionPage);
    await decisionPage.getByRole('tab', { name: '自分の作業', exact: true }).click(); await decisionPage.locator('[data-owner-name="Wakua"]').click();
    assert.equal(await decisionPage.locator(`[data-my-work-section="action"] [data-my-work-task="${decisionTask.id}"]`).count(), 1);
    await decisionPage.locator('[data-owner-name="Claude"]').click();
    assert.equal(await decisionPage.locator('[data-my-work-section="action"]').count(), 0);
    assert.equal(await decisionPage.locator('[data-my-work-section="waiting"] [data-my-work-task="task-one"]').count(), 1);
    await decisionPage.locator('[data-my-work-section="waiting"] summary').click();
    assert.equal(await decisionPage.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth)), 0);
    await capture(decisionPage, `14-decision-${status}-waiting.jpg`);
    checks.push(`共有保存の${status}作業へ判断待ちを登録すると未着手へ戻り、判断担当の要対応と元担当の前提待ちに分かれる。既存見積・完了条件・別projectを保ち、PC/390pxに収まる`);

    const secondContext = await makeContext(user), second = await secondContext.newPage(); await second.goto(preview.origin); await ready(second); await select(second, 'project-one');
    assert.deepEqual((await cloud(second)).workspace.projects, registered.workspace.projects);
    await second.locator('.period-task-name').getByRole('button', { name: title, exact: true }).click(); await click(second, '判断材料を確認する');
    await second.locator('#decision-choice').selectOption('A'); await second.locator('#decision-reason').fill('QA選択理由'); await click(second, '判断を記録して待ちを解除');
    const resolved = await cloud(second); assert.equal(resolved.version, 3); assert.equal(resolved.workspace.projects[0].data.decisions[0].resolved, true);
    assert.equal(resolved.workspace.projects[0].data.tasks.find(task => task.id === decisionTask.id).status, 'done');
    assert.deepEqual(resolved.workspace.projects[1], decisionSeed.projects[1]);
    await decisionPage.reload(); await ready(decisionPage); await select(decisionPage, 'project-one');
    await decisionPage.getByRole('tab', { name: '自分の作業', exact: true }).click(); await decisionPage.locator('[data-owner-name="Claude"]').click();
    assert.equal(await decisionPage.locator('[data-my-work-section="waiting"]').count(), 0);
    assert.equal(await decisionPage.locator('[data-my-work-section="ready-later"] [data-my-work-task="task-one"]').count(), 1);
    await capture(decisionPage, `15-decision-${status}-resolved.jpg`);
    checks.push(`独立contextで${status}の判断を読み込み、内容・理由を記録して保存。元端末の再読込で判断作業の完了と前提解除を復元し、別projectを変更しない`);
  }
  const failedDecisionContext = await makeContext('qa-decision-failed'), failedDecisionPage = await failedDecisionContext.newPage();
  await failedDecisionPage.goto(preview.origin); await ready(failedDecisionPage); await seedDecisionPage(failedDecisionPage, fixtureWorkspace());
  await fillDecision(failedDecisionPage, 'QA保存失敗の判断'); let decisionPuts = 0;
  await failedDecisionPage.route('**/api/workspace', route => {
    if (route.request().method() !== 'PUT') return route.continue();
    decisionPuts++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA判断保存停止' }) });
  });
  await click(failedDecisionPage, '判断待ちを登録'); assert.equal(decisionPuts, 1);
  assert.equal(await failedDecisionPage.getByRole('button', { name: '判断待ちを登録', exact: true }).isDisabled(), true);
  assert.equal(await failedDecisionPage.locator('#decision-title').inputValue(), 'QA保存失敗の判断');
  const failedDecisionExport = await download(failedDecisionPage, 'qa-failed-decision.json', () => click(failedDecisionPage, '変更候補・未保存入力を退避'));
  assert.equal(failedDecisionExport.confirmed.version, 1); assert.equal(failedDecisionExport.confirmed.workspace.projects[0].data.decisions.length, 0);
  const candidateData = failedDecisionExport.pending.workspace.projects[0].data;
  assert.deepEqual(candidateData.tasks[0].deps, [candidateData.decisions[0].taskId]);
  assert.ok(failedDecisionExport.browserUnsavedInputs.visibleInputs.some(input => input.id === 'decision-options' && input.value === 'A\nB'));
  await capture(failedDecisionPage, '16-decision-failed-candidate.jpg'); await close(failedDecisionPage);
  failedDecisionPage.once('dialog', dialog => dialog.dismiss()); await failedDecisionPage.locator('#refresh-cloud').click();
  const afterCancel = await download(failedDecisionPage, 'qa-failed-decision-after-cancel.json', () => failedDecisionPage.locator('#export-raw').click());
  assert.deepEqual(afterCancel.pending, failedDecisionExport.pending); assert.equal(decisionPuts, 1);
  await failedDecisionPage.unroute('**/api/workspace'); failedDecisionPage.once('dialog', dialog => dialog.accept());
  await Promise.all([failedDecisionPage.waitForNavigation(), failedDecisionPage.locator('#refresh-cloud').click()]); await ready(failedDecisionPage);
  assert.equal((await cloud(failedDecisionPage)).version, 1); assert.equal((await cloud(failedDecisionPage)).workspace.projects[0].data.decisions.length, 0);
  checks.push('判断待ちの保存失敗は旧計画を保ち、判断作業と前提の候補・入力を退避する。再登録を停止し、再読込cancelで候補を保持、確認後の再読込は未保存の判断を適用しない');
  assert.deepEqual(localGithubRequests, []);
  checks.push('クラウド画面の起動・再描画・登録・保存・再読込でローカルgh APIを呼ばない');
  assert.deepEqual(errors, []);
  assert.deepEqual(sourceBlobs(), testedBlobs, '検証中のソース変更を検出');
  const result = { checkedAt: new Date().toISOString(), testedHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), testedWorkingTreeClean: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '',
    browser: browser.version(), sourceBlobs: testedBlobs, checks, pageErrors: errors, authentication: 'simulated loopback-only qa-user cookies; production Sites authentication not verified', database: 'real local SQLite executing generated SQL through D1 batch adapter; hosted D1 not provisioned',
    isolation: 'fresh nonpersistent browser contexts + independent ephemeral DB, no existing user storage', deployed: false };
  await writeFile(path.join(artifacts, 'qa-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const context of contexts) await context.close(); await browser.close(); await preview.stop();
}
