import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as view from '../dist/bugs/view.mjs';
import {createFilterPanelStub} from './filter-panel-stub.mjs';

// 要望の判定（#82）の画面。実際の画面のコードを、擬似DOMと偽のAPIで動かす。
const at='2030-01-01T09:00:00.000Z';
const report=(id,{kind='request',decision,status='received'}={})=>({
  id,title:'報告 '+id,body:'架空の本文',status,reporterName:'共通の利用者',createdAt:at,reportedVersion:'',targetVersion:'',developerNote:'',
  attachments:[],attachmentCount:0,attachmentBytes:0,history:[],isOwn:true,revision:3,categories:[],kind,...(decision?{decision}:{}),
  github:{state:'registered',repository:'qa/booking-reports',number:null,url:null,error:null,retryAt:0,revision:1,tags:{state:'ok',labels:[],fetchedAt:null,error:null,missing:[]}}
});
const decided=(value,note='',when=at)=>({value,note,at:value==='undecided'?null:when});

test('判定は、要望だけが持つ。値を持たない要望は、未判定として扱う。要望以外は、判定の絞り込みに入らない',()=>{
  assert.deepEqual(view.decisionNames,{undecided:'未判定',accept:'対応する',defer:'保留'});
  assert.equal(view.decisionOf(report('a',{decision:decided('defer')})),'defer');
  assert.equal(view.decisionOf(report('b')),'undecided','更新前の要望');
  assert.equal(view.decisionOf(report('c',{kind:'bug',decision:decided('accept')})),null);
  const reports=[report('a',{decision:decided('accept')}),report('b',{decision:decided('defer')}),report('c'),report('d',{kind:'bug'}),report('e',{kind:'question'})];
  const ids=decision=>reports.filter(item=>view.matchesFilters(item,{decision})).map(item=>item.id);
  assert.deepEqual(ids([]),['a','b','c','d','e'],'何も選んでいないときは、絞り込まない');
  assert.deepEqual(ids('all'),['a','b','c','d','e']);
  assert.deepEqual(ids(['accept']),['a']);assert.deepEqual(ids('defer'),['b']);
  assert.deepEqual(ids(['accept','defer']),['a','b'],'複数の値は、どれかに当てはまる報告を出す');
  assert.deepEqual(ids(['undecided']),['c'],'要望でない報告は、未判定に数えない');
  assert.equal(view.matchesFilters(reports[1],{decision:['defer'],kind:['request'],status:['received']}),true,'ほかの条件と重ねて使える');
  assert.equal(view.matchesFilters(reports[1],{decision:['defer'],status:['complete']}),false);
});

class Element {
  constructor(tag='div') {this.tag=tag;this.children=[];this.textContent='';this.hidden=false;this.disabled=false;this.value='';this.className='';this.id='';this.classList={toggle(){},add(){},remove(){},contains:()=>false};this.style={setProperty(){}};}
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
function fixture(reports,{failure=null}={}) {
  const nodes=new Map(),requests=[];
  const node=selector=>{
    if(!nodes.has(selector)) {
      const found=selector.startsWith('#')&&nodes.has('#detail')?nodes.get('#detail').querySelector(selector):null;
      if(found)return found;
      nodes.set(selector,new Element());
    }
    return nodes.get(selector);
  };
  const panel=createFilterPanelStub();
  node('#report-form').elements={files:{files:[]}};
  const fetch=async(url,options={})=>{
    const route=url.replace('/api/bugs/','');
    requests.push({route,body:options.body?JSON.parse(options.body):undefined});
    if(route.endsWith('/decision'))return failure?{ok:false,status:409,json:async()=>({error:failure})}:{ok:true,status:200,json:async()=>({report:reports[0]})};
    const found=reports.find(item=>route==='reports/'+item.id);
    return {ok:true,status:200,json:async()=>found?{report:found}:{reports}};
  };
  const context=vm.createContext({...view,mountFilterPanel:panel.mountFilterPanel,mountTagRoles:()=>({load:async()=>null,tags:()=>[]}),document:{querySelector:node,createElement:tag=>new Element(tag)},fetch,URL,
    location:{href:'http://127.0.0.1:4327/bugs/'},history:{replaceState(){}},crypto:{randomUUID:()=>'id'},matchMedia:()=>({matches:false}),setTimeout:()=>1,clearTimeout(){}});
  const source=readFileSync(new URL('../dist/bugs/app.mjs',import.meta.url),'utf8');
  const app=source.replace(/^import .*\n/gm,''),end=app.lastIndexOf('\ntry { showActor');
  assert.ok(source.startsWith('import ')&&end>0,'App import and bootstrap boundaries must exist');
  vm.runInContext(app.slice(0,end),context);
  vm.runInContext('actor={id:"local-shared",role:"admin",shared:true,name:"共通の利用者",policy:{maxFiles:20,maxBytes:1000},github:{enabled:true,repository:"qa/booking-reports"}};var refreshed=0;refresh=async()=>{refreshed++};var lastNotice="";notice=(message)=>{lastNotice=message};',context);
  Object.assign(context,{__reports:reports});vm.runInContext('reports=__reports;',context);
  return {node,requests,context,choose:panel.choose,
    show:async id=>{await vm.runInContext('openReport',context)(id,false);},
    render:()=>vm.runInContext('renderList()',context),
    form:()=>node('#detail').querySelector('.decision-edit'),
    marks:()=>node('#reports').children.map(row=>row.children[1].children.map(item=>item.textContent))};
}
const parts=form=>({select:[...form.walk()].find(part=>part.tag==='select'),note:form.children.find(part=>part.tag==='input'),save:form.children.find(part=>part.tag==='button')});
const classes=node=>node.className.split(' ');

test('要望の詳細には、判定の欄を出し、不具合と確認には出さない。判定の選択は、「判定」の名前を持つ',async()=>{
  const fx=fixture([report('r1'),report('b1',{kind:'bug'}),report('q1',{kind:'question'})]);
  await fx.show('r1');assert.ok(fx.form());
  const named=fx.form().children.find(part=>part.tag==='label');
  assert.ok(named&&named.children[0].textContent==='判定'&&named.children[1].tag==='select','選択を、「判定」のlabelに入れる');
  const {select,note,save}=parts(fx.form());
  assert.deepEqual(select.options.map(option=>[option.value,option.textContent]),[['undecided','未判定'],['accept','対応する'],['defer','保留']]);
  assert.equal(select.value,'undecided');assert.equal(note.hidden,true,'未判定のあいだは、理由を出さない');assert.equal(save.hidden,true,'変えていないあいだは、保存を出さない');
  for(const id of ['b1','q1']){await fx.show(id);assert.equal(fx.form(),null,id);}
});
test('判定を選ぶと、理由と保存を出し、保存すると、判定と理由と更新番号を送る',async()=>{
  const fx=fixture([report('r1')]);await fx.show('r1');
  const {select,note,save}=parts(fx.form());
  select.value='defer';select.onchange();
  assert.equal(note.hidden,false);assert.equal(save.hidden,false);assert.equal(note.placeholder,'理由','理由の欄にも、名前を付ける');
  note.value='次の版で見直す。';note.oninput();
  await fx.form().onsubmit({preventDefault(){}});
  assert.deepEqual(fx.requests.at(-1),{route:'reports/r1/decision',body:{decision:'defer',note:'次の版で見直す。',revision:3}});
  assert.equal(vm.runInContext('refreshed',fx.context),1,'保存のあと、報告を読み直す');
});
test('保存済みの判定は、判定と理由と日付を出し、変えるまで保存を出さない。未判定へ戻すときは、理由を出さずに保存できる',async()=>{
  const fx=fixture([report('r1',{decision:decided('accept','今回の版で入れる。')})]);await fx.show('r1');
  const form=fx.form(),{select,note,save}=parts(form);
  assert.equal(select.value,'accept');assert.equal(note.value,'今回の版で入れる。');assert.equal(note.hidden,false);assert.equal(save.hidden,true);
  assert.equal(form.children.at(-1).textContent,new Date(at).toLocaleDateString('ja-JP'),'判定した日付を出す');
  note.value='今回の版で入れる。（変更）';note.oninput();assert.equal(save.hidden,false);
  note.value='今回の版で入れる。';note.oninput();assert.equal(save.hidden,true,'元に戻すと、保存を隠す');
  select.value='undecided';select.onchange();
  assert.equal(note.hidden,true);assert.equal(save.hidden,false);
});
test('保存に失敗したときは、理由を示し、入力欄を操作できる状態に戻す',async()=>{
  const fx=fixture([report('r1')],{failure:'報告が更新されています。「更新」で最新の状況を確認してください。'});await fx.show('r1');
  const {select,note,save}=parts(fx.form());
  select.value='accept';select.onchange();
  await fx.form().onsubmit({preventDefault(){}});
  assert.equal(vm.runInContext('lastNotice',fx.context),'報告が更新されています。「更新」で最新の状況を確認してください。');
  assert.equal(select.disabled||note.disabled||save.disabled,false);
  assert.equal(vm.runInContext('refreshed',fx.context),0);
});
test('一覧の行は、対応するか保留の要望にだけ、判定の印を出す。未判定と、要望でない報告には出さない',()=>{
  const fx=fixture([report('a',{decision:decided('accept')}),report('b',{decision:decided('defer')}),report('c'),report('d',{kind:'bug',decision:decided('defer')})]);
  fx.render();
  assert.deepEqual(fx.marks(),[['受付済み','要望','対応する'],['受付済み','要望','保留'],['受付済み','要望'],['受付済み']]);
});
test('判定の絞り込みを選ぶと、その判定の要望だけを出す。複数選べて、何も選んでいないときは、絞り込まない',()=>{
  const fx=fixture([report('a',{decision:decided('accept')}),report('b',{decision:decided('defer')}),report('c'),report('d',{kind:'bug'})]);
  const titles=()=>fx.node('#reports').children.map(row=>row.children[0].children[0].children.find(part=>classes(part).includes('report-title')).textContent);
  fx.choose('#decision-filter','defer');assert.deepEqual(titles(),['報告 b']);
  fx.choose('#decision-filter',['accept','defer']);assert.deepEqual(titles(),['報告 a','報告 b']);
  fx.choose('#decision-filter','undecided');assert.deepEqual(titles(),['報告 c']);
  fx.choose('#decision-filter','');assert.deepEqual(titles(),['報告 a','報告 b','報告 c','報告 d']);
  assert.equal(fx.node('#report-count').textContent,'4 / 4件');
});
