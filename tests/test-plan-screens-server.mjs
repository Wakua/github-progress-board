import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProgressServer} from '../server.mjs';
import {TestStore} from '../server/test-store.mjs';
import {seedCase,proposal,save,recordFixture} from './support/test-plan-fixture.mjs';
const dir=process.env.TEST_PLAN_FIXTURE_DIR;
if(!dir)throw new Error('Set TEST_PLAN_FIXTURE_DIR to an isolated folder outside dist');
const store=new TestStore(path.join(dir,'testing'));
if(!store.load().cases.length){
 const cases=[seedCase(store,'予約を作成する'),seedCase(store,'予約を変更する'),seedCase(store,'予約をキャンセルする'),seedCase(store,'カード決済を確認する','決済'),seedCase(store,'予約通知を確認する','通知'),seedCase(store,'古い予約画面','予約','Deprecated'),seedCase(store,'入力中のケース','予約','Draft')];
 const conditions=[{id:'windows',os:'Windows',version:'11',model:'なし（共通）'},{id:'ios',os:'iOS',version:'18',model:'iPhone'}];
 save(store,{...proposal(store,cases.slice(0,2),conditions),name:'削除確認用の下書き'});
 const mixed=save(store,{...proposal(store,[cases[0],cases[3]],conditions),name:'記録済み対象の保護',state:'Draft'});
 store.db.prepare("UPDATE plan_units SET status=?,performed_by='架空の担当者',performed_at='2026-11-15T00:00:00Z',recorded_at='2026-11-15T00:00:00Z' WHERE plan_id=? AND case_id=? AND condition_id=?").run('Failed',Number(mixed.id.slice(3)),1,'windows');
 const warning=save(store,{...proposal(store,cases.slice(0,5),[conditions[0]]),name:'完了と再開の確認'});recordFixture(store,warning,['Passed','Failed','Blocked','Skipped','Not Applicable']);
}
store.close();
const root=fileURLToPath(new URL('../dist',import.meta.url));
const server=createProgressServer({root,repositories:[],testDataDir:path.join(dir,'testing'),dataDir:path.join(dir,'bugs')});
const port=Number(process.env.PORT||4499);server.listen(port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${port}/testing/plans.html`));
