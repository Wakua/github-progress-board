import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// 画面テストが使うDOM操作だけを模擬する。レイアウトやブラウザの既定動作は検証しない。
export class Element {
  constructor(tag='div',ownerDocument=null) {
    Object.assign(this,{tag,ownerDocument,children:[],textContent:'',hidden:false,disabled:false,checked:false,open:false,focused:false,value:'',className:'',id:'',name:'',dataset:{},listeners:{},attributes:{}});
    this.style={setProperty(){}};
    const classes=()=>new Set(this.className.split(/\s+/).filter(Boolean));
    const change=(name,on)=>{const names=classes();if(on)names.add(name);else names.delete(name);this.className=[...names].join(' ');return on;};
    this.classList={contains:name=>classes().has(name),add:name=>change(name,true),remove:name=>change(name,false),toggle:(name,force)=>change(name,force??!classes().has(name))};
  }
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children=[...children];}
  insertBefore(node,reference) {const index=this.children.indexOf(reference);if(index<0)this.children.push(node);else this.children.splice(index,0,node);}
  get options() {return this.children;}
  get childElementCount() {return this.children.length;}
  *walk() {for(const child of this.children){yield child;yield* child.walk();}}
  descendants() {return [...this.walk()];}
  contains(node) {return node===this||this.descendants().includes(node);}
  querySelectorAll(selector) {
    const match=selector.startsWith('#')?node=>node.id===selector.slice(1)
      :selector.startsWith('.')?node=>node.classList.contains(selector.slice(1))
      :selector==='input'||selector==='input:checked'?node=>node.tag==='input'&&(selector==='input'||node.checked)
      :selector==='button,input'?node=>['button','input'].includes(node.tag)
      :null;
    assert.ok(match,'Unsupported test selector: '+selector);
    return this.descendants().filter(match);
  }
  querySelector(selector) {return this.querySelectorAll(selector)[0]??null;}
  // 入力欄を順番どおりの配列と、名前での参照の両方で返す。受付フォームは個別に差し替える。
  get elements() {
    if(this.formElements!==undefined)return this.formElements;
    const found=this.descendants().filter(child=>['input','textarea','select','button'].includes(child.tag));
    return Object.assign(found,Object.fromEntries(found.filter(child=>child.name).map(child=>[child.name,child])));
  }
  set elements(value) {this.formElements=value;}
  setAttribute(name,value) {this.attributes[name]=String(value);}
  addEventListener(type,listener) {(this.listeners[type]||=[]).push(listener);}
  fire(type,event={}) {for(const listener of this.listeners[type]||[])listener(event);}
  click() {this.fire('click');return this.onclick?.();}
  focus() {this.focused=true;if(this.ownerDocument)this.ownerDocument.activeElement=this;}
  scrollIntoView(options) {this.scrolled=options;}
  showModal() {this.open=true;}
  close() {this.open=false;}
}

export function createBugDom() {
  const nodes=new Map();
  // 固定の画面要素は初回参照時に作る。詳細内の要素は毎回、現在の木から探す。
  const node=selector=>{
    if(!nodes.has(selector)) {
      const found=selector.startsWith('#')?nodes.get('#detail')?.querySelector(selector):null;
      if(found)return found;
      nodes.set(selector,new Element('div',document));
    }
    return nodes.get(selector);
  };
  const document={activeElement:null,querySelector:node,createElement:tag=>new Element(tag,document)};
  return {node,document};
}

// appの名前付きimportを外し、末尾の自動起動より前を実行する。
// importした関数・DOM・API・タイマーは、各テストがcontextに渡す。
// 新しい構文や起動境界に変わった場合は、黙って省略せず、ここで失敗させる。
export function loadBugApp(context,{source=readFileSync(new URL('../../dist/bugs/app.mjs',import.meta.url),'utf8')}={}) {
  const imports=/^\s*import\s*\{[^}]+\}\s*from\s*(['"])[^'"\r\n]+\1\s*;[ \t]*(?:\r?\n|$)/;
  let app=source,count=0;
  while(imports.test(app)){app=app.replace(imports,'');count++;}
  assert.ok(count>0&&!/^\s*import\b/.test(app),'App named imports must exist; update tests/support/bug-ui.mjs for a new import syntax');
  const boundary='\ntry { showActor',end=app.lastIndexOf(boundary);
  assert.ok(end>0&&app.indexOf(boundary)===end,'App bootstrap boundary must exist exactly once');
  vm.runInContext(app.slice(0,end),context,{filename:'dist/bugs/app.mjs'});
}
