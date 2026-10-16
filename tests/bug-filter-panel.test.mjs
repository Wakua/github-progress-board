import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {filterDefs,summaryText,toggled,mountFilterPanel} from '../dist/bugs/filter-panel.mjs';
import {matchesFilters,mainChoices,subChoices,roleMap,uncategorized} from '../dist/bugs/view.mjs';

// 絞り込みの枠（#105）を、擬似DOMで動かし、チェックを入れたらすぐ絞り込む動作を確かめる。
class Node {
  constructor(tag='div') {this.tag=tag;this.children=[];this.hidden=false;this.open=false;this.checked=false;this.value='';this.textContent='';this.className='';this.dataset={};this.listeners={};this.focused=false;}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children=[...children];}
  addEventListener(type,listener) {(this.listeners[type]||=[]).push(listener);}
  fire(type,event={}) {for(const listener of this.listeners[type]||[])listener(event);}
  focus() {this.focused=true;}
  contains(node) {return node===this||this.children.some(child=>child.contains?.(node));}
  *walk() {for(const child of this.children){yield child;yield* child.walk();}}
}
function fixture() {
  const clicks=[];
  globalThis.document={createElement:tag=>new Node(tag),addEventListener:(type,listener)=>{if(type==='click')clicks.push(listener);}};
  const root=new Node(),changes=[];
  const panel=mountFilterPanel({root,onChange:id=>changes.push(id)});
  const group=id=>root.children.find(node=>node.dataset.filter===id);
  const summary=id=>group(id).children[0],menu=id=>group(id).children[1];
  const boxes=id=>[...menu(id).walk()].filter(node=>node.tag==='input');
  const clear=id=>[...menu(id).walk()].find(node=>node.className.includes('filter-clear'));
  const check=(id,value,on=true)=>{const box=boxes(id).find(input=>input.value===value);box.checked=on;box.onchange();};
  const texts=id=>[...menu(id).walk()].filter(node=>node.tag==='span').map(node=>node.textContent);
  return {root,panel,changes,group,summary,menu,boxes,clear,check,texts,outsideClick:()=>clicks.forEach(listener=>listener({target:new Node()})),insideClick:()=>clicks.forEach(listener=>listener({target:group('kind')}))};
}
const tags=[{id:1,name:'予約',role:'main'},{id:2,name:'通知',role:'main'},{id:3,name:'一覧',role:'sub'},{id:4,name:'画面',role:'sub'}];
const label=id=>({id,name:tags.find(tag=>tag.id===id).name});
const report=(id,{status='received',kind,state='registered',ids=[]}={})=>({id,status,...(kind?{kind}:{}),github:{state,tags:{labels:ids.map(label)}}});

test('条件は、メイン・サブ・対応状況・種別・GitHub登録の順に、ボタンで並ぶ。選択肢のないメインとサブは隠す',()=>{
  const fx=fixture();
  assert.deepEqual(filterDefs.map(def=>def.id),['main','sub','status','kind','registration']);
  assert.deepEqual(fx.root.children.map(node=>node.dataset.filter),['main','sub','status','kind','registration']);
  assert.deepEqual(fx.root.children.map(node=>node.children[0].textContent),['メイン','サブ','対応状況','種別','GitHub登録']);
  assert.deepEqual(fx.root.children.map(node=>node.hidden),[true,true,false,false,false]);
  assert.deepEqual(fx.texts('status'),['確認完了を除く','受付済み','対応中','修正済み・公開待ち','テスター確認待ち','確認完了']);
  assert.deepEqual(fx.texts('kind'),['不具合','要望','確認']);
  assert.deepEqual(fx.texts('registration'),['登録待ち・未登録','登録中','登録済み','登録失敗','作成結果が未確認']);
  for(const def of filterDefs)assert.deepEqual(fx.panel.values(def.id),[]);
});
test('チェックを入れると、その場で選びが変わり、onChangeを呼ぶ。ボタンに選んだ値を出す',()=>{
  const fx=fixture();
  fx.check('kind','request');
  assert.deepEqual(fx.panel.values('kind'),['request']);assert.deepEqual(fx.changes,['kind']);
  assert.equal(fx.summary('kind').textContent,'種別：要望');assert.equal(fx.group('kind').className,'filter-group on');
  assert.equal(fx.clear('kind').hidden,false);
  fx.check('kind','request',false);
  assert.deepEqual(fx.panel.values('kind'),[]);assert.deepEqual(fx.changes,['kind','kind']);
  assert.equal(fx.summary('kind').textContent,'種別');assert.equal(fx.group('kind').className,'filter-group');assert.equal(fx.clear('kind').hidden,true);
});
test('同じ条件の中で、複数の値を選べる。ほかの条件の選びは変えない',()=>{
  const fx=fixture();
  fx.check('registration','failed');fx.check('registration','unknown');fx.check('kind','bug');
  assert.deepEqual(fx.panel.values('registration').sort(),['failed','unknown']);
  assert.equal(fx.summary('registration').textContent,'GitHub登録：登録失敗・作成結果が未確認');
  assert.deepEqual(fx.panel.values('kind'),['bug']);
  assert.deepEqual(fx.panel.values('status'),[]);
});
test('「確認完了を除く」は、ほかの状況と一緒には選べない',()=>{
  const fx=fixture();
  fx.check('status','received');fx.check('status','working');
  fx.check('status','incomplete');
  assert.deepEqual(fx.panel.values('status'),['incomplete']);
  assert.deepEqual(fx.boxes('status').filter(input=>input.checked).map(input=>input.value),['incomplete']);
  fx.check('status','checking');
  assert.deepEqual(fx.panel.values('status'),['checking']);
  assert.equal(fx.boxes('status').find(input=>input.value==='incomplete').checked,false);
  assert.deepEqual([...toggled(new Set(['received']),'incomplete',true,'incomplete')],['incomplete']);
  assert.deepEqual([...toggled(new Set(['incomplete']),'working',true,'incomplete')],['working']);
  assert.deepEqual([...toggled(new Set(['a','b']),'a',false)],['b']);
  assert.deepEqual([...toggled(new Set(),'x',true)],['x']);
});
test('「解除」は、その条件の選びをすべて外し、onChangeを呼ぶ。何も選んでいないときは出さない',()=>{
  const fx=fixture();
  assert.equal(fx.clear('kind').hidden,true);
  fx.check('kind','bug');fx.check('kind','question');
  const before=fx.changes.length;
  fx.clear('kind').onclick();
  assert.deepEqual(fx.panel.values('kind'),[]);assert.equal(fx.boxes('kind').some(input=>input.checked),false);
  assert.equal(fx.changes.length,before+1);assert.equal(fx.changes.at(-1),'kind');assert.equal(fx.clear('kind').hidden,true);assert.equal(fx.summary('kind').textContent,'種別');
});
test('メインとサブの選択肢は、渡されたものを並べる。ボタンには件数を出さない。なくなった値の選びは外す。選択肢がなければ隠す',()=>{
  const fx=fixture();
  fx.panel.setChoices('main',[{value:'label:1',text:'予約（3）'},{value:'label:2',text:'通知（1）'},{value:'uncategorized',text:'未分類（0）'}]);
  assert.equal(fx.group('main').hidden,false);assert.deepEqual(fx.texts('main'),['予約（3）','通知（1）','未分類（0）']);
  fx.check('main','label:1');fx.check('main','label:2');
  assert.equal(fx.summary('main').textContent,'メイン：予約・通知');
  fx.panel.setChoices('main',[{value:'label:2',text:'通知（2）'},{value:'uncategorized',text:'未分類（0）'}]);
  assert.deepEqual(fx.panel.values('main'),['label:2']);assert.equal(fx.summary('main').textContent,'メイン：通知');
  fx.panel.setChoices('main',[]);
  assert.equal(fx.group('main').hidden,true);assert.deepEqual(fx.panel.values('main'),[]);
});
test('選択肢が変わらないときは、メニューを作り直さず、チェックボックスを残す。変わったときは、作り直す',()=>{
  const fx=fixture();
  const list=[{value:'label:1',text:'予約（3）'},{value:'label:2',text:'通知（1）'}];
  fx.panel.setChoices('main',list);
  const first=fx.boxes('main');
  fx.check('main','label:1');
  fx.panel.setChoices('main',list.map(choice=>({...choice})));
  assert.deepEqual(fx.boxes('main'),first);assert.equal(fx.boxes('main')[0],first[0]);
  assert.deepEqual(fx.panel.values('main'),['label:1']);
  fx.panel.setChoices('main',[{value:'label:1',text:'予約（4）'},{value:'label:2',text:'通知（1）'}]);
  assert.notEqual(fx.boxes('main')[0],first[0]);assert.deepEqual(fx.panel.values('main'),['label:1']);assert.equal(fx.boxes('main')[0].checked,true);
});
test('メニューは、1つだけ開く。枠の外を押すと閉じ、枠の中を押しても閉じない。Escapeで閉じて、ボタンへ戻る',()=>{
  const fx=fixture();
  fx.group('status').open=true;fx.group('status').fire('toggle');
  fx.group('kind').open=true;fx.group('kind').fire('toggle');
  assert.equal(fx.group('status').open,false);assert.equal(fx.group('kind').open,true);
  fx.insideClick();assert.equal(fx.group('kind').open,true);
  fx.root.fire('keydown',{key:'a'});assert.equal(fx.group('kind').open,true);
  fx.root.fire('keydown',{key:'Escape'});
  assert.equal(fx.group('kind').open,false);assert.equal(fx.summary('kind').focused,true);
  fx.group('registration').open=true;fx.group('registration').fire('toggle');
  fx.outsideClick();
  assert.equal(fx.group('registration').open,false);
  fx.outsideClick();
});
test('画面の枠は、「＋ 条件」と × を持たず、条件を並べる枠だけを持つ',()=>{
  const html=readFileSync(new URL('../dist/bugs/index.html',import.meta.url),'utf8');
  assert.match(html,/<div class="filter-groups" id="filter-groups"><\/div>/);
  for(const gone of ['add-filter','filter-remove','id="main-filter"','id="kind-filter"','id="status-filter"','id="registration-filter"'])assert.equal(html.includes(gone),false,gone);
});

test('判定：同じ条件の中は「どれか」、条件同士は「すべて」。何も選んでいない条件は、絞り込まない',()=>{
  const roles=roleMap(tags);
  const reports=[report('a',{ids:[1,3]}),report('b',{status:'working',kind:'request',ids:[2,4]}),report('c',{status:'complete',kind:'question',ids:[1]}),report('d',{state:'failed',ids:[]})];
  const ids=filters=>reports.filter(item=>matchesFilters(item,{roles,...filters})).map(item=>item.id);
  assert.deepEqual(ids({}),['a','b','c','d']);
  assert.deepEqual(ids({main:[],sub:[],status:[],kind:[],state:[]}),['a','b','c','d']);
  assert.deepEqual(ids({main:['label:1','label:2']}),['a','b','c']);
  assert.deepEqual(ids({main:['label:2',uncategorized]}),['b','d']);
  assert.deepEqual(ids({sub:['label:3','label:4']}),['a','b']);
  assert.deepEqual(ids({status:['received','working']}),['a','b','d']);
  assert.deepEqual(ids({status:['incomplete']}),['a','b','d']);
  assert.deepEqual(ids({kind:['request','question']}),['b','c']);
  assert.deepEqual(ids({kind:['bug']}),['a','d']);
  assert.deepEqual(ids({state:['failed','registered']}),['a','b','c','d']);
  assert.deepEqual(ids({state:['failed']}),['d']);
  assert.deepEqual(ids({main:['label:1','label:2'],kind:['request','question'],status:['working','complete']}),['b','c']);
  assert.deepEqual(ids({main:['label:1'],sub:['label:4']}),[]);
  assert.deepEqual(ids({found:new Set(['a','b']),main:['label:1','label:2']}),['a','b']);
  // 旧来の1つの値と、'all'も受け付ける。
  assert.deepEqual(ids({main:'label:1',status:'all'}),['a','c']);
});
test('件数：種別を複数選んだときは、選んだ種別だけで数える。サブは、選んだメインのどれかの報告に付いているものだけを出す',()=>{
  const reports=[report('a',{ids:[1,3]}),report('b',{kind:'request',ids:[2,4]}),report('c',{status:'complete',kind:'question',ids:[1,3]}),report('d',{kind:'question',ids:[1,4]})];
  const text=choices=>choices.map(choice=>choice.text);
  const counts=choices=>Object.fromEntries(choices.slice(1).map(choice=>[choice.value,choice.text.replace(/^.*（(\d+)）$/,'$1')]));
  assert.deepEqual(counts(mainChoices(reports,tags)),{'label:1':'2','label:2':'1',uncategorized:'0'});
  assert.deepEqual(counts(mainChoices(reports,tags,['request','question'])),{'label:1':'1','label:2':'1',uncategorized:'0'});
  assert.deepEqual(counts(mainChoices(reports,tags,['bug'])),{'label:1':'1','label:2':'0',uncategorized:'0'});
  assert.deepEqual(counts(subChoices(reports,tags,['label:2'])),{'label:4':'1'});
  assert.deepEqual(counts(subChoices(reports,tags,['label:1','label:2'])),{'label:3':'1','label:4':'2'});
  assert.deepEqual(counts(subChoices(reports,tags,[],['request'])),{'label:4':'1'});
  assert.equal(summaryText('種別',[]),'種別');assert.equal(summaryText('種別',['要望','確認']),'種別：要望・確認');
});
