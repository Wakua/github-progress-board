// Chromium integration checks with isolated, fictional booking reports.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {BugStore} from '../server/bug-store.mjs';
import {GitHubWorker} from '../server/bug-github-worker.mjs';
import {createProgressServer} from '../server.mjs';

async function seed(dataDir) {
  const store=new BugStore(dataDir,{initialize:true}),actor=store.sharedActor();
  const tags=[['予約','main'],['一覧','sub'],['通知','main'],['決済','main'],['画面','sub'],['bug','none']]
    .map(([name,role],index)=>({id:index+1,name,role,color:'336699'}));
  const local=store.createReport(actor,{body:'予約の確認メールの日付がずれる\n架空の予約管理アプリで日付を確認する。',reportedVersion:'S-1',requestId:randomUUID(),uploadIds:[]});
  const repository='qa-fixture/booking-reports',issues=[];
  const github={repository,
    async createIssue(title,body){const number=101+issues.length,issue={number,title,body,html_url:'https://github.com/'+repository+'/issues/'+number,labels:github.labels};issues.push(issue);return issue;},
    async getIssue(number){return issues.find(issue=>issue.number===number);},
    async findIssues(marker){return issues.filter(issue=>issue.body.startsWith(marker+'\n'));}
  };
  const worker=new GitHubWorker(store,github);
  const fixtures=[
    {title:'予約一覧が更新されない',body:'翌日に移動すると前の予約枠が残る。再読込で QA-CSV を確認する。',labels:[1,2],status:'working',area:'予約 / 一覧'},
    {title:'予約の確認画面が崩れる',body:'再読込すると入力欄が重なる。',labels:[1,5],area:'予約 / 画面'},
    {title:'支払いの合計がずれる',body:'再読込すると合計が変わる。',labels:[4],area:'決済'},
    {title:'CSVが文字化けする',labels:[6],area:''},
    {title:'ヘルプが開かない',labels:[],area:''},
    {title:'会員登録の画面が小さい',labels:[5],status:'complete',area:'画面'},
    {title:'予約と通知の一覧が重なる',body:'再読込すると一覧が重なる。',labels:[1,3,2],area:'予約・通知 / 一覧'},
    {title:'通知メールが届かない',labels:[3],status:'working',area:'通知'}
  ];
  try {
    for(const fixture of fixtures) {
      github.labels=fixture.labels.map(id=>{const {role,...tag}=tags[id-1];return tag;});
      let report=store.createReport(actor,{body:fixture.title+'\n'+(fixture.body||'架空の予約管理アプリで再現手順を確認する。'),reportedVersion:'S-1',requestId:randomUUID(),uploadIds:[]});
      await worker.processOne();
      report=store.getReport(actor,report.id);
      assert.equal(report.github.state,'registered');assert.equal(report.github.tags.state,'ok');
      while(report.status!==(fixture.status||'received')) {
        const input={revision:report.revision,requestId:randomUUID(),targetVersion:'S-2',developerNote:''};
        report=report.status==='checking'?store.recordConfirmation(actor,report.id,{...input,version:'S-2',result:'resolved',note:''}).report:store.updateStatus(actor,report.id,input);
      }
      fixture.number=report.github.number;
    }
    store.setTagRoles(actor,{roles:tags.map(({id,role})=>({id,role}))});
    return {github,fixtures,local};
  } finally {await worker.stop();store.close();}
}

export async function checkBugList({browser,artifacts,checks,errors}) {
  const dataDir=await mkdtemp(path.join(tmpdir(),'github-board-bug-list-qa-'));
  let server,context;
  try {
    const {github,fixtures,local}=await seed(dataDir);
    server=createProgressServer({repositories:[],dataDir,githubRepository:github.repository,githubClient:github});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    context=await browser.newContext({viewport:{width:1440,height:1000}});
    context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
    const page=await context.newPage(),all=[local.title,...fixtures.map(item=>item.title)];
    const title=Object.fromEntries(fixtures.map((item,index)=>[index,item.title]));
    const row=name=>page.locator('.report-row').filter({has:page.getByText(name,{exact:true})});
    const group=id=>page.locator('[data-filter="'+id+'"]');
    const capture=async name=>{await mkdir(artifacts,{recursive:true});await page.locator('.list').screenshot({path:path.join(artifacts,name+'.jpg'),type:'jpeg',quality:60,animations:'disabled'});};
    async function rows(expected) {
      await page.waitForFunction(({titles,total})=>{
        const shown=[...document.querySelectorAll('.report-row .report-title')].map(node=>node.textContent).sort();
        return JSON.stringify(shown)===JSON.stringify(titles)&&document.querySelector('#report-count').textContent===titles.length+' / '+total+'件';
      },{titles:[...expected].sort(),total:all.length});
      assert.deepEqual((await page.locator('.report-row .report-title').allTextContents()).sort(),[...expected].sort());
    }
    async function choose(id,value,on=true) {
      const menu=group(id);
      if(!await menu.evaluate(node=>node.open))await menu.locator('summary').click();
      await menu.locator('input[value="'+value+'"]').setChecked(on);
      await page.locator('#list-heading').click();
    }
    async function clear(id) {
      const menu=group(id);
      if(!await menu.evaluate(node=>node.open))await menu.locator('summary').click();
      await menu.getByRole('button',{name:'解除',exact:true}).click();
      await page.locator('#list-heading').click();
    }
    async function search(query,expected) {
      const response=query.trim()?page.waitForResponse(res=>new URL(res.url()).pathname==='/api/bugs/reports/search'&&res.request().postDataJSON().query===query.trim()):null;
      await page.locator('#search').fill(query);
      if(response)await response;
      await rows(expected);
    }
    await page.goto(base+'/bugs/');await rows(all);
    for(const fixture of fixtures) {
      const item=row(fixture.title);
      assert.equal(await item.locator('.report-number').textContent(),'#'+fixture.number);
      assert.equal(await item.locator('.report-area').count(),fixture.area?1:0);
      if(fixture.area)assert.equal(await item.locator('.report-area').textContent(),fixture.area);
      assert.equal(await item.locator('.row-states .workflow-'+(fixture.status||'received')).count(),1);
      assert.equal(await item.locator('.meta,.tags,.file-list,a').count(),0);
    }
    assert.equal(await row(local.title).locator('.report-number,.report-area').count(),0);
    assert.equal(await row(local.title).getByText('GitHub未登録',{exact:true}).count(),1);
    await row(title[0]).click();await page.locator('#detail h2').filter({hasText:title[0]}).waitFor();
    assert.match(await page.locator('#detail .report-body').textContent(),/QA-CSV/);
    const layout=await page.evaluate(()=>{
      const list=document.querySelector('.list').getBoundingClientRect(),detail=document.querySelector('#detail').getBoundingClientRect();
      return {listRight:list.right,detailLeft:detail.left,rowsInside:[...document.querySelectorAll('.report-row')].every(node=>{const box=node.getBoundingClientRect();return box.left>=list.left&&box.right<=list.right;})};
    });
    assert.ok(layout.listRight<=layout.detailLeft);assert.equal(layout.rowsInside,true);
    await capture('07-list-and-areas');checks.push('一覧の題名・Issue番号・対応状況・領域、登録前の行、一覧と詳細の領域を確認する');

    // タイトルにない語、英字の大小、全角空白、すべての語との一致を、実際の検索APIで確認する。
    await search('再読込　qa-csv',[title[0]]);await capture('08-body-search');
    await search('再読込',[title[0],title[1],title[2],title[6]]);
    await search('存在しない検索語',[]);
    assert.equal(await page.locator('#reports .empty').textContent(),'条件に一致する報告はありません。');
    await search('',all);checks.push('本文だけにある語・英字の大小・複数語で検索し、一致なしと検索解除を確認する');

    await choose('sub','label:5');await rows([title[1],title[5]]);
    await choose('sub','label:2');await rows([title[0],title[1],title[5],title[6]]);
    await clear('sub');await choose('main','label:1');await rows([title[0],title[1],title[6]]);
    await choose('main','label:4');await rows([title[0],title[1],title[2],title[6]]);
    await choose('sub','label:2');await rows([title[0],title[6]]);
    await search('qa-csv',[title[0]]);await capture('09-combined-filters');
    checks.push('サブ単独・サブの複数選択・メインの複数選択と、メイン＋サブ＋本文検索の組合せを確認する');

    await search('',[title[0],title[6]]);
    await clear('sub');await choose('sub','label:5');await rows([title[1]]);
    await choose('main','label:1',false);await rows([title[2]]);
    assert.equal(await group('sub').isVisible(),false);
    assert.equal(await group('sub').locator('input:checked').count(),0);
    await clear('main');await rows(all);
    await choose('main','uncategorized');await rows([local.title,title[3],title[4]]);
    assert.equal(await group('sub').isVisible(),false);
    await capture('10-uncategorized');
    await clear('main');await rows(all);
    await choose('sub','label:5');await rows([title[1],title[5]]);
    await choose('status','incomplete');await rows([title[1]]);
    await clear('status');await clear('sub');await rows(all);
    checks.push('メインの変更で無効なサブが解除され、未分類にはタグなし・使わないタグ・未登録を含み、サブだけの報告を含まない。対応状況とも重ねられる');

    await choose('main','label:1');await choose('sub','label:2');
    await search('qa-csv',[title[0]]);
    const failure=async route=>route.fulfill({status:503,json:{error:'QA: 本文を検索できませんでした。'}});
    await page.route('**/api/bugs/reports/search',failure);
    await search('再読込',[title[0],title[6]]);
    assert.equal(await page.locator('#notice.error').textContent(),'QA: 本文を検索できませんでした。');
    assert.equal(await page.locator('#notice').isVisible(),true);
    assert.equal(await group('main').locator('input:checked').count(),1);
    assert.equal(await group('sub').locator('input:checked').count(),1);
    await capture('11-search-failure');
    const noticeBox=await page.locator('#notice').boundingBox();
    await page.screenshot({path:path.join(artifacts,'11-search-failure-notice.jpg'),type:'jpeg',quality:60,clip:{...noticeBox,width:Math.min(800,noticeBox.width)},animations:'disabled'});
    await page.unroute('**/api/bugs/reports/search',failure);
    await search('qa-csv',[title[0]]);await page.locator('#notice').waitFor({state:'hidden'});
    await search('a b c d e f g h i j k',[title[0],title[6]]);
    assert.match(await page.locator('#notice.error').textContent(),/10語/);
    await search('',[title[0],title[6]]);await page.locator('#notice').waitFor({state:'hidden'});
    checks.push('検索APIの503と入力制限の400で古い検索結果を外し、カテゴリ条件と理由を残す。再検索・検索解除で通知が消える');

    await search('再読込',[title[0],title[6]]);
    const refreshed=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/bugs/reports/search'&&res.request().postDataJSON().query==='再読込');
    await page.getByRole('button',{name:'更新',exact:true}).click();await refreshed;await rows([title[0],title[6]]);
    await page.reload();await rows(all);assert.equal(await page.locator('#filter-groups input:checked').count(),0);
    checks.push('更新時は同じ語を検索し直し、再読み込みでは検索とカテゴリ条件を初期化する');

    await page.goto(base+'/bugs/');await rows(all);
    await page.setViewportSize({width:390,height:844});
    await choose('main','label:1');await choose('sub','label:2');await search('qa-csv',[title[0]]);
    await capture('12-mobile-filtered-list');await row(title[0]).click();
    await page.locator('#detail.mobile-open').waitFor();assert.equal(await page.locator('.list').isVisible(),false);
    await page.getByRole('button',{name:'← 報告一覧へ',exact:true}).click();await rows([title[0]]);
    assert.equal(await page.locator('.list').isVisible(),true);
    checks.push('幅390pxでも検索とメイン・サブを操作し、詳細から戻ると絞り込んだ一覧が残る');
  } finally {
    await context?.close();
    if(server){await new Promise(resolve=>server.close(resolve));await server.bugClosed;}
    const relative=path.relative(tmpdir(),dataDir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
    await rm(dataDir,{recursive:true,force:true});
  }
}
