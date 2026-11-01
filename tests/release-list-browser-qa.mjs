import assert from 'node:assert/strict';
import { attachSnapshot } from '../dist/github-snapshot.mjs';
import { STORAGE_KEY } from '../dist/workspace.mjs';
import { ganttSnapshot, repositoryUrl } from './gantt-fixture.mjs';
import { qaWorkspace } from './local-github-fixture.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ viewport:{ width:800, height:800 } });
  const snapshot = ganttSnapshot('inherited');
  const [closed, accepted] = snapshot.planning.milestones;
  closed.state = 'closed';
  closed.closedAt = closed.updatedAt;
  const version = repositoryUrl + '/releases/tag/v1.4.0';
  accepted.description = '受入: 済\n公開版: ' + version;
  snapshot.planning.milestones.push({ ...accepted, number:3, url:repositoryUrl + '/milestone/3',
    title:'リリースC', description:'受入: 確認中', dueOn:null });

  const workspace = qaWorkspace();
  workspace.projects = workspace.projects.slice(0,1);
  workspace.projects[0].repositoryUrl = repositoryUrl;
  attachSnapshot(workspace.projects[0],snapshot);
  let hold;
  await page.route('**/api/local-github', route => route.fulfill({ json:{
    schemaVersion:1, csrfToken:'a'.repeat(64), repositories:[repositoryUrl],
  } }));
  await page.route('**/api/github/refresh', async route => {
    if (hold) await hold;
    await route.fulfill({ json:{ ...snapshot, fetchedAt:new Date().toISOString() } });
  });
  await page.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:4340/');
  await page.evaluate(([key, data]) => localStorage.setItem(key,JSON.stringify(data)), [STORAGE_KEY,workspace]);
  await page.reload();
  await page.getByRole('tab',{ name:'リリース',exact:true }).click();
  const panel = page.locator('#release-panel');
  const region = name => panel.getByRole('region',{ name,exact:true });
  const choose = (scope,m) => scope.getByRole('button',{ name:m.title + 'の詳細',exact:true });
  const row = (scope,m) => choose(scope,m).locator('..');
  const unaccepted = region('未完了'), done = region('完了');
  await choose(unaccepted,closed).waitFor();
  assert.match(await row(unaccepted,closed).innerText(),/受入未記録/);
  assert.match(await unaccepted.innerText(),/受入確認中/);
  assert.equal(await done.getByRole('link',{name:'v1.4.0 公開済み'}).getAttribute('href'),version);
  assert.equal(await panel.locator('.gantt').count(),0);

  await choose(done,accepted).press('Enter');
  await region(accepted.title).waitFor();
  await choose(unaccepted,closed).press('Space');
  const inheritedChild = region(closed.title).getByRole('button',{name:/^#201 /});
  assert.match(await region(closed.title).innerText(),/日程計算の対象外/);
  await inheritedChild.click();
  await page.locator('#detail-dialog[open]').waitFor();
  assert.match(await page.locator('#detail-dialog').innerText(),/変更内容を保存する/);
  await page.keyboard.press('Escape');

  let resume;
  hold = new Promise(resolve => { resume = resolve; });
  const pending = page.waitForRequest('**/api/github/refresh');
  closed.description = '受入: 済';
  await panel.getByRole('button',{ name:'GitHubを再取得',exact:true }).click();
  await pending;
  await choose(unaccepted,closed).focus();
  resume();
  await choose(done,closed).waitFor();
  assert.equal(await choose(done,closed).getAttribute('aria-pressed'),'true');
  assert.ok(await choose(done,closed).evaluate(el => el === document.activeElement));
  assert.equal(await row(done,closed).getByRole('link').count(),0);
  assert.ok(await inheritedChild.isVisible());
  console.log('リリース一覧の受入と公開、Closedの作業詳細、再取得後の選択とフォーカスを確認した。');
} finally { await browser.close(); }
