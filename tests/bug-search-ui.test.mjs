import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as view from '../dist/bugs/view.mjs';

// 実際の画面のコードを、擬似DOMと偽のAPIで動かし、一覧と検索の振る舞いを検証する。
class Element {
  constructor(tag='div') {this.tag=tag;this.children=[];this.textContent='';this.hidden=false;this.value='';this.listeners={};this.classes=new Set();this.classList={toggle:(name,force)=>{if(force)this.classes.add(name);else this.classes.delete(name);},contains:name=>this.classes.has(name)};}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children=[...children];}
  get options() {return this.children;}
  addEventListener(type,listener) {(this.listeners[type]||=[]).push(listener);}
  fire(type,event={}) {for(const listener of this.listeners[type]||[])listener(event);}
}
const report=(id,title,{status='received',state='registered',repository='qa/booking-reports',body=title,labels=[]}={})=>({id,title,body,status,reporterName:'共通の利用者',createdAt:'2030-01-01T00:00:00.000Z',attachmentCount:0,github:{state,repository,tags:{state:'ok',labels}}});
const sample=()=>[report('r1','予約一覧が更新されない'),report('r2','通知メールが届かない',{status:'working'}),report('r3','支払いの合計がずれる',{state:'pending',repository:null})];

function fixture({reports=sample(),githubEnabled=true,search,tags=[]}={}) {
  const nodes=new Map(),timers=[],searchQueries=[],mounted={};
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);};
  for(const selector of ['#main-filter','#sub-filter','#registration-filter','#status-filter'])node(selector).value='all';
  node('#report-form').elements={files:{}};
  const respond=search||(async query=>({status:200,value:{ids:reports.filter(item=>item.body.includes(query)).map(item=>item.id)}}));
  const fetch=async(url,options={})=>{
    if(url!=='/api/bugs/reports/search')throw new Error('Unexpected request: '+url);
    const {query}=JSON.parse(options.body);searchQueries.push(query);
    const result=await respond(query);
    return{ok:result.status<400,status:result.status,json:async()=>result.value};
  };
  // 画面のコードのimportは取り除くため、読み込む表示用の関数は、globalとして渡す。読み込み時に呼ぶmountTagRolesは、タグの役割を返すだけの模擬にする。
  const context=vm.createContext({...view,mountTagRoles:options=>{mounted.options=options;return{load:async()=>{},tags:()=>tags};},document:{querySelector:node,createElement:tag=>new Element(tag)},fetch,URL,location:{href:'http://127.0.0.1:4327/bugs/'},crypto:{randomUUID:()=>'id'},
    setTimeout:(fn,ms)=>{timers.push({fn,ms,live:true});return timers.length;},clearTimeout:id=>{if(timers[id-1])timers[id-1].live=false;}});
  const source=readFileSync(new URL('../dist/bugs/app.mjs',import.meta.url),'utf8');
  const app=source.replace(/^import .*\n/gm,''),end=app.lastIndexOf('\ntry { showActor');
  assert.ok(source.startsWith('import ')&&end>0,'App import and bootstrap boundaries must exist');
  vm.runInContext(app.slice(0,end),context);
  vm.runInContext('actor={id:"local-shared",role:"admin",shared:true,github:{enabled:'+githubEnabled+',repository:"qa/booking-reports"}};',context);
  context.reports=undefined;vm.runInContext('reports=__reports',Object.assign(context,{__reports:reports}));
  const box=()=>node('#reports');
  return {
    node,searchQueries,timers,
    titles:()=>box().children.map(row=>row.children[0].children[0].textContent),
    areas:()=>box().children.map(row=>row.children[0].children[1]?.textContent??null),
    choices:selector=>node(selector).options.map(option=>option.textContent),
    choose(selector,value) {node(selector).value=value;node(selector).onchange();},
    filters:()=>vm.runInContext('renderFilters()',context),
    mounted,
    setTags:value=>{tags=value;},
    marks:()=>box().children.map(row=>row.children[1].children.length),
    count:()=>node('#report-count').textContent,
    type(value,{composing=false}={}) {node('#search').value=value;node('#search').oninput({isComposing:composing});},
    pending:()=>timers.filter(timer=>timer.live),
    async flush() {for(const timer of timers){if(timer.live){timer.live=false;await timer.fn();}}},
    render:()=>vm.runInContext('renderList()',context),
    reload:result=>context.reload(result)
  };
}

test('検索欄に語を入れると、300ms後に本文へ一致した報告だけを一覧に出す',async()=>{
  const fx=fixture();fx.render();
  assert.deepEqual(fx.titles(),['予約一覧が更新されない','通知メールが届かない','支払いの合計がずれる']);
  fx.type('メール');assert.equal(fx.pending().length,1);assert.equal(fx.pending()[0].ms,300);assert.deepEqual(fx.searchQueries,[]);
  await fx.flush();
  assert.deepEqual(fx.searchQueries,['メール']);assert.deepEqual(fx.titles(),['通知メールが届かない']);assert.equal(fx.count(),'1 / 3件');
});
test('続けて入力すると、前の検索を取り消し、最後の語だけを検索する',async()=>{
  const fx=fixture();fx.render();
  fx.type('通');fx.type('通知');assert.equal(fx.pending().length,1);
  await fx.flush();assert.deepEqual(fx.searchQueries,['通知']);
});
test('日本語の変換中は検索せず、確定してから検索する',async()=>{
  const fx=fixture();fx.render();
  fx.type('つうち',{composing:true});assert.equal(fx.pending().length,0);assert.deepEqual(fx.searchQueries,[]);
  fx.node('#search').value='通知';fx.node('#search').fire('compositionend');
  assert.equal(fx.pending().length,1);await fx.flush();
  assert.deepEqual(fx.searchQueries,['通知']);assert.deepEqual(fx.titles(),['通知メールが届かない']);
});
test('語を消すと、検索の絞り込みを外し、検索は送らない',async()=>{
  const fx=fixture();fx.render();
  fx.type('メール');await fx.flush();assert.equal(fx.titles().length,1);
  fx.type('  ');await fx.flush();
  assert.deepEqual(fx.searchQueries,['メール']);assert.equal(fx.titles().length,3);assert.equal(fx.count(),'3 / 3件');
});
test('検索に失敗したときは、古い検索結果を残さず、絞り込みを外した一覧に理由を出し、成功すると通知を消す',async()=>{
  let fail=false;
  const fx=fixture({search:async query=>fail?{status:400,value:{error:'検索語は200文字以内、10語までです。'}}:{status:200,value:{ids:['r2']}}});fx.render();
  fx.type('メール');await fx.flush();assert.equal(fx.titles().length,1);
  fail=true;fx.type('a b c d e f g h i j k');await fx.flush();
  assert.equal(fx.titles().length,3);assert.equal(fx.node('#notice').textContent,'検索語は200文字以内、10語までです。');
  assert.equal(fx.node('#notice').hidden,false);assert.equal(fx.node('#notice').classList.contains('error'),true);
  fail=false;fx.type('メール');await fx.flush();
  assert.equal(fx.node('#notice').hidden,true);assert.equal(fx.titles().length,1);
});
test('検索の他の通知は、成功しても消さない',async()=>{
  const fx=fixture();fx.render();
  fx.node('#notice').textContent='報告を受け付けました。';fx.node('#notice').hidden=false;
  fx.type('メール');await fx.flush();
  assert.equal(fx.node('#notice').hidden,false);assert.equal(fx.node('#notice').textContent,'報告を受け付けました。');
});
test('古い検索の応答は捨てて、最後の検索だけを反映する',async()=>{
  const waiting=new Map();
  const fx=fixture({search:query=>new Promise(resolve=>waiting.set(query,resolve))});fx.render();
  fx.type('予約');const first=fx.flush();
  fx.type('メール');const second=fx.flush();
  waiting.get('メール')({status:200,value:{ids:['r2']}});await second;
  assert.deepEqual(fx.titles(),['通知メールが届かない']);
  waiting.get('予約')({status:200,value:{ids:['r1']}});await first;
  assert.deepEqual(fx.titles(),['通知メールが届かない']);
});
test('一覧を読み直すと、同じ語で検索をやり直し、検索に失敗しても新しい一覧を描く',async()=>{
  let fail=false,current=sample();
  const fx=fixture({search:async query=>fail?{status:503,value:{error:'保存処理を完了できませんでした。'}}:{status:200,value:{ids:current.filter(item=>item.body.includes(query)).map(item=>item.id)}}});fx.render();
  fx.type('メール');await fx.flush();
  const reloaded=[...sample(),report('r4','メールの件名が空になる')];current=reloaded;
  await fx.reload({reports:reloaded});
  assert.deepEqual(fx.titles(),['通知メールが届かない','メールの件名が空になる']);
  fail=true;await fx.reload({reports:[...reloaded,report('r5','新しい報告')]});
  assert.equal(fx.titles().length,5);assert.equal(fx.count(),'5 / 5件');
});
test('GitHubの接続があるときだけ、登録が完了していない報告の行に印を出す',()=>{
  const connected=fixture();connected.render();
  assert.deepEqual(connected.marks(),[1,1,2]);
  const local=fixture({githubEnabled:false});local.render();
  assert.deepEqual(local.marks(),[1,1,1]);
});

const categoryTags=[{id:1,name:'bug',role:'none'},{id:2,name:'予約',role:'main'},{id:3,name:'一覧',role:'sub'},{id:4,name:'決済',role:'main'},{id:5,name:'画面',role:'sub'}];
const label=id=>({id,name:categoryTags.find(tag=>tag.id===id).name,color:'336699'});
const categorized=()=>[
  report('r1','予約一覧が更新されない',{labels:[label(2),label(3)]}),
  report('r2','予約の確認画面が崩れる',{status:'working',labels:[label(2),label(5)]}),
  report('r3','支払いの合計がずれる',{labels:[label(4)]}),
  report('r4','CSVが文字化けする',{labels:[label(1)]}),
  report('r5','予約の確認メールが届かない',{state:'pending',repository:null}),
  report('r6','画面の表示が小さい',{status:'complete',labels:[label(5)]})
];
test('メインとサブの選択肢に、未対応の件数を添え、サブは選んだメインの報告に付いているものだけを出す',()=>{
  const fx=fixture({reports:categorized(),tags:categoryTags});fx.filters();
  assert.deepEqual(fx.choices('#main-filter').sort(),['すべて','予約（2）','決済（1）','未分類（2）'].sort());
  assert.deepEqual(fx.choices('#sub-filter').sort(),['すべて','一覧（1）','画面（1）'].sort());
  fx.choose('#main-filter','label:2');
  assert.deepEqual(fx.choices('#sub-filter').sort(),['すべて','一覧（1）','画面（1）'].sort());
  fx.choose('#main-filter','label:4');
  assert.deepEqual(fx.choices('#sub-filter'),['すべて']);
});
test('メインを選ぶと、その報告だけを出し、行に領域を添える',()=>{
  const fx=fixture({reports:categorized(),tags:categoryTags});fx.filters();fx.render();
  assert.deepEqual(fx.areas(),['予約 / 一覧','予約 / 画面','決済',null,null,'画面']);
  fx.choose('#main-filter','label:2');
  assert.deepEqual(fx.titles(),['予約一覧が更新されない','予約の確認画面が崩れる']);assert.equal(fx.count(),'2 / 6件');
  fx.choose('#sub-filter','label:5');
  assert.deepEqual(fx.titles(),['予約の確認画面が崩れる']);
});
test('未分類を選ぶと、割り当てたタグのない報告と、GitHubに未登録の報告を出す',()=>{
  const fx=fixture({reports:categorized(),tags:categoryTags});fx.filters();
  fx.choose('#main-filter','uncategorized');
  assert.deepEqual(fx.titles(),['CSVが文字化けする','予約の確認メールが届かない']);
  assert.deepEqual(fx.choices('#sub-filter'),['すべて']);
});
test('メインを変えて、選んでいたサブがなくなったときは、サブを「すべて」に戻す',()=>{
  const fx=fixture({reports:categorized(),tags:categoryTags});fx.filters();
  fx.choose('#main-filter','label:2');fx.choose('#sub-filter','label:3');
  assert.deepEqual(fx.titles(),['予約一覧が更新されない']);
  fx.choose('#main-filter','label:4');
  assert.equal(fx.node('#sub-filter').value,'all');assert.deepEqual(fx.titles(),['支払いの合計がずれる']);
});
test('カテゴリの設定を保存すると、選択肢と行の領域を、新しい割り当てで描き直す',()=>{
  const fx=fixture({reports:categorized(),tags:categoryTags.map(tag=>({...tag,role:'none'}))});fx.filters();fx.render();
  assert.deepEqual(fx.choices('#main-filter').sort(),['すべて','未分類（5）'].sort());assert.deepEqual(fx.areas().filter(Boolean),[]);
  fx.setTags(categoryTags);fx.mounted.options.onSave();
  assert.ok(fx.choices('#main-filter').includes('予約（2）'));assert.equal(fx.areas()[0],'予約 / 一覧');
});
test('タグの役割を割り当てていないときは、行に領域を出さない',()=>{
  const fx=fixture();fx.filters();fx.render();
  assert.deepEqual(fx.areas(),[null,null,null]);assert.deepEqual(fx.choices('#main-filter'),['すべて','未分類（3）']);
});
