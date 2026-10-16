import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as view from '../dist/bugs/view.mjs';

// 実際の画面のコードの「対応状況と次の操作」の帯を、擬似DOMと偽のAPIで動かし、入力欄の開き方と送信を検証する。
class Element {
  constructor(tag='div') {this.tag=tag;this.children=[];this.textContent='';this.hidden=false;this.disabled=false;this.value='';this.className='';this.name='';this.listeners={};this.classList={toggle(){}};}
  focus() {Element.active=this;}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children=[...children];}
  get options() {return this.children;}
  addEventListener() {}
  descendants() {return this.children.flatMap(child=>[child,...child.descendants()]);}
  // フォームの入力欄を、順番どおりの配列と、名前での参照の両方で返す。
  get elements() {
    const found=this.descendants().filter(child=>['input','textarea','select'].includes(child.tag)||child.tag==='button');
    return Object.assign(found,Object.fromEntries(found.filter(child=>child.name).map(child=>[child.name,child])));
  }
}
const report=(overrides={})=>({id:'r1',title:'予約一覧が更新されない',status:'received',revision:3,targetVersion:'',developerNote:'',isOwn:true,...overrides});

function fixture({role='admin',shared=false,fail=null}={}) {
  const nodes=new Map(),requests=[];
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);};
  Object.defineProperty(node('#report-form'),'elements',{value:{files:{}}});
  const fetch=async (url,options={})=>{
    const route=url.replace('/api/bugs/','');
    if(route==='reports')return{ok:true,status:200,json:async()=>({reports:[]})};
    requests.push({route,body:JSON.parse(options.body)});
    if(fail)return{ok:false,status:fail.status,json:async()=>({error:fail.error})};
    return{ok:true,status:200,json:async()=>({matchesTarget:true})};
  };
  const context=vm.createContext({...view,mountTagRoles:()=>({load:async()=>null,tags:()=>[]}),document:{querySelector:node,createElement:tag=>new Element(tag)},fetch,URL,location:{href:'http://127.0.0.1:4327/bugs/'},crypto:{randomUUID:()=>'request-1'},
    setTimeout:()=>0,clearTimeout(){}});
  const source=readFileSync(new URL('../dist/bugs/app.mjs',import.meta.url),'utf8');
  const app=source.replace(/^import .*\n/gm,''),end=app.lastIndexOf('\ntry { showActor');
  assert.ok(source.startsWith('import ')&&end>0,'App import and bootstrap boundaries must exist');
  vm.runInContext(app.slice(0,end),context);
  vm.runInContext('actor={id:"local-shared",role:"'+role+'",shared:'+shared+',github:{enabled:false}};',context);
  return {
    requests,notice:()=>node('#notice').textContent,
    build:value=>{context.__report=value;return vm.runInContext('renderWorkflow(__report)',context);}
  };
}
const buttons=box=>box.descendants().filter(child=>child.tag==='button');
const named=(box,text)=>buttons(box).find(button=>button.textContent===text);
const form=box=>box.children.find(child=>child.tag==='form');
const visibleNames=box=>buttons(box).filter(button=>!button.hidden&&!(form(box).hidden&&form(box).descendants().includes(button))).map(button=>button.textContent);

test('受付済みと対応中は、入力欄を閉じたまま、ボタン1回で次へ進め、既存のバージョンと連絡を保つ',async()=>{
  for(const [status,label] of [['received','対応を始める'],['working','修正済み・公開待ちにする']]) {
    const fx=fixture(),box=fx.build(report({status,targetVersion:'QA-1',developerNote:'調査中です。'}));
    assert.equal(form(box).hidden,true);assert.deepEqual(visibleNames(box),[label,'入力して進める']);
    await named(box,label).onclick();
    assert.deepEqual(fx.requests,[{route:'reports/r1/status',body:{targetVersion:'QA-1',developerNote:'調査中です。',revision:3,requestId:'request-1'}}]);
    assert.equal(fx.notice(),'対応状況を更新しました。');
  }
});
test('「入力して進める」で入力欄が帯の下に開き、同じ名前のボタンが2つ並ばず、閉じると戻る',async()=>{
  const fx=fixture(),box=fx.build(report());
  named(box,'入力して進める').onclick();
  assert.equal(form(box).hidden,false);assert.deepEqual(visibleNames(box),['対応を始める','閉じる']);
  form(box).elements.developerNote.value='調査を始めます。';
  await form(box).onsubmit({preventDefault(){}});
  assert.deepEqual(fx.requests.map(request=>request.body.developerNote),['調査を始めます。']);
  named(box,'閉じる').onclick();
  assert.equal(form(box).hidden,true);assert.deepEqual(visibleNames(box),['対応を始める','入力して進める']);
});
test('修正済みから確認待ちへは、バージョンの指定が要るため、入力欄を開いてから送る',async()=>{
  const fx=fixture(),box=fx.build(report({status:'fixed'}));
  assert.deepEqual(visibleNames(box),['公開してテスターへ確認を依頼する…']);
  named(box,'公開してテスターへ確認を依頼する…').onclick();
  assert.deepEqual(visibleNames(box),['公開してテスターへ確認を依頼する','閉じる']);
  assert.equal(form(box).elements.targetVersion.required,true);
  form(box).elements.targetVersion.value='QA-2';
  await form(box).onsubmit({preventDefault(){}});
  assert.deepEqual(fx.requests.map(request=>request.body.targetVersion),['QA-2']);
});
test('確認待ちの報告は、確認結果の入力欄を開いてから送る',async()=>{
  const fx=fixture({shared:true}),box=fx.build(report({status:'checking',targetVersion:'QA-2'}));
  assert.deepEqual(visibleNames(box),['確認結果を入力する']);
  named(box,'確認結果を入力する').onclick();
  assert.deepEqual(visibleNames(box),['確認結果を送る','閉じる']);
  const elements=form(box).elements;elements.version.value='QA-2';elements.result.value='resolved';elements.note.value='';
  await form(box).onsubmit({preventDefault(){}});
  assert.deepEqual(fx.requests,[{route:'reports/r1/confirmations',body:{version:'QA-2',result:'resolved',note:'',revision:3,requestId:'request-1'}}]);
});
test('ボタン1回の送信に失敗したときは、帯に理由を出し、ボタンを押せる状態に戻す',async()=>{
  const fx=fixture({fail:{status:503,error:'保存処理を完了できませんでした。'}}),box=fx.build(report());
  await named(box,'対応を始める').onclick();
  const error=box.children.find(child=>child.className==='error-text');
  assert.match(error.textContent,/保存処理を完了できませんでした。/);assert.match(error.textContent,/「更新」で保存結果を確認/);
  assert.doesNotMatch(error.textContent,/入力は保持しています/);
  assert.equal(named(box,'対応を始める').disabled,false);
});
test('操作できない利用者には、帯に案内だけを出し、ボタンも入力欄も出さない',()=>{
  const fx=fixture({role:'tester'}),box=fx.build(report({status:'received'}));
  assert.equal(buttons(box).length,0);assert.equal(form(box),undefined);
  assert.ok(box.descendants().some(child=>child.className==='next-action'&&child.textContent.length>0));
});
test('操作する人には、案内の文を出さず、確認対象とボタンだけを、1行にまとめる',()=>{
  const box=fixture().build(report({status:'working',targetVersion:'QA-1'}));
  assert.equal(box.descendants().some(child=>child.tag==='h3'),false);
  const line=box.children[0];assert.equal(line.className,'workflow-line');
  assert.deepEqual(line.children.map(child=>child.className),['meta','workflow-actions']);
});

test('入力欄を開くと最初の入力欄へ、閉じるともとのボタンへ、フォーカスを移す',()=>{
  const fx=fixture(),box=fx.build(report());
  named(box,'入力して進める').onclick();
  assert.equal(Element.active,form(box).elements[0]);assert.equal(Element.active.name,'targetVersion');
  named(box,'閉じる').onclick();
  assert.equal(Element.active,named(box,'対応を始める'));
  const fixed=fx.build(report({status:'fixed'}));
  named(fixed,'公開してテスターへ確認を依頼する…').onclick();
  assert.equal(Element.active.name,'targetVersion');
  named(fixed,'閉じる').onclick();
  assert.equal(Element.active,named(fixed,'公開してテスターへ確認を依頼する…'));
});
test('入力欄を送信して失敗したときは、入力を保持していることを、帯に出す',async()=>{
  const fx=fixture({fail:{status:503,error:'保存処理を完了できませんでした。'}}),box=fx.build(report());
  named(box,'入力して進める').onclick();
  await form(box).onsubmit({preventDefault(){}});
  assert.match(box.children.find(child=>child.className==='error-text').textContent,/入力は保持しています/);
});
test('帯は、詳細をスクロールしても残るが、入力欄を開いている間は固定しない',()=>{
  const css=readFileSync(new URL('../dist/bugs/style.css',import.meta.url),'utf8').replace(/\s+/g,'');
  assert.ok(css.includes('.workflow-panel{position:sticky;top:0;'));
  assert.ok(css.includes('.workflow-panel:has(form:not([hidden])){position:static}'));
});

test('操作する人（共通の利用者・管理者）には、どの状況でも、案内の文を出さない',()=>{
  for(const options of [{shared:true},{role:'admin'}])
    for(const status of ['received','working','fixed','checking','complete']) {
      const box=fixture(options).build(report({status}));
      assert.equal(box.descendants().some(child=>child.className==='next-action'),false,status);
    }
});
test('操作も表示するものもない報告（確認完了）では、帯を出さない',()=>{
  const box=fixture({shared:true}).build(report({status:'complete'}));
  assert.equal(box.hidden,true);assert.equal(buttons(box).length,0);
  assert.equal(fixture({shared:true}).build(report({status:'complete',targetVersion:'QA-2'})).hidden,false);
});
test('確認結果の入力欄に、説明の文を置かない',()=>{
  const box=fixture({shared:true}).build(report({status:'checking'}));
  assert.equal(form(box).descendants().some(child=>child.className==='muted'),false);
});
