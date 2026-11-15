import {emptyPlan,planValues} from '../../dist/testing/plan-model.mjs';
import {caseValues} from '../../dist/testing/case-editor.mjs';
import {randomUUID} from 'node:crypto';
export function seedCase(store,title='予約を確認',category='予約',status='Active') {
 return store.save({values:{...caseValues(),id:store.newCase().id,title,category,status,steps:'一覧を開く',expected:'登録した内容が見える'},revision:null,requestId:randomUUID()});
}
export function proposal(store,cases,conditions=[{id:'windows',os:'Windows',version:'11',model:'なし（共通）'}]) {
 return {...emptyPlan(store.newPlan().id),name:'予約アプリの確認',version:'1.4.0',conditions,caseIds:cases.map(c=>c.id)};
}
export function save(store,plan,options={}) { return store.savePlan({action:'save',acknowledgeWarnings:false,revision:plan.revision??null,values:planValues(plan),requestId:randomUUID(),...options}); }
// #172の結果入力機能ではない。保存済み結果を持つDB境界を検証するための架空記録。
export function recordFixture(store,plan,statuses=['Passed']) {
 const update=store.db.prepare('UPDATE plan_units SET status=?,retest_required=?,performed_by=?,performed_at=?,recorded_at=? WHERE plan_id=? AND case_id=? AND condition_id=?');
 for(const [i,row] of plan.results.entries())update.run(statuses[i%statuses.length],i===0?1:0,'架空の担当者','2026-11-15T00:00:00Z','2026-11-15T00:00:00Z',Number(plan.id.slice(3)),Number(row.caseId.slice(3)),row.envId);
 return store.loadPlans().plans.find(p=>p.id===plan.id);
}
