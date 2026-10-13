import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as view from '../dist/bugs/view.mjs';

// 登録前のカテゴリ（#68）の画面。実際の画面のコードを、擬似DOMと偽のAPIで動かす。
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
const tags=[{id:11,name:'予約',color:'336699',role:'main'},{id:12,name:'一覧',color:'993366',role:'sub'},{id:13,name:'通知',color:'339966',role:'main'},{id:14,name:'bug',color:'cc0000',role:'none'},{id:15,name:'新しいタグ',color:'888888',role:null}];
const label=id=>tags.find(tag=>tag.id===id);
// 名前の並びは照合順序に依存するため、同じ役割の中の順序は検査しない。
const boxOf=(holder,name)=>[...holder.walk()].find(node=>node.tag==='label'&&node.children[1].textContent===name).children[0];
const ids=choices=>choices.map(choice=>choice.id).sort((a,b)=>a-b);
const report=(id,{state='pending',repository='qa/booking-reports',categories=[],labels=[],tagState='unfetched',missing=[],revision=3}={})=>({
  id,title:'架空の報告 '+id,body:'架空の本文',status:'received',reporterName:'共通の利用者',createdAt:'2030-01-01T00:00:00.000Z',reportedVersion:'',targetVersion:'',developerNote:'',
  attachments:[],attachmentCount:0,attachmentBytes:0,history:[],isOwn:true,revision,categories,
  github:{state,repository,number:state==='registered'?101:null,url:null,error:null,retryAt:0,revision:1,tags:{state:tagState,labels,fetchedAt:null,error:null,missing}}
});

function fixture({assigned=tags,reports=[],details=new Map(),saveFailure=null,failReports=0,stubOpen=false}={}) {
  const nodes=new Map(),requests=[],timers=[];let failed=0;
  const node=selector=>{
    if(!nodes.has(selector)) {
      const found=selector.startsWith('#')&&nodes.has('#detail')?nodes.get('#detail').querySelector(selector):null;
      if(found)return found;
      nodes.set(selector,new Element());
    }
    return nodes.get(selector);
  };
  for(const selector of ['#main-filter','#sub-filter','#registration-filter','#status-filter'])node(selector).value='all';
  const form=node('#report-form'),files=new Element('input'),body=new Element('textarea'),version=new Element('input');
  files.files=[];body.value='架空の再現報告';
  form.elements=Object.assign([files,body,version,node('#submit-report')],{files,body,reportedVersion:version,kind:{value:'bug'}});
  form.reset=()=>{files.files=[];body.value=version.value='';for(const input of node('#category-choices').querySelectorAll('input'))input.checked=false;};
  let currentTags=assigned;
  const respond=(route,options)=>{
    requests.push({route,body:options.body&&typeof options.body==='string'?JSON.parse(options.body):undefined});
    if(route==='uploads')return{status:200,value:{attachments:[]}};
    if(route==='reports'&&options.method==='POST')return failed++<failReports?{status:503,value:{error:'架空の送信失敗'}}:{status:201,value:{report:{id:'accepted'}}};
    if(route==='reports')return{status:200,value:{reports}};
    const categories=/^reports\/([a-z0-9-]+)\/categories$/.exec(route);
    if(categories)return saveFailure?{status:409,value:{error:saveFailure}}:{status:200,value:{report:details.get(categories[1])}};
    const detail=/^reports\/([a-z0-9-]+)$/.exec(route);
    if(detail&&details.has(detail[1]))return{status:200,value:{report:details.get(detail[1])}};
    throw new Error('Unexpected request: '+route);
  };
  const fetch=async(url,options={})=>{const result=respond(url.replace('/api/bugs/',''),options);return{ok:result.status<400,status:result.status,json:async()=>result.value};};
  const context=vm.createContext({...view,mountTagRoles:()=>({load:async()=>null,tags:()=>currentTags}),document:{querySelector:node,createElement:tag=>new Element(tag)},fetch,URL,
    location:{href:'http://127.0.0.1:4327/bugs/'},history:{replaceState(){}},crypto:{randomUUID:()=>'id'},matchMedia:()=>({matches:false}),
    setTimeout:(fn,ms)=>{timers.push({fn,ms,live:true});return timers.length;},clearTimeout:id=>{if(timers[id-1])timers[id-1].live=false;}});
  const source=readFileSync(new URL('../dist/bugs/app.mjs',import.meta.url),'utf8');
  const app=source.replace(/^import .*\n/gm,''),end=app.lastIndexOf('\ntry { showActor');
  assert.ok(source.startsWith('import ')&&end>0,'App import and bootstrap boundaries must exist');
  vm.runInContext(app.slice(0,end),context);
  if(stubOpen)vm.runInContext('refresh=async()=>{};openReport=async()=>{};',context);
  vm.runInContext('actor={id:"local-shared",role:"admin",shared:true,policy:{maxFiles:20,maxBytes:1000},github:{enabled:true,repository:"qa/booking-reports"}};notice=message=>{lastNotice=message};var lastNotice="";',context);
  const choices=()=>[...node('#category-choices').walk()].filter(item=>item.tag==='label').map(item=>({name:item.children[1].textContent,checked:item.children[0].checked,value:item.children[0].value}));
  const boxCount=()=>node('#category-choices').querySelectorAll('input').length;
  return{
    node,requests,timers,context,boxCount,
    setTags:value=>{currentTags=value;},
    choices,
    groups:()=>[...node('#category-choices').walk()].filter(item=>item.className==='category-role').map(item=>item.textContent),
    open:()=>node('#new-report').onclick(),
    tick:async()=>{for(const timer of [...timers]){if(timer.live){timer.live=false;await timer.fn();}}},
    check(name,on=true){for(const item of [...node('#category-choices').walk()].filter(entry=>entry.tag==='label'))if(item.children[1].textContent===name)item.children[0].checked=on;},
    submit:()=>form.onsubmit({preventDefault(){},currentTarget:form}),
    sent:()=>requests.filter(request=>request.route==='reports'&&request.body).map(request=>request.body),
    detail:()=>node('#detail'),
    show:async id=>{await vm.runInContext('openReport',context)(id,false);},
    panel:()=>node('#detail').querySelector('#category-status'),
    github:()=>node('#detail').querySelector('#github-status'),
    texts:holder=>[holder,...holder.walk()].map(item=>item.textContent).filter(Boolean),
    notice:()=>vm.runInContext('lastNotice',context),
    setReports:value=>{reports.splice(0,reports.length,...value);},
    run:code=>vm.runInContext(code,context)
  };
}

test('報告フォームは、メインとサブを割り当てたタグだけを、役割ごとに名前順で選ばせる',async()=>{
  const fx=fixture({stubOpen:true});await fx.open();
  assert.equal(fx.node('#report-categories').hidden,false);
  assert.deepEqual(fx.groups(),['メイン','サブ']);
  assert.deepEqual(fx.choices().map(item=>item.name).sort(),['一覧','予約','通知'].sort());
  assert.deepEqual(fx.choices().map(item=>item.value).sort(),['11','12','13']);
  assert.equal(fx.choices().at(-1).name,'一覧','サブは、メインのあとに並べる');
  assert.ok(fx.choices().every(item=>!item.checked));
});
test('選べるタグがないときは、カテゴリの欄ごと隠す',async()=>{
  const none=fixture({assigned:[],stubOpen:true});await none.open();
  assert.equal(none.node('#report-categories').hidden,true);assert.equal(none.boxCount(),0);
  const unused=fixture({assigned:[{...label(14)},{...label(15)}],stubOpen:true});await unused.open();
  assert.equal(unused.node('#report-categories').hidden,true);
  const onlySub=fixture({assigned:[label(12)],stubOpen:true});await onlySub.open();
  assert.equal(onlySub.node('#report-categories').hidden,false);assert.deepEqual(onlySub.groups(),['サブ']);
});
test('選んだカテゴリを、タグのidで報告の作成に添える。選ばなければ空にする',async()=>{
  const fx=fixture({stubOpen:true});await fx.open();
  fx.check('予約');fx.check('一覧');await fx.submit();
  assert.deepEqual(fx.sent().map(body=>body.categories),[[11,12]]);
  const other=fixture({stubOpen:true});await other.open();await other.submit();
  assert.deepEqual(other.sent().map(body=>body.categories),[[]]);
});
test('送信に失敗しても選びは残り、開き直しても残る。送信に成功すると選びを外す',async()=>{
  const fx=fixture({stubOpen:true,failReports:1});await fx.open();
  fx.check('通知');
  await fx.submit();
  assert.equal(fx.sent().length,1);
  assert.deepEqual(fx.choices().filter(item=>item.checked).map(item=>item.name),['通知']);
  await fx.open();
  assert.deepEqual(fx.choices().filter(item=>item.checked).map(item=>item.name),['通知']);
  await fx.submit();
  assert.deepEqual(fx.sent().map(body=>body.categories),[[13],[13]]);
  assert.deepEqual(fx.choices().filter(item=>item.checked),[]);
});
test('割り当てを変えたあとにフォームを開き直すと、新しい割り当てで描き、外れたタグの選びは捨てる',async()=>{
  const fx=fixture({stubOpen:true});await fx.open();fx.check('予約');fx.check('一覧');
  fx.setTags(tags.map(tag=>tag.id===11?{...tag,role:'none'}:tag));
  await fx.open();
  assert.deepEqual(fx.choices().map(item=>[item.name,item.checked]),[['通知',false],['一覧',true]]);
});

test('登録前の報告は保留したカテゴリで領域と絞り込みに出て、登録後はGitHubのタグを使う',()=>{
  const roles=view.roleMap(tags);
  const pending=report('p',{categories:[11,12]});
  assert.equal(view.areaText(pending,roles),'予約 / 一覧');
  for(const state of ['creating','unknown','failed'])assert.equal(view.areaText(report('x',{state,categories:[13]}),roles),'通知',state);
  // 登録後は、保留したカテゴリが残っていても、GitHubのタグだけを使う。
  const registered=report('r',{state:'registered',categories:[11],labels:[label(13)],tagState:'ok'});
  assert.equal(view.areaText(registered,roles),'通知');
  assert.equal(view.areaText(report('r2',{state:'registered',categories:[11],tagState:'unfetched'}),roles),'');
  assert.equal(view.areaText(report('legacy'),roles),'');
  assert.equal(view.areaText({github:{state:'pending',tags:{labels:[]}}},roles),'');
  // 役割を割り当てていないタグを選んでいても、カテゴリには数えない。
  assert.equal(view.areaText(report('n',{categories:[14,15]}),roles),'');
  const filters={roles};
  assert.equal(view.matchesFilters(pending,{...filters,main:'label:11'}),true);
  assert.equal(view.matchesFilters(pending,{...filters,main:'label:13'}),false);
  assert.equal(view.matchesFilters(pending,{...filters,sub:'label:12'}),true);
  assert.equal(view.matchesFilters(pending,{...filters,main:view.uncategorized}),false);
  assert.equal(view.matchesFilters(report('u'),{...filters,main:view.uncategorized}),true);
});
test('メインとサブの選択肢の件数に、登録前の報告の保留したカテゴリを数える',()=>{
  const reports=[report('a',{categories:[11,12]}),report('b',{categories:[11]}),report('c',{state:'registered',labels:[label(11),label(12)],tagState:'ok'}),report('d',{categories:[13]}),report('e')];
  const main=view.mainChoices(reports,tags).map(choice=>choice.text);
  assert.equal(main[0],'すべて');assert.equal(main.at(-1),'未分類（1）');assert.deepEqual(main.slice(1,-1).sort(),['予約（3）','通知（1）'].sort());
  assert.deepEqual(view.subChoices(reports,tags,'label:11').map(choice=>choice.text),['すべて','一覧（2）']);
  assert.deepEqual(view.subChoices(reports,tags,'label:13').map(choice=>choice.text),['すべて']);
  const selectable=view.selectableCategories(tags);
  assert.deepEqual(ids(selectable.main),[11,13]);assert.deepEqual(selectable.sub,[{id:12,name:'一覧'}]);
  assert.deepEqual(view.selectableCategories([]),{main:[],sub:[]});
});
test('カテゴリを変えられるのは、登録待ちと登録失敗だけ',()=>{
  assert.deepEqual(['pending','failed','creating','unknown','registered'].map(state=>view.categoriesEditable(report('x',{state}))),[true,true,false,false,false]);
});

test('登録待ちの報告の詳細は、保留したカテゴリを選び直す欄を出し、保存で更新番号と選んだidを送る',async()=>{
  const item=report('p1',{categories:[11,12],revision:7}),fx=fixture({reports:[item],details:new Map([['p1',item]])});
  await fx.show('p1');
  const panel=fx.panel();
  assert.ok(panel.querySelector('.category-panel'));
  const state=()=>Object.fromEntries([...panel.walk()].filter(node=>node.tag==='label').map(node=>[node.children[1].textContent,node.children[0].checked]));
  assert.deepEqual(state(),{予約:true,通知:false,一覧:true});
  boxOf(panel,'通知').checked=true;boxOf(panel,'予約').checked=false;
  fx.run('refresh=async()=>{refreshed=true};var refreshed=false;');
  const save=[...panel.walk()].find(node=>node.tag==='button'&&node.textContent==='カテゴリを保存');
  await save.onclick();
  const sent=fx.requests.find(request=>request.route==='reports/p1/categories');
  assert.deepEqual(sent.body,{categories:[13,12],revision:7},'画面の並び（メイン、サブ）の順に、チェックしたタグのidを送る');
  assert.equal(fx.run('refreshed'),true);assert.equal(fx.notice(),'カテゴリを保存しました。');
});
test('保存に失敗したときは、理由を欄に出し、選びを残して、もう一度保存できるようにする',async()=>{
  const item=report('p1',{categories:[11]}),fx=fixture({reports:[item],details:new Map([['p1',item]]),saveFailure:'報告が更新されています。「更新」で最新の状況を確認してください。'});
  await fx.show('p1');
  const panel=fx.panel(),save=[...panel.walk()].find(node=>node.tag==='button');
  await save.onclick();
  const error=[...panel.walk()].find(node=>node.className==='error-text');
  assert.match(error.textContent,/報告が更新されています/);assert.equal(save.disabled,false);
  assert.equal([...panel.walk()].filter(node=>node.tag==='input'&&node.checked).length,1);
});
test('登録失敗の報告も選び直せる。作成中と結果未確認は選んだカテゴリを示すだけ。登録済みは欄を出さない',async()=>{
  const items=new Map([['f',report('f',{state:'failed',categories:[11]})],['c',report('c',{state:'creating',categories:[11,12]})],['u',report('u',{state:'unknown',categories:[13]})],
    ['r',report('r',{state:'registered',categories:[11],labels:[label(13)],tagState:'ok'})],['n',report('n',{state:'creating'})]]);
  const fx=fixture({reports:[...items.values()],details:items});
  await fx.show('f');assert.ok(fx.panel().querySelector('.category-panel'));
  for(const [id,text] of [['c','選んだカテゴリ：予約 / 一覧'],['u','選んだカテゴリ：通知']]) {
    await fx.show(id);assert.equal(fx.panel().querySelector('.category-panel'),null,id);assert.deepEqual(fx.texts(fx.panel()),[text],id);
  }
  await fx.show('r');assert.deepEqual(fx.texts(fx.panel()),[]);
  await fx.show('n');assert.deepEqual(fx.texts(fx.panel()),[]);
});
test('選べるタグがなく、保留したカテゴリもない登録待ちの報告は、カテゴリの欄を出さない',async()=>{
  const item=report('p1'),fx=fixture({assigned:[],reports:[item],details:new Map([['p1',item]])});
  await fx.show('p1');assert.deepEqual(fx.texts(fx.panel()),[]);
});
test('作成後の最初の取得で付かなかったタグは、GitHub登録の欄に示す',async()=>{
  const item=report('r',{state:'registered',categories:[11,13],labels:[],tagState:'ok',missing:[{id:11,name:'予約'},{id:13,name:null}]}),fx=fixture({reports:[item],details:new Map([['r',item]])});
  await fx.show('r');
  assert.ok(fx.texts(fx.github()).includes('選んだカテゴリが付いていません：予約、不明なタグ'));
  const clean=report('c',{state:'registered',labels:[label(11)],tagState:'ok'}),other=fixture({reports:[clean],details:new Map([['c',clean]])});
  await other.show('c');
  assert.ok(!other.texts(other.github()).some(text=>/付いていません/.test(text)));
});
test('登録の状態が変わるまでは、選んでいる途中の欄を描き直さず、変わったら描き直す',async()=>{
  const item=report('p1',{categories:[11],revision:2}),reports=[item],fx=fixture({reports,details:new Map([['p1',item]])});
  await fx.show('p1');
  const before=fx.panel().children[0];
  boxOf(before,'通知').checked=true;
  Object.assign(fx.context,{__reports:reports});fx.run('reports=__reports;scheduleStatusRefresh();');
  await fx.tick();
  assert.equal(fx.panel().children[0],before,'状態が同じなら、同じ欄のまま');
  assert.equal([...before.walk()].filter(node=>node.tag==='input'&&node.checked).length,2);
  fx.setReports([report('p1',{state:'registered',categories:[11],labels:[label(11)],tagState:'ok'})]);
  await fx.tick();
  assert.equal(fx.panel().children.length,0,'登録後は、欄を外す');
});
