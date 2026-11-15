import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TestStore } from '../server/test-store.mjs';
import { caseValues } from '../dist/testing/case-editor.mjs';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'test-cases-')), stores = [];
  const open = () => { const store = new TestStore(dir, { timeout: 10 }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { dir, open, store: open() };
}
const values = id => ({ ...caseValues(), id, title: '予約の確認', steps: '予約を開く', expected: '2件ある', status: 'Draft', category: '予約' });
const create = store => store.save({ values: values(store.newCase().id), revision: null, requestId: 'create' });

test('SQLite retains every field, lifecycle and ID allocation across reopen', t => {
  const { store, open } = fixture(t), first = create(store);
  const updated = { ...caseValues(first), purpose:'目的',preconditions:'前提',cleanup:'削除',priority:'High',type:'Manual',reference:'仕様1',notes:'備考',status:'Deprecated',category:' 決済 ' };
  const saved = store.save({ values: updated, revision: 1, requestId:'edit' });
  store.close(); const reopened = open();
  assert.deepEqual(reopened.load(), { cases:[{...saved,category:'決済'}], categories:['決済'] });
  assert.equal(reopened.newCase().id, 'TC-2');
});
test('two connections detect stale writes and reserve unique IDs', t => {
  const { store, open } = fixture(t), first = create(store), other = open();
  assert.notEqual(store.newCase().id, other.newCase().id);
  const fresh = store.save({values:{...caseValues(first),status:'Active'},revision:1,requestId:'a'});
  assert.throws(() => other.save({values:{...caseValues(first),expected:'old'},revision:1,requestId:'b'}), e => e.status === 409 && e.current.status === 'Active');
  assert.deepEqual(other.load().cases,[fresh]);
});
test('receipt persists, replay does not repeat a write or roll back a later update', t => {
  const { store, open } = fixture(t), initial = values(store.newCase().id), input = {values:initial,revision:null,requestId:'once'};
  const first = store.save(input); store.save({values:{...initial,status:'Active'},revision:1,requestId:'twice'});
  store.close(); const other = open();
  assert.deepEqual(other.save(input),first);
  assert.equal(other.load().cases[0].revision,2);
  assert.throws(() => other.save({...input,values:{...initial,title:'different'}}), e => e.code === 'request_reused');
});
test('validation rejects malformed requests without changing cases or receipts', t => {
  const { store } = fixture(t), first=create(store), base={values:caseValues(first),revision:1,requestId:'invalid'};
  for (const request of [null,{...base,revision:0},{...base,requestId:''},{...base,values:{...base.values,steps:' '}},{...base,values:{...base.values,status:'Done'}},{...base,values:{...base.values,unknown:'x'}},{...base,values:{...base.values,title:'x'.repeat(501)}},{...base,values:{...base.values,id:'TC-999'}},{...base,values:{...base.values,priority:'unknown'}}]) assert.throws(()=>store.save(request));
  assert.deepEqual(store.load().cases,[first]);
  assert.equal(store.db.prepare('SELECT count(*) n FROM case_receipts').get().n,1);
});
test('failure after case update rolls back both tables and allows the same request to retry', t => {
  const { store }=fixture(t), first=create(store), request={values:{...caseValues(first),title:'更新'},revision:1,requestId:'retry'};
  store.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON case_receipts BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.throws(()=>store.save(request)); assert.deepEqual(store.load().cases,[first]);
  store.db.exec('DROP TRIGGER fail_receipt'); assert.equal(store.save(request).revision,2);
});
test('real SQLite write lock fails safely and saving succeeds after release', t => {
  const {store,open}=fixture(t), first=create(store), other=open(), request={values:{...caseValues(first),title:'retry lock'},revision:1,requestId:'lock'};
  other.db.exec('BEGIN IMMEDIATE');
  try { assert.throws(()=>store.save(request)); assert.deepEqual(store.load().cases,[first]); } finally { other.db.exec('ROLLBACK'); }
  assert.equal(store.save(request).title,'retry lock');
});
test('case edits leave independent stored result content and the bug database untouched', t => {
  const {store,dir}=fixture(t), first=create(store);
  // 結果機能を実装した試験ではない。既存の内容コピーを置いた実DB境界を検証する。
  store.db.exec('CREATE TABLE existing_result_fixture(id INTEGER PRIMARY KEY, content TEXT NOT NULL)');
  const content=JSON.stringify(Object.fromEntries(['title','purpose','preconditions','steps','expected','cleanup'].map(k=>[k,first[k]])));
  store.db.prepare('INSERT INTO existing_result_fixture VALUES(1,?)').run(content);
  const bugPath=path.join(dir,'reports.sqlite'), bug=new DatabaseSync(bugPath); bug.exec("CREATE TABLE reports(id INTEGER PRIMARY KEY,title TEXT); INSERT INTO reports VALUES(1,'existing bug');");bug.close();
  const before=readFileSync(bugPath);
  store.save({values:{...caseValues(first),title:'new title',steps:'new steps'},revision:1,requestId:'edit'});
  assert.equal(store.db.prepare('SELECT content FROM existing_result_fixture').get().content,content);
  assert.deepEqual(readFileSync(bugPath),before);
});
test('unsupported or unidentified database is rejected without migration', t => {
  const dir=mkdtempSync(path.join(tmpdir(),'test-version-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'tests.sqlite'), db=new DatabaseSync(file);db.exec('CREATE TABLE keep(value TEXT); PRAGMA user_version=99');db.close();
  const before=readFileSync(file);assert.throws(()=>new TestStore(dir));assert.deepEqual(readFileSync(file),before);
  const old=new DatabaseSync(file);old.exec('PRAGMA user_version=0');old.close();assert.throws(()=>new TestStore(dir));
});
