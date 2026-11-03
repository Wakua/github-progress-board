import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as view from '../dist/bugs/view.mjs';
import {createFilterPanelStub} from './filter-panel-stub.mjs';
import {createBugDom,loadBugApp} from './support/bug-ui.mjs';

const original=readFileSync(new URL('../dist/bugs/app.mjs',import.meta.url),'utf8');
const multiline=original.replace(/^import \{([^}]+)\} from '[^']+';/gm,line=>line.replace('{','{\n  ').replaceAll(',',',\n  ').replace('} from','\n} from').replaceAll("'",'"'));
function fixture(source) {
  const {node,document}=createBugDom(),panel=createFilterPanelStub(),calls=[];
  node('#report-form').elements={files:{}};
  const context=vm.createContext({...view,document,mountFilterPanel:panel.mountFilterPanel,mountTagRoles:()=>({load:async()=>null,tags:()=>[]}),URL,location:{href:'http://127.0.0.1/bugs/'},crypto:{randomUUID:()=>'id'},setTimeout:()=>0,clearTimeout(){},fetch:async url=>{calls.push(url);throw Error('Bootstrap must not run');}});
  loadBugApp(context,{source});
  return {node,context,calls};
}

for(const [name,source] of [['現行の1行import',original],['複数行・二重引用符のimport',multiline],['空行・字下げ・CRLFのimport','\r\n'+multiline.replace(/^import/gm,'  import').replace(/\r?\n/g,'\r\n')]]) {
  test(name+'でも実際の一覧を描き、自動起動のAPIを呼ばない',()=>{
    const fx=fixture(source);
    const item={id:'qa',title:'架空の一覧',status:'received',kind:'bug',createdAt:'2030-01-01T00:00:00Z',attachmentCount:0,github:{state:'pending',tags:{labels:[]}}};
    fx.context.__reports=[item];
    vm.runInContext('actor={role:"admin",github:{enabled:false}};reports=__reports;renderFilters();renderList();',fx.context);
    assert.equal(fx.node('#report-count').textContent,'1 / 1件');
    assert.equal(fx.node('#reports').children[0].querySelector('.report-title').textContent,item.title);
    assert.deepEqual(fx.calls,[]);
  });
}

test('対応していないimportや失われた起動境界は、読み込み時に失敗する',()=>{
  assert.throws(()=>fixture(original.replace(/^import[^\n]+/,"import view from './view.mjs';")),/App named imports/);
  assert.throws(()=>fixture(original.replace('\ntry { showActor','\ntry { changedBootstrap')),/App bootstrap boundary/);
  assert.throws(()=>fixture(original+'\ntry { showActor'),/App bootstrap boundary/);
});

test('擬似DOMとフォーカスはfixtureごとに分かれ、詳細を描き直すと古い要素を返さない',()=>{
  const first=createBugDom(),second=createBugDom();
  const old=first.document.createElement('input');old.id='input';
  first.node('#detail').append(old);old.focus();
  assert.equal(first.document.activeElement,old);assert.equal(second.document.activeElement,null);
  const next=first.document.createElement('input');next.id='input';
  first.node('#detail').replaceChildren(next);
  assert.equal(first.node('#input'),next);assert.notEqual(second.node('#input'),next);
  next.focus();assert.equal(first.document.activeElement,next);
});

test('フォームの名前・選択状態とイベントを、共通の擬似DOMで検査できる',()=>{
  const {document}=createBugDom(),form=document.createElement('form'),group=document.createElement('label'),input=document.createElement('input');
  input.name='category';group.append(input);form.append(group);
  assert.equal(form.elements.category,input);assert.deepEqual([...form.elements],[input]);
  assert.deepEqual(form.querySelectorAll('input:checked'),[]);
  input.checked=true;assert.deepEqual(form.querySelectorAll('input:checked'),[input]);
  let value;input.addEventListener('change',event=>{value=event.value;});input.fire('change',{value:'changed'});assert.equal(value,'changed');
  input.className='choice';input.classList.add('selected');assert.equal(form.querySelector('.selected'),input);
  input.classList.toggle('selected');assert.equal(form.querySelector('.selected'),null);
  assert.throws(()=>form.querySelectorAll('unsupported'),/Unsupported test selector/);
});
