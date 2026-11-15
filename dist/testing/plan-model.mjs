export const PLAN_FIELDS = ['id','name','version','build','owner','purpose','start','end','issue','state','conditions','caseIds','assignees'];
export const PLAN_STATES = ['Draft','In Progress','Completed','Archived'];
export const RESULT_STATES = ['Passed','Failed','Blocked','Skipped','Not Applicable','Not Run'];
export const statusNames = {Passed:'合格',Failed:'不合格',Blocked:'保留',Skipped:'スキップ','Not Applicable':'対象外','Not Run':'未実施'};
export const clone = value => structuredClone(value);
export function emptyPlan(id='') { return {id,name:'',version:'',build:'',owner:'',purpose:'',start:'',end:'',issue:'',state:'Draft',conditions:[{id:crypto.randomUUID(),os:'',version:'',model:'なし（共通）'}],caseIds:[],assignees:{}}; }
export function planValues(plan) { return Object.fromEntries(PLAN_FIELDS.map(key=>[key,clone(plan[key])])); }
export function validatePlan(plan,{casesRequired=true}={}) {
  if(!plan.name.trim())return '計画名を入力してください。';
  if(!plan.version.trim())return '対象バージョンを入力してください。';
  if(!plan.conditions.length||plan.conditions.some(e=>!e.os.trim()||!e.version.trim()||!e.model.trim()))return '実施条件のOS・OSバージョン・モデルを入力してください。';
  const keys=plan.conditions.map(e=>[e.os,e.version,e.model].map(s=>s.trim().toLowerCase()).join('\0'));
  if(new Set(keys).size!==keys.length)return '同じ実施条件が重複しています。';
  if(casesRequired&&!plan.caseIds.length)return 'ケースを1件以上選んでください。';
  if(plan.start&&plan.end&&plan.start>plan.end)return '完了日は開始日以降にしてください。';
  return '';
}
export function counts(plan) {
  const values=Object.fromEntries(RESULT_STATES.map(s=>[s,0]));
  for(const row of plan.results)values[row.status]++;
  return {...values,total:plan.results.length,retest:plan.results.filter(r=>r.retest).length};
}
export function recorded(plan,kind,id) { return plan.results.filter(r=>(kind==='case'?r.caseId:r.envId)===id&&r.recordedAt!==null).length; }
export function canDelete(plan) { return plan.state==='Draft'&&plan.results.every(r=>r.recordedAt===null); }
export function completion(plan) { const c=counts(plan);return {blocked:c['Not Run']>0,warning:c.Failed+c.Blocked+c.Skipped+c.retest>0,counts:c}; }
