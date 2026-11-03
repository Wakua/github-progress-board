import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createBugDom,loadBugApp} from './support/bug-ui.mjs';
import {createFilterPanelStub} from './filter-panel-stub.mjs';
import * as view from '../dist/bugs/view.mjs';

// 実際の画面のコードの「更新」を、擬似DOMと偽のAPIで動かし、タグの取得と通知の分岐を検証する。

function fixture({loadFailure=null,githubEnabled=true,tags={status:200,value:{total:2,updated:2,failed:0}},reports={status:200,value:{reports:[]}}}={}) {
  const calls=[];
  const {node,document}=createBugDom();
  node('#report-form').elements={files:{}};
  const fetch=async url=>{
    const route=url.replace('/api/bugs/','');calls.push({route,buttonDisabled:node('#refresh').disabled});
    const result=route==='github/tags'?tags:route==='reports'?reports:null;
    if(!result)throw new Error('Unexpected request: '+route);
    return{ok:result.status<400,status:result.status,json:async()=>result.value};
  };
  const panel=createFilterPanelStub();
  const context=vm.createContext({...view,mountFilterPanel:panel.mountFilterPanel,mountTagRoles:()=>({load:async()=>loadFailure,tags:()=>[]}),document,fetch,URL,location:{href:'http://127.0.0.1:4327/bugs/'},history:{replaceState(){}},crypto:{randomUUID:()=>'id'},
    setTimeout:()=>0,clearTimeout(){}});
  loadBugApp(context);
  vm.runInContext('actor={id:"local-shared",role:"admin",shared:true,github:{enabled:'+githubEnabled+',repository:"qa/booking-reports"}};',context);
  return {
    calls,
    notice:()=>({text:node('#notice').textContent,error:node('#notice').classList.contains('error'),hidden:node('#notice').hidden}),
    button:()=>node('#refresh'),
    click:()=>node('#refresh').onclick(),
    choose:panel.choose,
    count:()=>node('#report-count').textContent
  };
}

test('「更新」は、タグをまとめて取得してから報告を読み直し、処理中はボタンを押せなくして、終わると戻す',async()=>{
  const fx=fixture();await fx.click();
  assert.deepEqual(fx.calls,[{route:'github/tags',buttonDisabled:true},{route:'reports',buttonDisabled:true}]);
  assert.deepEqual(fx.notice(),{text:'最新の受付情報を読み込みました。',error:false,hidden:false});
  assert.equal(fx.button().disabled,false);
});
const row=(id,state='error',repository='qa/booking-reports')=>({id,title:id,status:'received',github:{state:'registered',repository,tags:{state,labels:[]}}});
test('取得失敗の通知は、読み直した報告から数え、絞り込みと同じ件数を示す',async()=>{
  const fx=fixture({tags:{status:200,value:{total:3,updated:2,failed:1}},reports:{status:200,value:{reports:[row('current'),row('old','error','qa/old-repository'),row('ok','ok')]}}});await fx.click();
  assert.deepEqual(fx.calls.map(call=>call.route),['github/tags','reports']);
  const notice=fx.notice();assert.equal(notice.error,true);
  assert.match(notice.text,/タグ取得失敗：2件/);
  fx.choose('#tags-filter','error');assert.equal(fx.count(),'2 / 3件');
});
test('再取得中に別の操作で取得状況が変わっても、通知は読み直した一覧と一致する',async()=>{
  const fx=fixture({tags:{status:200,value:{total:1,updated:0,failed:1}},reports:{status:200,value:{reports:[row('recovered','ok')]}}});await fx.click();
  assert.equal(fx.notice().error,false);
  fx.choose('#tags-filter','error');assert.equal(fx.count(),'0 / 1件');
});
test('タグの取得そのものに失敗しても、理由を添えた警告を出し、報告は読み直す',async()=>{
  const fx=fixture({tags:{status:503,value:{error:'GitHubの利用制限が解除されるまで待ってください。'}}});await fx.click();
  assert.deepEqual(fx.calls.map(call=>call.route),['github/tags','reports']);
  const notice=fx.notice();assert.equal(notice.error,true);
  assert.match(notice.text,/GitHubのタグは取得できませんでした/);assert.match(notice.text,/利用制限が解除されるまで待ってください/);assert.match(notice.text,/前回の結果を保持/);
  assert.equal(fx.button().disabled,false);
});
test('GitHubの接続が無効なときは、タグを取得せず、報告だけを読み直す',async()=>{
  const fx=fixture({githubEnabled:false});await fx.click();
  assert.deepEqual(fx.calls.map(call=>call.route),['reports']);
  assert.deepEqual(fx.notice(),{text:'最新の受付情報を読み込みました。',error:false,hidden:false});
});
test('報告を読み直せなかったときは、理由を出し、ボタンを戻す',async()=>{
  const fx=fixture({reports:{status:500,value:{error:'保存処理を完了できませんでした。'}}});await fx.click();
  assert.deepEqual(fx.notice(),{text:'保存処理を完了できませんでした。',error:true,hidden:false});
  assert.equal(fx.button().disabled,false);
});

test('タグの役割を読み込めなかったときは、「更新」の通知に、その旨と理由を出す',async()=>{
  const fx=fixture({loadFailure:new Error('保存処理を完了できませんでした。')});await fx.click();
  const notice=fx.notice();assert.equal(notice.error,true);
  assert.match(notice.text,/最新の受付情報を読み込みました/);assert.match(notice.text,/タグの役割を読み込めませんでした/);assert.match(notice.text,/保存処理を完了できませんでした/);
  assert.equal(fx.button().disabled,false);
});
