import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { buildSnapshot, attachSnapshot } from '../dist/github-snapshot.mjs';
import { buildPlanning } from '../scripts/github-planning-fetch.mjs';
import { bookingSampleWorkspace } from '../scripts/make-booking-sample.mjs';
import { hierarchyFixture, qaWorkspace, QA_REPOSITORIES } from './local-github-fixture.mjs';
import { STORAGE_KEY } from '../dist/workspace.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = path.join(process.env.QA_ARTIFACT_DIR || 'node_modules/.qa-planning', 'planning');
await mkdir(artifacts, { recursive: true });
const testedHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceFiles = ['dist/app.mjs', 'dist/github-planning.mjs', 'dist/github-planning-view.mjs', 'dist/github-planning.css', 'dist/github-snapshot.mjs', 'dist/workspace.mjs', 'dist/index.html', 'dist/my-work.css', 'dist/next-action.mjs', 'scripts/make-booking-sample.mjs', 'tests/planning-browser-qa.mjs'];
const testedBlobs = Object.fromEntries(execFileSync('git', ['hash-object', ...sourceFiles], { encoding: 'utf8' }).trim().split('\n').map((hash, i) => [sourceFiles[i], hash]));
const repo = QA_REPOSITORIES[2], at = '2026-10-03T12:00:00Z';
const records = [1, 2, 3, 4].map(number => ({ number, html_url: `${repo}/issues/${number}`, title: `QA計画 ${number}`, state: number === 2 ? 'closed' : 'open', updated_at: at, closed_at: number === 2 ? at : null, labels: number === 1 ? [{ name: 'module:QAモジュール' }] : [], milestone: { number: 1 } }));
const connection = nodes => ({ totalCount: nodes.length, pageInfo: { hasNextPage: false }, nodes });
const hierarchy = hierarchyFixture(records), nodes = hierarchy.data.repository.issues.nodes;
nodes[0].subIssuesSummary.total = 3;
for (const node of nodes.slice(1)) {
  node.parent = { number: 1, url: records[0].html_url };
  node.projectItems = connection([{ project: { id: 'P1', title: 'QA Project', url: 'https://github.com/users/qa-fixture/projects/1' }, fieldValues: connection([
    { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Codex', field: { name: '担当' } },
    { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Todo', field: { name: 'Status' } },
    ...(node.number === 4 ? [] : [{ __typename: 'ProjectV2ItemFieldNumberValue', number: 2, field: { name: 'Estimate' } }]),
    { __typename: 'ProjectV2ItemFieldIterationValue', iterationId: 'it1', title: 'QA Iteration', startDate: '2026-10-05', duration: 7, field: { name: 'Iteration' } },
  ]) }]);
}
const input = { repositoryUrl: repo, fetchedAt: at, issuePages: [records], pullPages: [[]], hierarchyPages: [hierarchy], milestonePages: [[{ number: 1, html_url: `${repo}/milestone/1`, title: 'QAリリース', description: 'QA用の架空データ', state: 'open', due_on: '2026-10-18T00:00:00Z', updated_at: at, closed_at: null }]] };
const fixture = qaWorkspace(); fixture.projects = fixture.projects.slice(0, 1);
attachSnapshot(fixture.projects[0], buildSnapshot({ ...input, planning: buildPlanning(input) }), Date.parse(at));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
const errors = [], checks = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route(/\/api\/(?:local-github|github\/refresh)(?:\?|$)/, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"gh_unavailable"}' }));
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4340/';
    await page.goto(base);
    await page.evaluate(({ key, data }) => { localStorage.setItem(key, JSON.stringify(data)); localStorage.setItem('progress-tool.view.v1', JSON.stringify({ tab: 'iterations' })); }, { key: STORAGE_KEY, data: fixture });
    await page.reload(); await page.locator('.github-module').waitFor();
    const raw = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
    const module = page.locator('.github-module');
    assert.equal(await module.getAttribute('open'), null);
    const summary = module.locator(':scope > summary');
    assert.match(await summary.innerText(), /QAモジュール/); assert.match(await summary.innerText(), /pt 完了 · \d+ \/ \d+件/);
    assert.doesNotMatch(await summary.innerText(), /見積未設定|%/);
    assert.ok(await summary.locator('.state-bar > i').count() > 0);
    await page.screenshot({ path: path.join(artifacts, `${width}-collapsed.png`), fullPage: true });
    await summary.click();
    const goal = module.locator('[data-github-disclosure^="goal:"]'); await goal.locator(':scope > summary').click();
    assert.equal(await goal.locator('.tree [data-action="github-item"]').count(), 4);
    assert.ok(await goal.locator(':scope > summary .state-bar > i').count() > 0);
    const release = module.locator('[data-github-disclosure^="release:"]'); await release.locator(':scope > summary').click();
    assert.equal(await release.locator('[data-github-task]').count(), 3);
    assert.match(await release.innerText(), /2026-10-18/);
    assert.match(await release.locator(':scope > summary').innerText(), /50%.*見積未設定 1件を除外.*残り/s);
    await page.screenshot({ path: path.join(artifacts, `${width}-expanded.png`), fullPage: true });
    checks.push(`${width}px: collapsed module row shows the state bar and counts every task including the unset estimate; it expands to goal and release; the release row keeps the leaf-only 50% that excludes one unset estimate and displays remaining points`);
    await release.locator('[data-id="issue:3"]').click();
    assert.match(await page.locator('#drawer-body').innerText(), /QAモジュール.*親Issue #1から継承/s);
    assert.match(await page.locator('#drawer-body').innerText(), /Codex.*2pt.*QA Iteration/s);
    assert.equal(await page.locator('#drawer-body input, #drawer-body textarea').count(), 0);
    await page.screenshot({ path: path.join(artifacts, `${width}-detail.png`), fullPage: true });
    await page.locator('#close-dialog').click();
    await page.getByRole('tab', { name: '自分の作業', exact: true }).click();
    await page.getByRole('group', { name: 'GitHubの担当者で絞り込む' }).getByRole('button', { name: 'Codex', exact: true }).click();
    await page.getByRole('tab', { name: 'イテレーション', exact: true }).click();
    assert.equal(await module.evaluate(e => e.open), true);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY), raw);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    checks.push(`${width}px: source metadata is read-only; owner/view changes preserve module disclosure, manual data and snapshot; no horizontal overflow`);
    await page.clock.setFixedTime(new Date('2026-10-15T03:00:00Z'));
    await page.getByRole('tab', { name: '自分の作業', exact: true }).click();
    const nextAction = number => page.getByRole('combobox', { name: `#${number}の次にすること`, exact: true });
    const nextFilter = page.getByRole('combobox', { name: '表示する区分', exact: true });
    const saved = () => page.waitForFunction(() => !document.querySelector('main').hasAttribute('aria-busy'));

    await nextAction(3).selectOption('ai');
    await saved();
    await nextFilter.selectOption({ label: 'AIに渡す 1件' });
    await nextAction(3).selectOption('');
    await saved();
    await nextAction(4).selectOption('ai');
    await saved();
    assert.equal(await nextFilter.inputValue(), '');
    assert.equal(await nextAction(3).isVisible(), true);
    checks.push(`${width}px: 対象がなくなった絞り込みは、別の作業に同じ区分を付けても戻らない`);

    const locker = await context.newPage();
    try {
      await locker.goto(base);
      await locker.evaluate(key => {
        navigator.locks.request(key, () => new Promise(resolve => { window.qaRelease = resolve; }));
      }, STORAGE_KEY);
      await locker.waitForFunction(() => typeof window.qaRelease === 'function');
      await nextAction(3).selectOption('ai');
      await page.locator('main[aria-busy="true"]').waitFor();
      assert.equal(await nextAction(3).isDisabled(), true);
      assert.equal(await nextAction(4).isDisabled(), true);
      await locker.evaluate(() => window.qaRelease());
      await saved();
      assert.equal(await nextAction(3).inputValue(), 'ai');
      assert.equal(await nextAction(4).isEnabled(), true);
    } finally { await locker.close(); }
    checks.push(`${width}px: 保存中は区分の選択を無効にし、保存後に選択を再開できる`);

    await nextFilter.press('End');
    assert.equal(await nextFilter.inputValue(), 'ai');
    await nextAction(3).press('ArrowUp');
    await saved();
    assert.equal(await nextAction(3).count(), 0);
    assert.equal(await nextFilter.locator('option[value="spec"]').textContent(), '仕様を決める 1件');
    assert.equal(await nextFilter.inputValue(), 'ai');
    assert.equal(await nextFilter.evaluate(select => select === document.activeElement), true);
    checks.push(`${width}px: キーボードで区分を変更して行が消えると、区分の選択欄にフォーカスが移る`);

    await nextFilter.selectOption('');
    await page.getByRole('button', { name: '区分付き2件を確認', exact: true }).press('Enter');
    const copy = page.getByRole('button', { name: '2件をコピー', exact: true });
    await copy.waitFor();
    assert.equal(await nextFilter.inputValue(), 'assigned');
    assert.equal(await page.getByRole('heading', { name: '仕様を決める 1件', exact: true }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: 'AIに渡す 1件', exact: true }).count(), 1);
    assert.equal(await copy.evaluate(button => button === document.activeElement), true);
    checks.push(`${width}px: 区分付き全件を区分ごとに確認でき、コピーの合計件数が一致する`);

    const bookingDate = new Date('2026-10-13T00:30:00Z');
    const booking = bookingSampleWorkspace(bookingDate);
    booking.projects[0].nextActions = {
      3: 'ai', 4: 'ai', 6: 'ai', 7: 'ai', 8: 'ai', 9: 'verify', 10: 'ai',
      11: 'ai', 12: 'ai', 14: 'ai', 15: 'verify', 16: 'ai', 17: 'ai',
    };
    await page.clock.setFixedTime(bookingDate);
    await page.setViewportSize({ width, height: 620 });
    await page.evaluate(({ key, booking }) => localStorage.setItem(key, JSON.stringify(booking)), { key: STORAGE_KEY, booking });
    await page.reload();
    const work = page.locator('#my-work-panel .github-work');
    const toolbar = work.locator('.next-action-filter');
    const review = work.getByRole('button', { name: '区分付き13件を確認', exact: true });
    await work.locator('[data-my-work-section="waiting"] > summary').click();
    const rowCategory = nextAction(9);
    await rowCategory.evaluate(select => window.scrollBy(0, select.getBoundingClientRect().top - 260));
    const toolbarBottom = await toolbar.evaluate(element => element.getBoundingClientRect().bottom);
    await rowCategory.evaluate((select, top) => window.scrollBy(0, select.getBoundingClientRect().top - top), toolbarBottom + 6);
    const rowTop = await rowCategory.evaluate(select => select.getBoundingClientRect().top);
    assert.ok(rowTop >= toolbarBottom && rowTop < 120, `選択欄が操作欄のすぐ下に見える（行 ${rowTop}px、操作欄 ${toolbarBottom}px）`);
    const nearTopScroll = await page.evaluate(() => window.scrollY);
    await rowCategory.selectOption('spec');
    await saved();
    assert.equal(await rowCategory.evaluate(select => select === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.scrollY), nearTopScroll, '表示済みの選択欄ではスクロールを保つ');
    await rowCategory.selectOption('verify');
    await saved();
    await nextAction(15).evaluate(select => window.scrollBy(0, select.getBoundingClientRect().top - 260));
    const initialScroll = await page.evaluate(() => window.scrollY);
    assert.ok(initialScroll > 400, '一覧の途中までスクロールしている');
    assert.ok(Math.abs((await toolbar.boundingBox()).y) < 2, '操作欄が画面の上端に残る');
    await review.press('Enter');
    await nextAction(9).focus();
    await nextAction(9).selectOption('later');
    await saved();
    assert.equal(await nextAction(9).evaluate(select => select === document.activeElement), true);
    const movedRow = await nextAction(9).evaluate(select => {
      const row = select.getBoundingClientRect();
      const toolbar = document.querySelector('#my-work-panel .next-action-filter').getBoundingClientRect();
      return { top: row.top, bottom: row.bottom, visibleTop: toolbar.bottom, visibleBottom: window.innerHeight };
    });
    assert.ok(movedRow.top >= movedRow.visibleTop && movedRow.bottom <= movedRow.visibleBottom,
      `移動した行の選択欄が操作欄と重ならず画面内にある（${JSON.stringify(movedRow)}）`);
    await nextFilter.selectOption('');
    assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - initialScroll) < 3, '同じ担当者の一覧では元の位置に戻る');
    await review.press('Enter');
    await work.getByRole('button', { name: 'Claude', exact: true }).click();
    await nextFilter.selectOption('');
    assert.ok(await work.evaluate(section => {
      const sectionTop = section.getBoundingClientRect().top + window.scrollY;
      const maximum = document.documentElement.scrollHeight - window.innerHeight;
      return Math.abs(window.scrollY - Math.min(sectionTop, maximum)) < 3;
    }), '担当者を変えると絞り込み解除後は新しい一覧の先頭を表示する');
    checks.push(`${width}px: 上部固定、表示内と移動後のフォーカス、絞り込み解除と担当者切替後の表示位置を確認した`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), testedHead, testedBlobs, checks, pageErrors: errors, fixtureOnly: true, scope: 'fresh browser contexts with fabricated snapshot; real gh disabled; no production writes' }, null, 2) + '\n');
  console.log(JSON.stringify({ checks: checks.length, pageErrors: errors, artifacts }));
} finally { await browser.close(); }
