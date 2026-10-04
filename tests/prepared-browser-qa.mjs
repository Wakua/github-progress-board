import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { startCloudPreview } from './cloud-preview.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const expected = JSON.parse(await readFile(new URL('../samples/prepared-workspace.json', import.meta.url)));
const preview = await startCloudPreview();
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const contexts = [], errors = [], checks = [];
const artifacts = process.env.PREPARED_QA_ARTIFACT_DIR || '/tmp/progress-prepared-qa';
await mkdir(artifacts, { recursive: true });
const ready = page => page.waitForFunction(() => document.querySelector('#storage-label').textContent === 'クラウド保存');
const saved = page => page.waitForFunction(() => !document.querySelector('main').hasAttribute('aria-busy'));
const record = page => page.evaluate(async () => (await fetch('/api/workspace')).json());
const close = async page => { if (await page.locator('#detail-dialog').isVisible()) await page.locator('#close-dialog').click(); };
async function pageFor(user, width = 390) {
 const context = await browser.newContext({viewport:{width,height:844}});contexts.push(context);
 await context.addCookies([{name:'qa-user',value:user,url:preview.origin}]);
 const page = await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('download',()=>errors.push('Unexpected download'));
 await page.goto(preview.origin);await ready(page);return page;
}
async function open(page) {await page.locator('#prepared-workspace').click();await page.locator('#drawer-body').getByText('新規', {exact:false}).waitFor();}
async function submit(page) {await page.getByRole('button',{name:'確認してクラウドに追加',exact:true}).click();await saved(page);}
async function seed(page,workspace) {
 const result = await page.evaluate(async workspace => {
  const current=await (await fetch('/api/workspace')).json();
  return (await fetch('/api/workspace',{method:'PUT',headers:{'Content-Type':'application/json','X-Progress-Write':'1'},body:JSON.stringify({baseVersion:current.version,expectedUserId:current.userId,operationId:crypto.randomUUID(),workspace})})).status;
 },workspace);assert.equal(result,200);await page.reload();await ready(page);
}
try {
 // No production identity or database is used: every context uses the existing loopback mock.
 const anonymous=await fetch(preview.origin+'/prepared-workspace.json');assert.equal(anonymous.status,401);
 const forged=await fetch(preview.origin+'/prepared-workspace.json',{headers:{'oai-authenticated-user-id':'qa-owner'}});assert.equal(forged.status,401);
 checks.push('Prepared snapshot remains behind the same Worker gate; anonymous and forged-header requests fail in loopback harness (not real Sites verification)');
 const phone=await pageFor('qa-prepared');let puts=0;phone.on('request',r=>{if(r.method()==='PUT')puts++;});
 await open(phone);assert.equal((await record(phone)).version,0);assert.equal(await phone.locator('#drawer-body input[type=file]').count(),0);assert.equal(await phone.locator('#migration-backup-confirmed').count(),0);
 assert.equal(await phone.locator('.migration-projects li').count(),3);assert.match(await phone.locator('#drawer-body').innerText(),/2026年10月4日/);
 assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await phone.screenshot({path:artifacts+'/phone-preview.png',fullPage:true});
 await submit(phone);assert.equal(puts,1);let r=await record(phone);assert.deepEqual(r.workspace.projects,expected.projects);assert.equal(r.version,1);
 await phone.reload();await ready(phone);await open(phone);assert.match(await phone.locator('#drawer-body').innerText(),/すべて取込済み/);assert.equal(await phone.locator('[data-form=migrate-prepared]').count(),0);assert.equal((await record(phone)).version,1);
 checks.push('390px phone: exact 3 projects / 18 tasks imported after one confirmation, no files/downloads, reload persists, repeated attempt adds nothing');
 const pc=await pageFor('qa-prepared',1440);assert.deepEqual((await record(pc)).workspace.projects,expected.projects);await pc.screenshot({path:artifacts+'/desktop-imported.png',fullPage:true});
 const partial=await pageFor('qa-partial');await seed(partial,{...structuredClone(expected),selectedProjectId:null,projects:[expected.projects[0]]});await open(partial);assert.match(await partial.locator('#drawer-body').innerText(),/新規 2プロジェクト/);await submit(partial);assert.deepEqual((await record(partial)).workspace.projects,expected.projects);
 checks.push('Partially imported identical ID is preserved; only 2 missing projects added; independent desktop context loads the phone data');
 const conflict=await pageFor('qa-conflict');const differing=structuredClone(expected);differing.projects=[differing.projects[0]];differing.selectedProjectId=null;differing.projects[0].name+=' changed';differing.projects[0].data.project=differing.projects[0].name;await seed(conflict,differing);
 await conflict.locator('#prepared-workspace').click();await conflict.locator('#drawer-body [role=alert]').waitFor();assert.equal(await conflict.locator('[data-form=migrate-prepared]').count(),0);assert.deepEqual((await record(conflict)).workspace,differing);
 checks.push('Conflicting existing ID stops the whole import without modifying any data');
 const failed=await pageFor('qa-failed');await failed.route('**/prepared-workspace.json',route=>route.abort());await failed.locator('#prepared-workspace').click();await failed.locator('#panel-error').waitFor();assert.equal((await record(failed)).version,0);await failed.unroute('**/prepared-workspace.json');await close(failed);await open(failed);
 await failed.route('**/api/workspace',route=>route.request().method()==='PUT'?route.fulfill({status:503,contentType:'application/json',body:'{"error":"isolated save failure"}'}):route.continue());await submit(failed);assert.equal((await record(failed)).version,0);assert.match(await failed.locator('#storage-problem').innerText(),/保存結果を確認/);await failed.unroute('**/api/workspace');await failed.reload();await ready(failed);await open(failed);await submit(failed);assert.equal((await record(failed)).version,1);
 checks.push('Snapshot load failure leaves DB untouched; failed PUT never claims success; explicit reload and retry succeeds without files');
 const lost=await pageFor('qa-lost');let lostPuts=0;await lost.route('**/api/workspace',async route=>{if(route.request().method()!=='PUT')return route.continue();lostPuts++;await route.fetch();await route.abort();});await open(lost);await submit(lost);assert.equal(lostPuts,1);await lost.unroute('**/api/workspace');await lost.reload();await ready(lost);await open(lost);assert.match(await lost.locator('#drawer-body').innerText(),/すべて取込済み/);assert.equal((await record(lost)).version,1);
 checks.push('Lost acknowledgement is not auto-retried; reload discovers committed records and prevents duplicate import');
 const doubled=await pageFor('qa-double');await open(doubled);let doublePuts=0;let release;const gate=new Promise(resolve=>release=resolve);await doubled.route('**/api/workspace',async route=>{if(route.request().method()!=='PUT')return route.continue();doublePuts++;await gate;await route.continue();});
 await doubled.locator('[data-form=migrate-prepared]').evaluate(form=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 await doubled.waitForFunction(()=>document.querySelector('main').hasAttribute('aria-busy'));release();await saved(doubled);assert.equal(doublePuts,1);assert.equal((await record(doubled)).version,1);
 checks.push('Double submit during pending save performs exactly one write');
 assert.deepEqual(errors,[]);const result={checkedAt:new Date().toISOString(),checks,pageErrors:errors,scope:'isolated local SQLite + simulated auth only; no production writes'};await writeFile(artifacts+'/results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {for(const c of contexts)await c.close();await browser.close();await preview.stop();}
