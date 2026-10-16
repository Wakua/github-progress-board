import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as view from '../dist/bugs/view.mjs';

// 報告のかんばん（#77）。実際の画面のコードを、擬似DOMと偽のAPIで動かす。
const tags=[{id:11,name:'予約',color:'336699',role:'main'},{id:12,name:'一覧',color:'993366',role:'sub'}];
const report=(id,status,{number=null,labels=[]}={})=>({
  id,title:'報告 '+id,body:'架空の本文',status,reporterName:'共通の利用者',createdAt:'2030-01-01T00:00:00.000Z',reportedVersion:'',targetVersion:'',developerNote:'',
  attachments:[],attachmentCount:0,attachmentBytes:0,history:[],isOwn:true,revision:3,categories:[],kind:'bug',
  github:{state:'registered',repository:'qa/booking-reports',number,url:null,error:null,retryAt:0,revision:1,tags:{state:'ok',labels,fetchedAt:null,error:null,missing:[]}}
});
const sample=()=>[
  report('a','received',{number:101,labels:[tags[0],tags[1]]}),report('b','received',{number:102}),report('c','working',{number:103,labels:[tags[0]]}),
  report('d','fixed',{number:104}),report('e','complete',{number:105}),report('f','complete',{number:106})
];

test('かんばんの列は、対応状況の流れの順に並べ、報告がない列も残す',()=>{
  const columns=view.boardColumns(sample());
  assert.deepEqual(columns.map(column=>column.name),['受付済み','対応中','修正済み・公開待ち','テスター確認待ち','確認完了']);
  assert.deepEqual(columns.map(column=>column.reports.map(item=>item.id)),[['a','b'],['c'],['d'],[],['e','f']]);
  assert.deepEqual(view.boardColumns([]).map(column=>column.reports.length),[0,0,0,0,0]);
});

class Element {
  constructor(tag='div') {
    this.tag=tag;this.children=[];this.textContent='';this.hidden=false;this.disabled=false;this.checked=false;this.value='';this.className='';this.id='';this.handlers=[];this.classes=new Set();
    this.classList={toggle:(name,on)=>{if(on===undefined?!this.classes.has(name):on)this.classes.add(name);else this.classes.delete(name);},add:name=>this.classes.add(name),remove:name=>this.classes.delete(name),contains:name=>this.classes.has(name)};
    this.style={setProperty(){}};
  }
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
  addEventListener(type,handler) {if(type==='click')this.handlers.push(handler);}
  click() {for(const handler of this.handlers)handler();return this.onclick?.();}
}
function fixture(reports=sample()) {
  const nodes=new Map(),stored=new Map();
  const node=selector=>{
    if(!nodes.has(selector)) {
      const found=selector.startsWith('#')&&nodes.has('#detail')?nodes.get('#detail').querySelector(selector):null;
      if(found)return found;
      nodes.set(selector,new Element());
    }
    return nodes.get(selector);
  };
  for(const selector of ['#main-filter','#sub-filter','#registration-filter','#status-filter','#kind-filter'])node(selector).value='all';
  node('#report-form').elements={files:{files:[]}};
  const fetch=async url=>{
    const route=url.replace('/api/bugs/',''),found=reports.find(item=>route==='reports/'+item.id);
    return {ok:true,status:200,json:async()=>found?{report:found}:{reports}};
  };
  const localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)};
  const context=vm.createContext({...view,mountFilterBar:()=>({}),mountTagRoles:()=>({load:async()=>null,tags:()=>tags}),document:{querySelector:node,createElement:tag=>new Element(tag)},fetch,URL,localStorage,
    location:{href:'http://127.0.0.1:4327/bugs/'},history:{replaceState(){}},crypto:{randomUUID:()=>'id'},matchMedia:()=>({matches:false}),setTimeout:()=>1,clearTimeout(){}});
  const source=readFileSync(new URL('../dist/bugs/app.mjs',import.meta.url),'utf8');
  const app=source.replace(/^import .*\n/gm,''),end=app.lastIndexOf('\ntry { showActor');
  assert.ok(source.startsWith('import ')&&end>0,'App import and bootstrap boundaries must exist');
  vm.runInContext(app.slice(0,end),context);
  vm.runInContext('actor={id:"local-shared",role:"admin",shared:true,name:"共通の利用者",policy:{maxFiles:20,maxBytes:1000},github:{enabled:true,repository:"qa/booking-reports"}};var refresh=async()=>{};',context);
  Object.assign(context,{__reports:reports});vm.runInContext('reports=__reports;',context);
  const board=()=>node('#reports').children[0];
  return {node,context,stored,board,
    setView:mode=>{context.__mode=mode;vm.runInContext('setView(__mode)',context);},
    render:()=>vm.runInContext('renderList()',context),
    columns:()=>board().children.map(section=>({title:section.children[0].children[0].textContent,count:section.children[0].children[1].textContent,cards:section.children.slice(1)})),
    texts:card=>[...card.walk()].map(part=>part.textContent).filter(Boolean)};
}
const classes=node=>node.className.split(' ');

test('かんばんは、対応状況の列に、番号・題名・領域だけの札を並べる。確認完了の列は、畳んで件数だけを出す',()=>{
  const fx=fixture();fx.setView('board');
  assert.deepEqual(classes(fx.board()),['board']);
  const columns=fx.columns();
  assert.deepEqual(columns.map(column=>[column.title,column.count,column.cards.length]),[['受付済み','2',2],['対応中','1',1],['修正済み・公開待ち','1',1],['テスター確認待ち','0',0],['確認完了','2',0]]);
  assert.deepEqual(fx.texts(columns[0].cards[0]),['#101','報告 a','予約 / 一覧']);
  assert.deepEqual(fx.texts(columns[0].cards[1]),['#102','報告 b'],'領域がない札は、領域の行を持たない');
});
test('確認完了の列は、見出しを押すと開き、もう一度押すと畳む',()=>{
  const fx=fixture();fx.setView('board');
  const title=()=>fx.board().children[4].children[0];
  assert.equal(title().tag,'button');assert.equal(title().ariaExpanded,'false');
  title().click();
  assert.equal(fx.columns()[4].cards.length,2);assert.equal(title().ariaExpanded,'true');
  title().click();
  assert.equal(fx.columns()[4].cards.length,0);assert.equal(title().ariaExpanded,'false');
  assert.equal(fx.board().children[0].children[0].tag,'h3','畳める列は、確認完了だけ');
});
test('絞り込みと検索は、かんばんにも効く。件数は、絞り込んだ報告で数える',()=>{
  const fx=fixture();fx.setView('board');
  fx.node('#status-filter').value='working';fx.render();
  assert.deepEqual(fx.columns().map(column=>column.count),['0','1','0','0','0']);
  fx.node('#status-filter').value='all';fx.node('#main-filter').value='label:11';fx.render();
  assert.deepEqual(fx.columns().map(column=>column.count),['1','1','0','0','0']);
  assert.equal(fx.node('#report-count').textContent,'2 / 6件');
});
test('札を押すと、その報告の詳細を、かんばんの代わりに開く',async()=>{
  const fx=fixture();fx.setView('board');
  fx.columns()[1].cards[0].click();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(fx.node('#detail').classes.has('mobile-open'));
  assert.equal(fx.node('#detail').children.some(part=>classes(part).includes('back')),true,'一覧へ戻る操作を持つ');
});
test('表示の切り替えは、一覧とかんばんの印を持ち、選んだ表示をこのブラウザに覚える。かんばんへ切り替えるとき、開いた詳細は閉じる',()=>{
  const fx=fixture();
  assert.equal(fx.node('#view-list').ariaPressed,'true');
  fx.node('#detail').classList.add('mobile-open');
  fx.setView('board');
  assert.equal(fx.node('.layout').classes.has('board-mode'),true);
  assert.equal(fx.node('#view-board').ariaPressed,'true');assert.equal(fx.node('#view-list').ariaPressed,'false');
  assert.equal(fx.node('#detail').classes.has('mobile-open'),false);
  assert.equal(fx.stored.get('bug-report-view'),'board');
  fx.setView('list');
  assert.equal(fx.node('.layout').classes.has('board-mode'),false);
  assert.equal(fx.node('#reports').children.length,6);assert.ok(classes(fx.node('#reports').children[0]).includes('report-row'));
  assert.equal(fx.stored.get('bug-report-view'),'list');
});
test('覚えた表示が読めないとき、覚えられないときは、一覧にする',()=>{
  const read=value=>{const fx=fixture();fx.stored.set('bug-report-view',value);return vm.runInContext("(()=>{try{return localStorage.getItem(viewKey)==='board'?'board':'list';}catch{return 'list';}})()",fx.context);};
  assert.equal(read('board'),'board');
  for(const value of ['list','','{','board ','x'])assert.equal(read(value),'list',value);
});
