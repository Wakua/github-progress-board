import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultShown,filterTypes,parseShown,mountFilterBar,storageKey} from '../dist/bugs/filter-bar.mjs';

// 絞り込みの枠を、擬似DOMで動かし、条件を足す・外す・覚える動作を確かめる。
class Node {
  constructor(tag='div') {this.tag=tag;this.children=[];this.hidden=false;this.value='';this.textContent='';this.dataset={};this.focused=false;}
  replaceChildren(...children) {this.children=[...children];}
  focus() {this.focused=true;}
}
function fixture(stored=null) {
  globalThis.document={createElement:tag=>new Node(tag)};
  const labels=filterTypes.map(type=>{
    const label=new Node('label'),select=new Node('select'),remove=new Node('button');
    label.dataset.filter=type.id;select.value='all';
    label.querySelector=selector=>selector==='select'?select:remove;
    label.select=select;label.remove=remove;return label;
  });
  const picker=new Node('select'),add=new Node('div');add.querySelector=()=>picker;
  const root={querySelectorAll:()=>labels,querySelector:selector=>selector==='.add-filter'?add:null};
  const saved=[],removed=[];let store=stored;
  const bar=mountFilterBar({root,storage:{get:()=>store,set:text=>{store=text;saved.push(text);}},onRemove:id=>removed.push(id)});
  const byId=id=>labels.find(label=>label.dataset.filter===id);
  return {bar,labels,byId,picker,add,saved,removed,visible:()=>labels.filter(label=>!label.hidden).map(label=>label.dataset.filter),options:()=>picker.children.map(option=>option.value)};
}

test('既定では、メイン・サブ・対応状況だけを出し、「＋ 条件」に、ほかの条件を並べる',()=>{
  const fx=fixture();
  assert.deepEqual(defaultShown,['main','sub','status']);
  assert.deepEqual(fx.visible(),['main','sub','status']);
  assert.deepEqual(fx.options(),['','kind','registration']);
  assert.equal(fx.add.hidden,false);
  assert.equal(fx.picker.children[0].textContent,'＋ 条件');
});
test('「＋ 条件」で選んだ条件を、出し、その入力欄へフォーカスを移し、覚える',()=>{
  const fx=fixture();
  fx.picker.value='kind';fx.picker.onchange();
  assert.deepEqual(fx.visible(),['main','sub','status','kind']);
  assert.equal(fx.byId('kind').select.focused,true);
  assert.deepEqual(JSON.parse(fx.saved.at(-1)),['main','sub','status','kind']);
  assert.deepEqual(fx.options(),['','registration']);
  assert.equal(fx.picker.value,'');
});
test('すべての条件を出したときは、「＋ 条件」を隠す',()=>{
  const fx=fixture();
  for(const id of ['kind','registration']){fx.picker.value=id;fx.picker.onchange();}
  assert.equal(fx.add.hidden,true);
  assert.deepEqual(fx.visible(),filterTypes.map(type=>type.id));
});
test('条件を外すと、その条件を「すべて」に戻し、隠し、覚え、呼び出し元に知らせる',()=>{
  const fx=fixture();
  fx.byId('status').select.value='working';
  fx.byId('status').remove.onclick();
  assert.equal(fx.byId('status').select.value,'all');
  assert.equal(fx.byId('status').hidden,true);
  assert.deepEqual(fx.visible(),['main','sub']);
  assert.deepEqual(fx.removed,['status']);
  assert.deepEqual(JSON.parse(fx.saved.at(-1)),['main','sub']);
  assert.ok(fx.options().includes('status'));
});
test('覚えた条件を、次に開いたとき、そのまま出す',()=>{
  const fx=fixture(JSON.stringify(['main','kind']));
  assert.deepEqual(fx.visible(),['main','kind']);
  assert.deepEqual(fx.options(),['','sub','status','registration']);
});
test('覚えた内容が読めないとき、知らない条件を含むときは、既定にする',()=>{
  for(const stored of [null,'','{','"main"','["main","nope"]','{"a":1}'])assert.deepEqual(parseShown(stored),defaultShown,String(stored));
  assert.deepEqual(parseShown(JSON.stringify(['registration','main'])),['main','registration'],'並びは、条件の定義の順にする');
});
test('覚える場所の名前を、変えない',()=>{
  assert.equal(storageKey,'bug-report-filters');
});
