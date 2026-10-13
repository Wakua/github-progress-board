import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as view from '../dist/bugs/view.mjs';

// 報告の種別（#73）の画面。実際の画面のコードを、擬似DOMと偽のAPIで動かす。
class Element {
  constructor(tag='div') {
    this.tag=tag;this.children=[];this.textContent='';this.hidden=false;this.disabled=false;this.checked=false;this.value='';this.className='';this.id='';
    this.classList={toggle(){},add(){},remove(){},contains:()=>false};this.style={setProperty(){}};
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
  querySelectorAll(selector) {return [...this.walk()].filter(node=>node.tag==='input'&&(!selector.includes(':checked')||node.checked));}
  addEventListener() {}
  showModal() {this.open=true;}
  close() {this.open=false;}
}
const tags=[{id:11,name:'予約',color:'336699',role:'main'},{id:12,name:'一覧',color:'993366',role:'sub'},{id:13,name:'通知',color:'339966',role:'main'}];
const label=id=>tags.find(tag=>tag.id===id);
const report=(id,{kind,status='received',state='registered',labels=[],revision=3,body='架空の本文'}={})=>({
  id,title:'報告 '+id,body,status,reporterName:'共通の利用者',createdAt:'2030-01-01T00:00:00.000Z',reportedVersion:'',targetVersion:'',developerNote:'',
  attachments:[],attachmentCount:0,attachmentBytes:0,history:[],isOwn:true,revision,categories:[],...(kind===undefined?{}:{kind}),
  github:{state,repository:'qa/booking-reports',number:state==='registered'?101:null,url:null,error:null,retryAt:0,revision:1,tags:{state:'ok',labels,fetchedAt:null,error:null,missing:[]}}
});
// 予約の報告：不具合2件（未対応）、要望2件（未対応1件）、確認1件（未対応）。
const sample=()=>[
  report('b1',{labels:[label(11),label(12)]}),report('b2',{kind:'bug',labels:[label(11)]}),
  report('r1',{kind:'request',labels:[label(11),label(12)]}),report('r2',{kind:'request',status:'complete',labels:[label(11)]}),
  report('q1',{kind:'question',labels:[label(13)]})
];

function fixture({reports=sample(),details=new Map(),kindFailure=null,search}={}) {
  const nodes=new Map(),requests=[];
  const node=selector=>{
    if(!nodes.has(selector)) {
      const found=selector.startsWith('#')&&nodes.has('#detail')?nodes.get('#detail').querySelector(selector):null;
      if(found)return found;
      nodes.set(selector,new Element());
    }
    return nodes.get(selector);
  };
  for(const selector of ['#main-filter','#sub-filter','#registration-filter','#status-filter','#kind-filter'])node(selector).value='all';
  const form=node('#report-form'),files=new Element('input'),body=new Element('textarea'),version=new Element('input'),kind={value:'bug'};
  files.files=[];body.value='架空の再現報告';
  form.elements=Object.assign([files,body,version,node('#submit-report')],{files,body,reportedVersion:version,kind});
  form.reset=()=>{files.files=[];body.value=version.value='';kind.value='bug';};
  const respond=(route,options)=>{
    requests.push({route,body:options.body&&typeof options.body==='string'?JSON.parse(options.body):undefined});
    if(route==='uploads')return{status:200,value:{attachments:[]}};
    if(route==='reports/search')return{status:200,value:{ids:(search?search(JSON.parse(options.body).query):reports.map(item=>item.id))}};
    if(route==='reports'&&options.method==='POST')return{status:201,value:{report:{id:'accepted'}}};
    if(route==='reports')return{status:200,value:{reports}};
    const changed=/^reports\/([a-z0-9]+)\/kind$/.exec(route);
    if(changed)return kindFailure?{status:409,value:{error:kindFailure}}:{status:200,value:{report:details.get(changed[1])}};
    const detail=/^reports\/([a-z0-9]+)$/.exec(route);
    if(detail&&details.has(detail[1]))return{status:200,value:{report:details.get(detail[1])}};
    throw new Error('Unexpected request: '+route);
  };
  const fetch=async(url,options={})=>{const result=respond(url.replace('/api/bugs/',''),options);return{ok:result.status<400,status:result.status,json:async()=>result.value};};
  const timers=[];
  const context=vm.createContext({...view,mountTagRoles:()=>({load:async()=>null,tags:()=>tags}),document:{querySelector:node,createElement:tag=>new Element(tag)},fetch,URL,
    location:{href:'http://127.0.0.1:4327/bugs/'},history:{replaceState(){}},crypto:{randomUUID:()=>'id'},matchMedia:()=>({matches:false}),
    setTimeout:(fn,ms)=>{timers.push({fn,ms,live:true});return timers.length;},clearTimeout:id=>{if(timers[id-1])timers[id-1].live=false;}});
  const source=readFileSync(new URL('../dist/bugs/app.mjs',import.meta.url),'utf8');
  const app=source.replace(/^import .*\n/gm,''),end=app.lastIndexOf('\ntry { showActor');
  assert.ok(source.startsWith('import ')&&end>0,'App import and bootstrap boundaries must exist');
  vm.runInContext(app.slice(0,end),context);
  vm.runInContext('actor={id:"local-shared",role:"admin",shared:true,policy:{maxFiles:20,maxBytes:1000},github:{enabled:true,repository:"qa/booking-reports"}};var lastNotice="";var lastError=false;notice=(message,error)=>{lastNotice=message;lastError=Boolean(error)};var refreshed=0;refresh=async()=>{refreshed++};',context);
  Object.assign(context,{__reports:reports});vm.runInContext('reports=__reports;',context);
  const box=()=>node('#reports');
  return{
    node,requests,context,form,
    titles:()=>box().children.map(row=>row.children[0].children[0].children.find(part=>part.className==='report-title').textContent),
    marks:()=>box().children.map(row=>row.children[1].children.map(item=>item.textContent)),
    count:()=>node('#report-count').textContent,
    choices:selector=>node(selector).options.map(option=>option.textContent),
    choose(selector,value) {node(selector).value=value;node(selector).onchange();},
    render:()=>{vm.runInContext('renderFilters();renderList();',context);},
    open:()=>node('#new-report').onclick(),
    submit:()=>form.onsubmit({preventDefault(){},currentTarget:form}),
    sent:()=>requests.filter(request=>request.route==='reports'&&request.body).map(request=>request.body),
    show:async id=>{await vm.runInContext('openReport',context)(id,false);},
    kindBox:()=>node('#detail').querySelector('.kind-edit'),
    notice:()=>({text:vm.runInContext('lastNotice',context),error:vm.runInContext('lastError',context)}),
    refreshed:()=>vm.runInContext('refreshed',context),
    type(value) {node('#search').value=value;node('#search').oninput({isComposing:false});},
    async flush() {for(const timer of [...timers]){if(timer.live){timer.live=false;await timer.fn();}}}
  };
}

test('一覧の行は、要望と確認にだけ種別の印を出す。不具合と、種別を持たない更新前の報告には出さない',()=>{
  const fx=fixture();fx.render();
  assert.deepEqual(fx.titles(),['報告 b1','報告 b2','報告 r1','報告 r2','報告 q1']);
  assert.deepEqual(fx.marks(),[['受付済み'],['受付済み'],['受付済み','要望'],['確認完了','要望'],['受付済み','確認']]);
  assert.equal(view.kindOf(report('x')),'bug');assert.equal(view.kindOf(report('x',{kind:'question'})),'question');
  assert.deepEqual(view.kindNames,{bug:'不具合',request:'要望',question:'確認'});
});
test('種別を選ぶと、その種別の報告だけを出す。「すべて」と、値がないときは、絞り込まない',()=>{
  const fx=fixture();fx.render();
  fx.choose('#kind-filter','request');
  assert.deepEqual(fx.titles(),['報告 r1','報告 r2']);assert.equal(fx.count(),'2 / 5件');
  fx.choose('#kind-filter','question');
  assert.deepEqual(fx.titles(),['報告 q1']);
  fx.choose('#kind-filter','bug');
  assert.deepEqual(fx.titles(),['報告 b1','報告 b2']);
  fx.choose('#kind-filter','all');
  assert.equal(fx.titles().length,5);
  fx.node('#kind-filter').value='';fx.render();
  assert.equal(fx.titles().length,5,'種別の欄を持たない画面でも、全件を出す');
});
test('種別の絞り込みは、メイン・サブ・対応状況・本文の検索と重ねて使える',async()=>{
  const fx=fixture({search:query=>sample().filter(item=>query==='予約'?['b1','r1','r2'].includes(item.id):true).map(item=>item.id)});fx.render();
  fx.choose('#kind-filter','request');
  fx.choose('#main-filter','label:11');
  assert.deepEqual(fx.titles(),['報告 r1','報告 r2']);
  fx.choose('#sub-filter','label:12');
  assert.deepEqual(fx.titles(),['報告 r1']);
  fx.choose('#sub-filter','all');fx.choose('#status-filter','complete');
  assert.deepEqual(fx.titles(),['報告 r2']);
  fx.choose('#status-filter','all');
  fx.type('予約');await fx.flush();
  assert.deepEqual(fx.titles(),['報告 r1','報告 r2']);
  fx.choose('#kind-filter','all');
  assert.deepEqual(fx.titles(),['報告 b1','報告 r1','報告 r2']);
});
test('メインとサブの件数は、種別を選んだときだけ、その種別で数える',()=>{
  const fx=fixture();fx.render();
  const sorted=values=>[...values].sort();
  assert.deepEqual(sorted(fx.choices('#main-filter')),sorted(['すべて','予約（3）','通知（1）','未分類（0）']),'種別を選ばないときは、すべての種別を数える');
  assert.deepEqual(fx.choices('#sub-filter'),['すべて','一覧（2）']);
  fx.choose('#kind-filter','bug');
  assert.deepEqual(sorted(fx.choices('#main-filter')),sorted(['すべて','予約（2）','通知（0）','未分類（0）']));
  assert.deepEqual(fx.choices('#sub-filter'),['すべて','一覧（1）']);
  fx.choose('#kind-filter','request');
  assert.deepEqual(sorted(fx.choices('#main-filter')),sorted(['すべて','予約（1）','通知（0）','未分類（0）']),'完了した要望は、未対応に数えない');
  fx.choose('#kind-filter','question');
  assert.deepEqual(sorted(fx.choices('#main-filter')),sorted(['すべて','予約（0）','通知（1）','未分類（0）']));
  assert.deepEqual(fx.choices('#sub-filter'),['すべて'],'その種別の報告にないサブは出さない');
});
test('種別を変えて、選んでいたサブがなくなったときは、サブを「すべて」に戻す',()=>{
  const fx=fixture();fx.render();
  fx.choose('#sub-filter','label:12');
  assert.equal(fx.titles().length,2);
  fx.choose('#kind-filter','question');
  assert.equal(fx.node('#sub-filter').value,'all');assert.deepEqual(fx.titles(),['報告 q1']);
});
test('数の説明（選択肢の上に出る文）に、種別を選んだときのことを添える',()=>{
  const html=readFileSync(new URL('../dist/bugs/index.html',import.meta.url),'utf8');
  for(const id of ['main-filter','sub-filter'])assert.match(html,new RegExp('id="'+id+'" title="[^"]*種別を選ぶと'));
  assert.match(html,/id="kind-filter"><option value="all">すべて<\/option><option value="bug">不具合<\/option><option value="request">要望<\/option><option value="question">確認<\/option>/);
});

test('報告フォームは、種別を送る。選ばなければ不具合で、送信に成功すると不具合に戻る',async()=>{
  const fx=fixture();fx.run=code=>vm.runInContext(code,fx.context);
  fx.run('refresh=async()=>{};openReport=async()=>{};');
  await fx.open();await fx.submit();
  fx.form.elements.kind.value='question';
  await fx.submit();
  assert.deepEqual(fx.sent().map(body=>body.kind),['bug','question']);
  assert.equal(fx.form.elements.kind.value,'bug');
  const html=readFileSync(new URL('../dist/bugs/index.html',import.meta.url),'utf8');
  assert.match(html,/<legend>種別<\/legend>[\s\S]*name="kind" value="bug" checked[\s\S]*name="kind" value="request"[\s\S]*name="kind" value="question"/);
});

test('詳細は、種別を選ぶ欄を出し、登録の状態によらず、変えられる',async()=>{
  const states=['pending','creating','unknown','failed','registered'];
  const items=new Map(states.map(state=>[state,report(state,{state,kind:'request'})]));
  const fx=fixture({reports:[...items.values()],details:items});
  for(const state of states) {
    await fx.show(state);
    const select=fx.kindBox().children[1];
    assert.equal(fx.kindBox().children[0].textContent,'種別');
    assert.deepEqual(select.options.map(option=>[option.value,option.textContent]),[['bug','不具合'],['request','要望'],['question','確認']]);
    assert.equal(select.value,'request',state);
  }
});
test('種別を変えると、更新番号とともに送り、報告を読み直して通知する',async()=>{
  const item=report('p1',{kind:'bug',revision:7}),fx=fixture({reports:[item],details:new Map([['p1',item]])});
  await fx.show('p1');
  const select=fx.kindBox().children[1];
  assert.equal(select.value,'bug');
  select.value='question';await select.onchange();
  const sent=fx.requests.find(request=>request.route==='reports/p1/kind');
  assert.deepEqual(sent.body,{kind:'question',revision:7});
  assert.equal(fx.refreshed(),1);assert.deepEqual(fx.notice(),{text:'種別を変えました。',error:false});
});
test('種別を持たない更新前の報告の詳細は、不具合と表示する',async()=>{
  const item=report('p1',{revision:2}),fx=fixture({reports:[item],details:new Map([['p1',item]])});
  await fx.show('p1');
  assert.equal(fx.kindBox().children[1].value,'bug');
});
test('種別を変えられなかったときは、理由を通知し、選びを元に戻して、もう一度選べるようにする',async()=>{
  const item=report('p1',{kind:'request',revision:2}),fx=fixture({reports:[item],details:new Map([['p1',item]]),kindFailure:'報告が更新されています。「更新」で最新の状況を確認してください。'});
  await fx.show('p1');
  const select=fx.kindBox().children[1];
  select.value='question';await select.onchange();
  assert.deepEqual(fx.notice(),{text:'報告が更新されています。「更新」で最新の状況を確認してください。',error:true});
  assert.equal(select.value,'request');assert.equal(select.disabled,false);assert.equal(fx.refreshed(),0);
});
