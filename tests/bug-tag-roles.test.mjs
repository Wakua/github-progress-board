import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {BugStore,BugError,tagRoleNames} from '../server/bug-store.mjs';
import {createProgressServer} from '../server.mjs';
import {dialogOrder,rolesToSave,roleNames,mountTagRoles} from '../dist/bugs/tag-roles.mjs';

// 架空の予約管理アプリのタグ。idはGitHubのタグのid、名前は変えられる。
const booking={id:11,name:'予約',color:'336699'},list={id:12,name:'一覧',color:'993366'},notice={id:13,name:'通知',color:'339966'},bug={id:14,name:'bug',color:'cc0000'};
const cleanup=dir=>{const relative=path.relative(tmpdir(),dir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));rmSync(dir,{recursive:true,force:true});};
function fixture(t) {
  const dir=mkdtempSync(path.join(tmpdir(),'progress-bug-tags-'));
  let store=new BugStore(dir,{initialize:true});const actor=store.sharedActor();
  let count=0;
  const report=(labels,{state='ok',at='2026-10-01T00:00:00.000Z'}={})=>{
    const created=store.createReport(actor,{body:'架空の報告 '+(++count),reportedVersion:'',requestId:'request-'+count,uploadIds:[]});
    if(labels)store.db.prepare('UPDATE registration_queue SET labels=?,label_state=?,labels_at=? WHERE report_id=?').run(JSON.stringify(labels),state,at,created.id);
    return created.id;
  };
  const fetched=(id,labels,at)=>store.db.prepare("UPDATE registration_queue SET labels=?,label_state='ok',labels_at=? WHERE report_id=?").run(JSON.stringify(labels),at,id);
  t.after(()=>{store?.close();cleanup(dir);});
  return{dir,actor,report,fetched,get store(){return store;},reopen(){store.close();store=new BugStore(dir);return store;},release(){store.close();store=null;}};
}
const names=result=>result.tags.map(tag=>tag.name);
const sortedNames=values=>[...values].sort((a,b)=>a.localeCompare(b,'ja'));

test('the tag list comes from fetched reports, and tags without a saved role are new',t=>{
  const fx=fixture(t);
  assert.deepEqual(fx.store.tagRoles(),{tags:[],newCount:0});
  fx.report([booking,list]);
  fx.report([booking,notice],{state:'error'});
  fx.report(null);
  const result=fx.store.tagRoles();
  assert.deepEqual(names(result),sortedNames(['予約','一覧','通知']));
  assert.deepEqual(result.tags.map(tag=>tag.role),[null,null,null]);
  assert.equal(result.newCount,3);
  assert.deepEqual(result.tags.find(tag=>tag.id===12),{id:12,name:'一覧',color:'993366',role:null});
});

test('assigning a role, including "none", settles the tag and survives a restart',t=>{
  const fx=fixture(t);fx.report([booking,list,bug]);
  const saved=fx.store.setTagRoles(fx.actor,{roles:[{id:11,role:'main'},{id:12,role:'sub'}]});
  assert.equal(saved.newCount,1);
  assert.equal(saved.tags.find(tag=>tag.id===11).role,'main');
  assert.equal(saved.tags.find(tag=>tag.id===14).role,null);
  assert.equal(fx.store.setTagRoles(fx.actor,{roles:[{id:14,role:'none'}]}).newCount,0);
  assert.equal(fx.store.tagRoles().tags.find(tag=>tag.id===14).role,'none');
  assert.equal(fx.store.setTagRoles(fx.actor,{roles:[{id:11,role:'sub'}]}).tags.find(tag=>tag.id===11).role,'sub');
  const reopened=fx.reopen();
  assert.deepEqual(reopened.tagRoles().tags.map(tag=>[tag.id,tag.role]).sort((a,b)=>a[0]-b[0]),[[11,'sub'],[12,'sub'],[14,'none']]);
  assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,8);
});

test('a tag added on GitHub is new while earlier assignments stay',t=>{
  const fx=fixture(t);const id=fx.report([booking,list]);
  fx.store.setTagRoles(fx.actor,{roles:[{id:11,role:'main'},{id:12,role:'none'}]});
  assert.equal(fx.store.tagRoles().newCount,0);
  fx.fetched(id,[booking,list,notice],'2026-10-02T00:00:00.000Z');
  const result=fx.store.tagRoles();
  assert.equal(result.newCount,1);
  assert.equal(result.tags.find(tag=>tag.id===13).role,null);
  assert.equal(result.tags.find(tag=>tag.id===11).role,'main');
});

test('the role belongs to the tag id, so renaming a tag on GitHub keeps it and the latest fetch names it',t=>{
  const fx=fixture(t);const older=fx.report([booking],{at:'2026-10-01T00:00:00.000Z'}),newer=fx.report([booking],{at:'2026-10-01T00:00:00.000Z'});
  fx.store.setTagRoles(fx.actor,{roles:[{id:11,role:'main'}]});
  fx.fetched(newer,[{...booking,name:'予約画面'}],'2026-10-05T00:00:00.000Z');
  const result=fx.store.tagRoles();
  assert.deepEqual(result.tags.map(tag=>[tag.id,tag.name,tag.role]),[[11,'予約画面','main']]);
  assert.equal(result.newCount,0);
  fx.fetched(older,[booking],'2026-10-09T00:00:00.000Z');
  assert.equal(fx.store.tagRoles().tags[0].name,'予約');
});

test('a tag that no fetched report carries is not listed, and its saved role returns when it comes back',t=>{
  const fx=fixture(t);const id=fx.report([booking,list]);
  fx.store.setTagRoles(fx.actor,{roles:[{id:11,role:'main'},{id:12,role:'sub'}]});
  fx.fetched(id,[booking],'2026-10-02T00:00:00.000Z');
  assert.deepEqual(names(fx.store.tagRoles()),['予約']);
  fx.fetched(id,[booking,list],'2026-10-03T00:00:00.000Z');
  assert.equal(fx.store.tagRoles().tags.find(tag=>tag.id===12).role,'sub');
});

test('invalid requests are rejected and save no part of the request',t=>{
  const fx=fixture(t);fx.report([booking,list]);
  const invalid=[undefined,null,{},{roles:'main'},{roles:[]},{roles:[{id:11,role:'owner'}]},{roles:[{id:11}]},{roles:[{id:'11',role:'main'}]},{roles:[{id:0,role:'main'}]},{roles:[{id:1.5,role:'main'}]},
    {roles:[null]},{roles:[{id:11,role:'main'},{id:11,role:'sub'}]},{roles:[{id:12,role:'sub'},{id:13,role:'bogus'}]},{roles:Array.from({length:1001},(_,index)=>({id:index+1,role:'none'}))}];
  for(const input of invalid)assert.throws(()=>fx.store.setTagRoles(fx.actor,input),error=>error instanceof BugError&&error.status===400,JSON.stringify(input)?.slice(0,80));
  assert.equal(fx.store.db.prepare('SELECT count(*) AS n FROM tag_roles').get().n,0);
  assert.deepEqual(tagRoleNames,['none','main','sub']);
});

test('schema v4 data migrates to the current version with its reports and tags intact',t=>{
  const fx=fixture(t);const id=fx.report([booking]);
  fx.store.db.exec('ALTER TABLE reports DROP COLUMN decision; ALTER TABLE reports DROP COLUMN decision_note; ALTER TABLE reports DROP COLUMN decided_at; ALTER TABLE reports DROP COLUMN kind; DROP TABLE report_categories; ALTER TABLE registration_queue DROP COLUMN category_miss; DROP TABLE tag_roles; PRAGMA user_version=4;');
  const reopened=fx.reopen();
  assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,8);
  assert.equal(reopened.getReport(fx.actor,id).body,'架空の報告 1');
  assert.equal(reopened.tagRoles().newCount,1);
  assert.equal(reopened.setTagRoles(fx.actor,{roles:[{id:11,role:'main'}]}).newCount,0);
});

test('saving roles changes neither the report nor the registration, and does not touch GitHub',async t=>{
  const fx=fixture(t);const id=fx.report([booking,list]);fx.release();
  const calls=[];const record=name=>async()=>{calls.push(name);throw new Error('GitHubを呼んではいけません。');};
  const client={repository:'qa-fixture/booking-reports',createIssue:record('create'),getIssue:record('get'),findIssues:record('find'),request:record('request')};
  const server=createProgressServer({dataDir:fx.dir,githubClient:client});server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const base='http://127.0.0.1:'+server.address().port+'/api/bugs/';
    const post=body=>fetch(base+'tag-roles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const before=await (await fetch(base+'reports/'+id)).json();

    const read=await fetch(base+'tag-roles');
    assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');
    assert.deepEqual((await read.json()).newCount,2);
    const save=await post({roles:[{id:11,role:'main'},{id:12,role:'none'}]});
    assert.equal(save.status,200);
    const saved=await save.json();assert.equal(saved.newCount,0);assert.deepEqual(saved.tags.map(tag=>tag.role).sort(),['main','none']);
    assert.deepEqual(await (await fetch(base+'tag-roles')).json(),saved);

    const after=await (await fetch(base+'reports/'+id)).json();
    assert.deepEqual(after,before);
    assert.deepEqual(calls,[]);
    assert.equal(server.bugStore.db.prepare('SELECT count(*) AS n FROM report_events').get().n,0);
  } finally {await server.bugWorker.stop();await new Promise(resolve=>server.close(resolve));await server.bugClosed;}
});

test('the tag role API accepts only a JSON body from this page and no query string',async t=>{
  const fx=fixture(t);fx.report([booking]);fx.release();
  const server=createProgressServer({dataDir:fx.dir});server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const base='http://127.0.0.1:'+server.address().port+'/api/bugs/tag-roles';
    const json={'Content-Type':'application/json'},body=JSON.stringify({roles:[{id:11,role:'main'}]});
    assert.equal((await fetch(base,{method:'POST',headers:{'Content-Type':'text/plain'},body})).status,415);
    assert.equal((await fetch(base,{method:'POST',headers:json,body:'{'})).status,400);
    assert.equal((await fetch(base,{method:'POST',headers:json,body:'[]'})).status,400);
    assert.equal((await fetch(base,{method:'POST',headers:json,body:JSON.stringify({roles:[{id:11,role:'owner'}]})})).status,400);
    assert.equal((await fetch(base,{method:'POST',headers:{...json,Origin:'http://evil.example'},body})).status,403);
    assert.equal((await fetch(base+'?roles=1',{method:'POST',headers:json,body})).status,403);
    assert.equal((await fetch(base,{method:'PUT',headers:json,body})).status,405);
    assert.equal((await fetch(base,{method:'DELETE'})).status,405);
    assert.equal((await (await fetch(base)).json()).newCount,1);
  } finally {await new Promise(resolve=>server.close(resolve));await server.bugClosed;}
});

test('the settings dialog lists new tags first and saves only the new and the changed tags',()=>{
  const tags=[{...booking,role:'main'},{...list,role:null},{...notice,role:'sub'},{...bug,role:'none'}];
  assert.deepEqual(dialogOrder(tags).map(tag=>tag.id),[12,11,13,14]);
  assert.deepEqual(roleNames,{none:'使わない',main:'メイン',sub:'サブ'});
  // 何も触らなければ、新しいタグだけが「使わない」で確定する。
  assert.deepEqual(rolesToSave(tags,new Map([[11,'main'],[12,'none'],[13,'sub'],[14,'none']])),[{id:12,role:'none'}]);
  assert.deepEqual(rolesToSave(tags,new Map([[11,'sub'],[12,'main'],[13,'sub'],[14,'none']])),[{id:11,role:'sub'},{id:12,role:'main'}]);
  assert.deepEqual(rolesToSave(tags,new Map()),[{id:12,role:'none'}]);
  assert.deepEqual(rolesToSave([{...booking,role:'main'}],new Map([[11,'main']])),[]);
});

// 設定画面の操作を、疑似のDOMとAPIで動かす。
class Node {
  constructor(tag) {this.tag=tag;this.children=[];this.textContent='';this.hidden=false;this.disabled=false;this.checked=false;this.dataset={};this.style={setProperty(){}};}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children=[...children];}
  setAttribute() {}
  querySelectorAll() {const found=[],walk=node=>{for(const child of node.children){if(child.tag==='input'&&child.checked)found.push(child);walk(child);}};walk(this);return found;}
  showModal() {this.open=true;}
  close() {this.open=false;}
}
function dialogFixture(tags,{api:custom}={}) {
  const nodes=new Map(),posts=[],notices=[];
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,new Node('div'));return nodes.get(selector);};
  const state=()=>({tags:tags.map(tag=>({...tag})),newCount:tags.filter(tag=>tag.role===null).length});
  const api=custom||(async(route,options)=>{
    if(options) {const input=JSON.parse(options.body);posts.push(input);for(const item of input.roles)tags.find(tag=>tag.id===item.id).role=item.role;}
    return state();
  });
  const element=(tag,text,className)=>{const created=new Node(tag);if(text!==undefined)created.textContent=text;created.className=className;return created;};
  globalThis.document={querySelector:node};
  const ui=mountTagRoles({api,json:value=>({method:'POST',body:JSON.stringify(value)}),element,notice:(message,failed)=>notices.push([message,failed])});
  return{node,posts,notices,ui,rows:()=>node('#category-tags').children.length,
    add:tag=>tags.push({...tag,role:null}),
    save:()=>node('#category-form').onsubmit({preventDefault(){}})};
}
test('a tag that appears while the dialog is open is not saved, because the person never saw it',async()=>{
  const fx=dialogFixture([{...booking,role:null}]);
  try {
    await fx.node('#category-settings').onclick();
    assert.equal(fx.rows(),1);assert.equal(fx.node('#new-tags').textContent,'新しいタグ 1');
    fx.add(notice);await fx.ui.load();
    assert.equal(fx.node('#new-tags').textContent,'新しいタグ 2');assert.equal(fx.rows(),1);
    await fx.save();
    assert.deepEqual(fx.posts,[{roles:[{id:11,role:'none'}]}]);
    assert.equal(fx.node('#new-tags').textContent,'新しいタグ 1');assert.equal(fx.node('#new-tags').hidden,false);
  } finally {delete globalThis.document;}
});

test('opening the dialog again lists the tag that appeared meanwhile and saving settles it',async()=>{
  const fx=dialogFixture([{...booking,role:'main'}]);
  try {
    await fx.node('#category-settings').onclick();await fx.save();
    assert.deepEqual(fx.posts,[]);assert.equal(fx.node('#category-dialog').open,false);
    fx.add(notice);
    await fx.node('#category-settings').onclick();assert.equal(fx.rows(),2);
    await fx.save();
    assert.deepEqual(fx.posts,[{roles:[{id:13,role:'none'}]}]);assert.equal(fx.node('#new-tags').hidden,true);
    assert.deepEqual(fx.notices,[['カテゴリの設定を保存しました。',undefined]]);
  } finally {delete globalThis.document;}
});

test('保存の前に始めた読み込みの応答が、保存のあとに届いても、保存した割り当てを上書きしない',async()=>{
  const stale={tags:[{...booking,role:null}],newCount:1},saved={tags:[{...booking,role:'main'}],newCount:0};
  let release,loads=0;const held=new Promise(resolve=>{release=resolve;});
  const api=async(route,options)=>{
    if(options)return saved;
    return ++loads===1?stale:held.then(()=>stale);
  };
  const fx=dialogFixture([],{api});
  try {
    await fx.node('#category-settings').onclick();
    const late=fx.ui.load();
    await fx.save();
    assert.equal(fx.ui.tags()[0].role,'main');assert.equal(fx.node('#new-tags').hidden,true);
    release();await late;
    assert.equal(fx.ui.tags()[0].role,'main');assert.equal(fx.node('#new-tags').hidden,true);
  } finally {delete globalThis.document;}
});
