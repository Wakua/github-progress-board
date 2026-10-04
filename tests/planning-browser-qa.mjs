import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { buildSnapshot, attachSnapshot } from '../dist/github-snapshot.mjs';
import { buildPlanning } from '../scripts/github-planning-fetch.mjs';
import { hierarchyFixture, qaWorkspace, QA_REPOSITORIES } from './local-github-fixture.mjs';
import { STORAGE_KEY } from '../dist/workspace.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = path.join(process.env.QA_ARTIFACT_DIR || 'node_modules/.qa-planning', 'planning');
await mkdir(artifacts, { recursive: true });
const testedHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceFiles = ['dist/app.mjs', 'dist/github-planning.mjs', 'dist/github-planning-view.mjs', 'dist/github-planning.css', 'dist/github-snapshot.mjs', 'dist/workspace.mjs', 'dist/index.html', 'tests/planning-browser-qa.mjs'];
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
    assert.match(await summary.innerText(), /QAモジュール/); assert.match(await summary.innerText(), /50%/);
    assert.match(await summary.innerText(), /見積未設定 1件を除外/); assert.match(await summary.innerText(), /残り/);
    await page.screenshot({ path: path.join(artifacts, `${width}-collapsed.png`), fullPage: true });
    await summary.click();
    const goal = module.locator('[data-github-disclosure^="goal:"]'); await goal.locator(':scope > summary').click();
    assert.equal(await goal.locator('.tree [data-action="github-item"]').count(), 4);
    const release = module.locator('[data-github-disclosure^="release:"]'); await release.locator(':scope > summary').click();
    assert.equal(await release.locator('[data-github-task]').count(), 3);
    assert.match(await release.innerText(), /2026-10-18/);
    await page.screenshot({ path: path.join(artifacts, `${width}-expanded.png`), fullPage: true });
    checks.push(`${width}px: collapsed module expands to goal and release; leaf-only 50% excludes one unset estimate and displays remaining points`);
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
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), testedHead, testedBlobs, checks, pageErrors: errors, fixtureOnly: true, scope: 'fresh browser contexts with fabricated snapshot; real gh disabled; no production writes' }, null, 2) + '\n');
  console.log(JSON.stringify({ checks: checks.length, pageErrors: errors, artifacts }));
} finally { await browser.close(); }
