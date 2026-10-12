import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as view from '../dist/bugs/view.mjs';

// 実際の画面のコードの「更新」を、擬似DOMと偽のAPIで動かし、タグの取得と通知の分岐を検証する。
class Element {
  constructor(tag='div') {this.tag=tag;this.children=[];this.textContent='';this.hidden=false;this.disabled=false;this.value='';this.classes=new Set();this.classList={toggle:(name,force)=>{if(force)this.classes.add(name);else this.classes.delete(name);},contains:name=>this.classes.has(name)};}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children=[...children];}
  get options() {return this.children;}
  addEventListener() {}
}

function fixture({githubEnabled=true,tags={status:200,value:{total:2,updated:2,failed:0}},reports={status:200,value:{reports:[]}}}={}) {
  const nodes=new Map(),calls=[];
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);};
  for(const selector of ['#main-filter','#sub-filter','#registration-filter','#status-filter'])node(selector).value='all';
  node('#report-form').elements={files:{}};
  const fetch=async url=>{
    const route=url.replace('/api/bugs/','');calls.push({route,buttonDisabled:node('#refresh').disabled});
    const result=route==='github/tags'?tags:route==='reports'?reports:null;
    if(!result)throw new Error('Unexpected request: '+route);
    return{ok:result.status<400,status:result.status,json:async()=>result.value};
  };
  // 画面のコードのimportは取り除くため、読み込む表示用の関数は、globalとして渡す。読み込み時に呼ぶmountTagRolesは、何もしない模擬にする。
  const context=vm.createContext({...view,mountTagRoles:()=>({load:async()=>{},tags:()=>[]}),document:{querySelector:node,createElement:tag=>new Element(tag)},fetch,URL,location:{href:'http://127.0.0.1:4327/bugs/'},history:{replaceState(){}},crypto:{randomUUID:()=>'id'},
    setTimeout:()=>0,clearTimeout(){}});
  const source=readFileSync(new URL('../dist/bugs/app.mjs',import.meta.url),'utf8');
  const app=source.replace(/^import .*\n/gm,''),end=app.lastIndexOf('\ntry { showActor');
  assert.ok(source.startsWith('import ')&&end>0,'App import and bootstrap boundaries must exist');
  vm.runInContext(app.slice(0,end),context);
  vm.runInContext('actor={id:"local-shared",role:"admin",shared:true,github:{enabled:'+githubEnabled+',repository:"qa/booking-reports"}};',context);
  return {
    calls,
    notice:()=>({text:node('#notice').textContent,error:node('#notice').classList.contains('error'),hidden:node('#notice').hidden}),
    button:()=>node('#refresh'),
    click:()=>node('#refresh').onclick()
  };
}

test('「更新」は、タグをまとめて取得してから報告を読み直し、処理中はボタンを押せなくして、終わると戻す',async()=>{
  const fx=fixture();await fx.click();
  assert.deepEqual(fx.calls,[{route:'github/tags',buttonDisabled:true},{route:'reports',buttonDisabled:true}]);
  assert.deepEqual(fx.notice(),{text:'最新の受付情報を読み込みました。',error:false,hidden:false});
  assert.equal(fx.button().disabled,false);
});
test('一部の報告でタグを取得できなかったときは、件数を示す警告を出し、報告は読み直す',async()=>{
  const fx=fixture({tags:{status:200,value:{total:5,updated:3,failed:2}}});await fx.click();
  assert.deepEqual(fx.calls.map(call=>call.route),['github/tags','reports']);
  const notice=fx.notice();assert.equal(notice.error,true);
  assert.match(notice.text,/タグを取得できなかった報告が2件あります/);assert.match(notice.text,/前回の結果を保持/);
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
