import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';

// Run the actual form event handlers with an isolated DOM and failure-injecting API.
class Element {
  constructor(tag='div') {this.tag=tag;this.children=[];this.textContent='';this.hidden=false;this.checked=false;this.disabled=false;this.classList={toggle(){}};}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children=[...children];}
  get childElementCount() {return this.children.length;}
  querySelectorAll(selector) {
    return this.children.flatMap(child=>[...(child.tag==='input'&&(!selector.includes(':checked')||child.checked)?[child]:[]),...child.querySelectorAll(selector)]);
  }
  addEventListener() {}
  showModal() {this.open=true;}
  close() {this.open=false;}
}
function formFixture({pending=[],failFile,failReportOnce=false,maxFiles=20}={}) {
  const nodes=new Map();
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);};
  const form=node('#report-form'),files=new Element('input'),body=new Element('textarea'),version=new Element('input');
  files.files=[];body.value='架空の再現報告';version.value='QA';
  form.elements=Object.assign([files,body,version,node('#submit-report')],{files,body,reportedVersion:version});
  form.reset=()=>{files.files=[];body.value=version.value='';};
  const saved=pending.map(file=>({...file})),requests=[],uploads=[];
  let failedUpload=false,failedReport=false;
  const fetch=async(url,options={})=>{
    const route=url.replace('/api/bugs/','');let value,status=200;
    if(route==='uploads'&&options.method==='POST') {
      const file=options.body;uploads.push(file.name);
      if(file.name===failFile&&!failedUpload) {failedUpload=true;status=503;value={error:'架空の送信失敗'};}
      else {const attachment={id:randomUUID(),name:file.name,size:file.size,type:file.type};saved.push(attachment);value={attachment};}
    } else if(route==='uploads') value={attachments:saved.map(file=>({...file}))};
    else if(route==='reports'&&options.method==='POST') {
      const request=JSON.parse(options.body);requests.push(request);
      if(failReportOnce&&!failedReport) {failedReport=true;status=503;value={error:'架空の受付応答失敗'};}
      else value={report:{id:'accepted'}};
    } else throw new Error('Unexpected request: '+route);
    return{ok:status<400,status,json:async()=>value};
  };
  const context=vm.createContext({document:{querySelector:node,createElement:tag=>new Element(tag)},fetch,URL,location:{href:'http://127.0.0.1:4327/bugs/'},crypto:{randomUUID},setTimeout,clearTimeout});
  const source=readFileSync(new URL('../dist/bugs/app.mjs',import.meta.url),'utf8');
  const start=source.indexOf('\n')+1,end=source.lastIndexOf('\ntry { showActor');
  assert.ok(start>0&&end>start,'App import and bootstrap boundaries must exist');
  vm.runInContext(source.slice(start,end),context);
  vm.runInContext('actor={id:"local-shared",role:"admin",shared:true,policy:{maxFiles:'+maxFiles+',maxBytes:1000}};refresh=async()=>{};openReport=async()=>{};notice=()=>{};',context);
  return {
    node,requests,uploads,saved,
    open:()=>node('#new-report').onclick(),
    select(selected){files.files=selected;files.onchange({target:files});},
    submit:()=>form.onsubmit({preventDefault(){},currentTarget:form}),
    savedCheckboxes:()=>node('#pending-files').querySelectorAll('input'),
    text(selector){const all=e=>e.textContent+e.children.map(all).join('');return all(node(selector));}
  };
}
const file=name=>({name,size:3,type:'application/octet-stream'});

for(const includeSaved of [false,true]) test('途中失敗後の保存済み添付を表示し、選択'+(includeSaved?'した分を含める':'を外した分を除く'),async()=>{
  const fx=formFixture({failFile:'second.dat'});await fx.open();
  fx.select([file('first.dat'),file('second.dat')]);await fx.submit();
  assert.match(fx.text('#pending-files'),/first\.dat/);assert.equal(fx.savedCheckboxes().length,1);
  assert.equal(fx.savedCheckboxes()[0].checked,true);
  fx.select([file('replacement.dat')]);assert.match(fx.text('#pending-files'),/first\.dat/);assert.match(fx.text('#selected-files'),/replacement\.dat/);
  fx.savedCheckboxes()[0].checked=includeSaved;const firstId=fx.saved[0].id;
  await fx.submit();assert.equal(fx.requests.length,1);
  assert.equal(fx.requests[0].uploadIds.includes(firstId),includeSaved);
  assert.equal(fx.requests[0].uploadIds.length,includeSaved?2:1);
  assert.deepEqual(fx.uploads,['first.dat','second.dat','replacement.dat']);
});

test('同じファイル選択で再試行しても保存済み添付を再送せず、上限へ二重に数えない',async()=>{
  const fx=formFixture({failFile:'second.dat',maxFiles:2});await fx.open();
  fx.select([file('first.dat'),file('second.dat')]);await fx.submit();await fx.submit();
  assert.equal(fx.requests.length,1);assert.equal(fx.requests[0].uploadIds.length,2);
  assert.deepEqual(fx.uploads,['first.dat','second.dat','second.dat']);
});

test('受付応答の失敗後も、同じ受付キーと添付の順序で再送する',async()=>{
  const fx=formFixture({pending:[{id:'previous',name:'previous.dat',size:3}],failReportOnce:true});await fx.open();
  fx.savedCheckboxes()[0].checked=true;fx.select([file('new.dat')]);await fx.submit();
  assert.equal(fx.savedCheckboxes().length,2);assert.match(fx.text('#pending-files'),/new\.dat/);
  await fx.submit();assert.deepEqual(fx.requests[1],fx.requests[0]);assert.deepEqual(fx.uploads,['new.dat']);
});

test('フォームを開き直しても保存済み添付の選択を維持し、未選択の添付を付けない',async()=>{
  const fx=formFixture({pending:[{id:'previous',name:'previous.dat',size:3}],failFile:'second.dat'});await fx.open();
  fx.select([file('first.dat'),file('second.dat')]);await fx.submit();
  const first=fx.saved.find(item=>item.name==='first.dat');
  fx.savedCheckboxes().find(input=>input.value===first.id).checked=false;
  fx.node('#report-dialog').close();await fx.open();
  assert.equal(fx.savedCheckboxes().length,2);assert.ok(fx.savedCheckboxes().every(input=>!input.checked));
  fx.select([]);await fx.submit();assert.deepEqual(fx.requests[0].uploadIds,[]);
});
