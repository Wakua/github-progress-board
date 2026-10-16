import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as view from '../dist/bugs/view.mjs';

// 画面に、状態の印やボタンで分かる説明の文を、足し戻していないことを、実際の画面のコードで確かめる。
class Element {
  constructor(tag='div') {this.tag=tag;this.children=[];this.textContent='';this.hidden=false;this.disabled=false;this.value='';this.className='';this.name='';this.style={setProperty(){}};this.classList={toggle(){}};}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children=[...children];}
  get options() {return this.children;}
  addEventListener() {}
  descendants() {return this.children.flatMap(child=>[child,...child.descendants()]);}
}
function fixture({githubEnabled=true,role='admin',shared=true}={}) {
  const nodes=new Map();
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);};
  Object.defineProperty(node('#report-form'),'elements',{value:{files:{}}});
  const context=vm.createContext({...view,mountTagRoles:()=>({load:async()=>null,tags:()=>[]}),document:{querySelector:node,createElement:tag=>new Element(tag)},fetch:async()=>({ok:true,status:200,json:async()=>({})}),URL,location:{href:'http://127.0.0.1:4327/bugs/'},crypto:{randomUUID:()=>'id'},setTimeout:()=>0,clearTimeout(){}});
  const source=readFileSync(new URL('../dist/bugs/app.mjs',import.meta.url),'utf8');
  const app=source.replace(/^import .*\n/gm,''),end=app.lastIndexOf('\ntry { showActor');
  assert.ok(source.startsWith('import ')&&end>0,'App import and bootstrap boundaries must exist');
  vm.runInContext(app.slice(0,end),context);
  vm.runInContext('actor={id:"local-shared",role:"'+role+'",shared:'+shared+',policy:{maxBytes:1073741824,maxFiles:20},name:"共通の利用者",github:{enabled:'+githubEnabled+',repository:"qa/booking-reports"}};',context);
  return {node,call:(name,value)=>{context.__value=value;return vm.runInContext(name+'(__value)',context);},show:value=>{context.__value=value;vm.runInContext('showActor(__value)',context);}};
}
const github=(overrides={})=>({state:'registered',repository:'qa/booking-reports',number:101,url:'https://github.com/qa/booking-reports/issues/101',revision:1,tags:{state:'ok',labels:[{id:1,name:'予約',color:'3a6ea5'}],fetchedAt:'2030-01-01T00:00:00.000Z'},...overrides});
const report=overrides=>({id:'r1',title:'予約一覧が更新されない',github:github(overrides)});
const explanations=box=>box.descendants().filter(child=>child.tag==='p'&&child.className==='muted').map(child=>child.textContent);
const buttonNames=box=>box.descendants().filter(child=>child.tag==='button').map(child=>child.textContent);

test('GitHubの枠は、状態の印とボタンで分かることを、説明の文で繰り返さない',()=>{
  const fx=fixture();
  const cases=[
    ['未登録',report({state:'pending',repository:null,number:null,tags:{state:'unfetched',labels:[]}})],
    ['登録待ち',report({state:'pending',number:null,tags:{state:'unfetched',labels:[]}})],
    ['登録中',report({state:'creating',number:null,tags:{state:'unfetched',labels:[]}})],
    ['登録済み',report()],
  ];
  for(const [name,value] of cases)assert.deepEqual(explanations(fx.call('renderGitHub',value)),[],name);
  assert.ok(buttonNames(fx.call('renderGitHub',cases[0][1])).includes('GitHubに登録'));
});
test('GitHubの接続がないときは、説明の文を出さない',()=>{
  const box=fixture({githubEnabled:false}).call('renderGitHub',report({state:'pending',repository:null,number:null,tags:{state:'unfetched',labels:[]}}));
  assert.deepEqual(explanations(box),[]);
});
test('結果未確認の報告には、重複を防ぐための警告を、短く残す',()=>{
  const box=fixture().call('renderGitHub',report({state:'unknown',number:null,candidates:[],tags:{state:'unfetched',labels:[]}}));
  assert.deepEqual(explanations(box),['作成された可能性があります。照合してください。']);
  assert.ok(buttonNames(box).includes('既存のIssueと照合'));
});
test('履歴がないときは、説明の文を出さず、履歴の枠ごと隠す',()=>{
  const fx=fixture();
  const empty=fx.call('renderHistory',{history:[]});
  assert.equal(empty.hidden,true);assert.deepEqual(explanations(empty),[]);
  assert.equal(fx.call('renderHistory',{history:[{kind:'status',toStatus:'working',at:'2030-01-01T00:00:00.000Z',actorName:'共通の利用者',note:''}]}).hidden,false);
});
test('容量の表示は、上限だけにし、画面の上の小さな見出しは置かない',()=>{
  const fx=fixture();fx.show({id:'local-shared',name:'共通の利用者',role:'admin',shared:true,policy:{maxBytes:1073741824,maxFiles:20},github:{enabled:false}});
  assert.equal(fx.node('#policy').textContent,'1報告 1.00 GiB・20ファイルまで');
  assert.equal(readFileSync(new URL('../dist/bugs/index.html',import.meta.url),'utf8').includes('id="scope"'),false);
});
