import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createFilterPanelStub} from './filter-panel-stub.mjs';
import * as view from '../dist/bugs/view.mjs';

// 報告の詳細の経過（#80）。出来事を1本の流れにし、本文と再現データの下、再現データの追加の上に置く。
const at='2030-01-01T09:00:00.000Z',actorName='共通の利用者',time=value=>'T('+value+')';
const history=[
  {kind:'status',toStatus:'working',at,actorName,note:'送信キューを調べています。'},
  {kind:'status',toStatus:'fixed',at,actorName,note:''},
  {kind:'status',toStatus:'checking',targetVersion:'S-2',at,actorName,note:'S-2で確認をお願いします。'},
  {kind:'confirmation',version:'S-2',result:'unresolved',matchesTarget:true,targetVersion:'S-2',at,actorName,note:''},
  {kind:'confirmation',version:'S-1',result:'resolved',matchesTarget:false,targetVersion:'S-2',at,actorName,note:'別の版で確認しました。'}
];

test('経過の出来事は、見出しと日時・担当を1行にまとめ、連絡と確認の内容だけを、枠に入れる文として分ける',()=>{
  assert.deepEqual(view.threadEvents(history,time),[
    {kind:'status',lead:'対応中',meta:'T('+at+') · '+actorName,note:'送信キューを調べています。'},
    {kind:'status',lead:'修正済み・公開待ち',meta:'T('+at+') · '+actorName,note:''},
    {kind:'status',lead:'テスター確認待ち',meta:'確認対象 S-2 · T('+at+') · '+actorName,note:'S-2で確認をお願いします。'},
    {kind:'confirmation',lead:'確認結果：まだ起きる',meta:'S-2 · T('+at+') · '+actorName,note:''},
    {kind:'confirmation',lead:'確認結果：直った',meta:'S-1 · 確認対象 S-2 と異なる · T('+at+') · '+actorName,note:'別の版で確認しました。'}
  ]);
  assert.deepEqual(view.threadEvents([],time),[]);
});

class Element {
  constructor(tag='div') {this.tag=tag;this.children=[];this.textContent='';this.hidden=false;this.disabled=false;this.checked=false;this.value='';this.className='';this.id='';this.classList={toggle(){},add(){},remove(){},contains:()=>false};this.style={setProperty(){}};}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children=[...children];}
  insertBefore(node,reference) {const index=reference?this.children.indexOf(reference):-1;if(index<0)this.children.push(node);else this.children.splice(index,0,node);}
  get options() {return this.children;}
  *walk() {for(const child of this.children){yield child;yield* child.walk();}}
  querySelector(selector) {
    const match=selector.startsWith('#')?node=>node.id===selector.slice(1):selector.startsWith('.')?node=>node.className.split(' ').includes(selector.slice(1)):()=>false;
    for(const node of this.walk())if(match(node))return node;
    return null;
  }
  querySelectorAll() {return [];}
  addEventListener() {}
}
const detail=(over={})=>({id:'r1',title:'通知メールが届かない',body:'架空の本文',status:'complete',reporterName:actorName,createdAt:at,reportedVersion:'S-1',targetVersion:'S-2',developerNote:'',
  attachments:[],attachmentCount:0,attachmentBytes:0,history,isOwn:true,revision:3,categories:[],kind:'bug',
  github:{state:'registered',repository:'qa/booking-reports',number:101,url:'https://github.com/qa/booking-reports/issues/101',revision:1,tags:{state:'ok',labels:[],fetchedAt:null,error:null,missing:[]}},...over});
function fixture(report) {
  const nodes=new Map();
  const node=selector=>{
    if(!nodes.has(selector)) {
      const found=selector.startsWith('#')&&nodes.has('#detail')?nodes.get('#detail').querySelector(selector):null;
      if(found)return found;
      nodes.set(selector,new Element());
    }
    return nodes.get(selector);
  };
  node('#report-form').elements={files:{files:[]}};
  const fetch=async url=>({ok:true,status:200,json:async()=>url.endsWith('/reports/'+report.id)?{report}:{reports:[report]}});
  const panel=createFilterPanelStub();
  const context=vm.createContext({...view,mountFilterPanel:panel.mountFilterPanel,mountTagRoles:()=>({load:async()=>null,tags:()=>[]}),document:{querySelector:node,createElement:tag=>new Element(tag)},fetch,URL,
    location:{href:'http://127.0.0.1:4327/bugs/'},history:{replaceState(){}},crypto:{randomUUID:()=>'id'},matchMedia:()=>({matches:false}),setTimeout:()=>1,clearTimeout(){}});
  const source=readFileSync(new URL('../dist/bugs/app.mjs',import.meta.url),'utf8');
  const app=source.replace(/^import .*\n/gm,''),end=app.lastIndexOf('\ntry { showActor');
  assert.ok(source.startsWith('import ')&&end>0,'App import and bootstrap boundaries must exist');
  vm.runInContext(app.slice(0,end),context);
  vm.runInContext('actor={id:"local-shared",role:"admin",shared:true,name:"共通の利用者",policy:{maxFiles:20,maxBytes:1000},github:{enabled:true,repository:"qa/booking-reports"}};var refresh=async()=>{};',context);
  Object.assign(context,{__reports:[report]});vm.runInContext('reports=__reports;',context);
  return {node,context,show:async()=>{await vm.runInContext('openReport',context)(report.id,false);}};
}
const classes=node=>node.className.split(' ');

test('経過は、見出しなしの1本の流れにし、出来事は1行、連絡と確認の内容がある出来事だけ枠を付ける',async()=>{
  const fx=fixture(detail());await fx.show();
  const thread=fx.node('#detail').querySelector('.thread');
  assert.ok(thread&&!thread.hidden);
  assert.equal(thread.children.some(child=>child.tag==='h3'),false,'流れの見出し（これまでの経過）は置かない');
  const events=thread.children[0].children;
  assert.deepEqual(events.map(item=>item.children.length),[2,1,2,1,2],'メモのある出来事だけ、枠を持つ');
  assert.deepEqual(events.map(item=>classes(item).includes('is-confirmation')),[false,false,false,true,true]);
  assert.equal(events[0].children[0].children[0].textContent,'対応中');
  assert.equal(events[0].children[1].textContent,'送信キューを調べています。');
  assert.ok(classes(events[0].children[1]).includes('thread-note'));
});
test('経過は、本文と再現データの下、再現データの追加の上に置く。経過がなければ流れごと隠す',async()=>{
  const fx=fixture(detail());await fx.show();
  const parts=fx.node('#detail').children,at=name=>parts.findIndex(part=>classes(part).includes(name));
  assert.ok(at('report-body')<at('file-list')&&at('file-list')<at('thread'),'本文、再現データ、経過の順');
  assert.ok(at('thread')<parts.findIndex(part=>part.tag==='form'),'再現データの追加は、経過のあと');
  const empty=fixture(detail({history:[]}));await empty.show();
  assert.equal(empty.node('#detail').querySelector('.thread').hidden,true);
});
