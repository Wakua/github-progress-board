import { createHash } from 'node:crypto';
import { TestStoreError } from './test-errors.mjs';
import { PLAN_FIELDS,PLAN_STATES,validatePlan,counts } from '../dist/testing/plan-model.mjs';
const fail=(code='invalid_plan',status=400,current)=>{throw new TestStoreError(status,code,current);};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=500)=>typeof v==='string'&&v.length<=max&&!v.includes('\0');
const token=v=>text(v,80)&&/^[A-Za-z0-9_-]+$/.test(v);
const number=id=>Number(id.slice(3));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createPlanSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS plan_ids(id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE IF NOT EXISTS test_plans(
      id INTEGER PRIMARY KEY REFERENCES plan_ids(id), values_json TEXT NOT NULL CHECK(json_valid(values_json)),
      revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE IF NOT EXISTS plan_units(
      plan_id INTEGER NOT NULL REFERENCES test_plans(id), case_id INTEGER NOT NULL REFERENCES cases(id), condition_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Not Run' CHECK(status IN ('Not Run','Passed','Failed','Blocked','Skipped','Not Applicable')),
      retest_required INTEGER NOT NULL DEFAULT 0 CHECK(retest_required IN (0,1)),
      performed_by TEXT, performed_at TEXT, recorded_at TEXT,
      PRIMARY KEY(plan_id,case_id,condition_id),
      CHECK((status='Not Run' AND performed_by IS NULL AND performed_at IS NULL AND recorded_at IS NULL AND retest_required=0)
        OR (status<>'Not Run' AND performed_by IS NOT NULL AND length(trim(performed_by))>0 AND performed_at IS NOT NULL AND recorded_at IS NOT NULL)));
    CREATE TABLE IF NOT EXISTS plan_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL REFERENCES test_plans(id),
      at TEXT NOT NULL, event TEXT NOT NULL, before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
      after_json TEXT CHECK(after_json IS NULL OR json_valid(after_json)));
    CREATE INDEX IF NOT EXISTS plan_history_plan ON plan_history(plan_id,id);
    CREATE TABLE IF NOT EXISTS plan_receipts(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response_json TEXT NOT NULL CHECK(json_valid(response_json)));`);
}
function values(input) {
  if(!object(input)||Object.keys(input).length!==PLAN_FIELDS.length||Object.keys(input).some(k=>!PLAN_FIELDS.includes(k)))fail();
  for(const key of ['id','name','version','build','owner','purpose','start','end','issue','state'])if(!text(input[key],key==='purpose'?20000:key==='issue'?2000:500))fail();
  if(!/^TP-[1-9]\d{0,9}$/.test(input.id)||!PLAN_STATES.includes(input.state))fail();
  for(const key of ['start','end'])if(input[key]){
    const date=new Date(input[key]);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input[key])||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==input[key])fail();
  }
  if(!Array.isArray(input.conditions)||input.conditions.length<1||input.conditions.length>20)fail();
  for(const e of input.conditions)if(!object(e)||Object.keys(e).sort().join()!=='id,model,os,version'||!token(e.id)||!['os','version','model'].every(k=>text(e[k],200)))fail();
  if(new Set(input.conditions.map(e=>e.id)).size!==input.conditions.length)fail();
  if(!Array.isArray(input.caseIds)||input.caseIds.length<1||input.caseIds.length>500||input.caseIds.some(id=>typeof id!=='string'||!/^TC-[1-9]\d{0,9}$/.test(id))||new Set(input.caseIds).size!==input.caseIds.length)fail();
  if(!object(input.assignees)||Object.entries(input.assignees).some(([id,v])=>!input.caseIds.includes(id)||!text(v,200)))fail();
  const next=Object.fromEntries(PLAN_FIELDS.map(k=>[k,structuredClone(input[k])]));
  for(const key of ['name','version','build','owner','issue'])next[key]=next[key].trim();
  next.conditions=next.conditions.map(e=>({id:e.id,os:e.os.trim(),version:e.version.trim(),model:e.model.trim()}));
  next.assignees=Object.fromEntries(Object.entries(next.assignees).sort().map(([id,v])=>[id,v.trim()]));
  if(validatePlan(next))fail();return next;
}
function packet(input) {
  if(!object(input)||Object.keys(input).sort().join()!=='acknowledgeWarnings,action,requestId,revision,values'||!['save','delete'].includes(input.action)||typeof input.acknowledgeWarnings!=='boolean'||!token(input.requestId))fail();
  if(input.revision!==null&&(!Number.isSafeInteger(input.revision)||input.revision<1))fail();
  return {...input,values:values(input.values)};
}
export function loadPlan(db,id,{includeDeleted=false}={}) {
  const row=db.prepare('SELECT * FROM test_plans WHERE id=?').get(id);
  if(!row||row.deleted_at&&!includeDeleted)return null;
  const plan={...JSON.parse(row.values_json),revision:row.revision};
  plan.results=db.prepare('SELECT * FROM plan_units WHERE plan_id=? ORDER BY case_id,condition_id').all(id).map(r=>({caseId:`TC-${r.case_id}`,envId:r.condition_id,status:r.status,retest:!!r.retest_required,performer:r.performed_by,date:r.performed_at,recordedAt:r.recorded_at}));
  plan.history=db.prepare('SELECT id,at,event,before_json,after_json FROM plan_history WHERE plan_id=? ORDER BY id DESC').all(id).map(r=>({id:r.id,at:r.at,text:r.event,before:r.before_json?JSON.parse(r.before_json):null,after:r.after_json?JSON.parse(r.after_json):null}));
  return plan;
}
export function loadPlans(db) {
  db.exec('BEGIN');
  try { const result={plans:db.prepare('SELECT id FROM test_plans WHERE deleted_at IS NULL ORDER BY id DESC').all().map(r=>loadPlan(db,r.id))};db.exec('COMMIT');return result; }
  catch(error){db.exec('ROLLBACK');throw error;}
}
export function newPlan(db) { return {id:`TP-${db.prepare('INSERT INTO plan_ids DEFAULT VALUES').run().lastInsertRowid}`}; }
function events(before,next) {
  if(!before)return ['計画を作成',`ケースを追加：${next.caseIds.join('、')}`,`実施条件を設定：${next.conditions.map(e=>`${e.os} ${e.version} / ${e.model}`).join('、')}`];
  const out=[],added=next.caseIds.filter(id=>!before.caseIds.includes(id)),removed=before.caseIds.filter(id=>!next.caseIds.includes(id));
  if(added.length)out.push(`ケースを追加：${added.join('、')}`);
  if(removed.length)out.push(`ケースを除外：${removed.join('、')}`);
  if(!same(before.conditions,next.conditions))out.push('実施条件を変更');
  if(before.version!==next.version)out.push(`対象バージョンを変更：${before.version} → ${next.version}`);
  if(before.state!==next.state)out.push(next.state==='Completed'?'計画を完了':['Completed','Archived'].includes(before.state)&&next.state==='In Progress'?'計画を再開':`状態を変更：${before.state} → ${next.state}`);
  if(!same(before.assignees,next.assignees))out.push('計画内の担当者を変更');
  if(['name','build','owner','purpose','start','end','issue'].some(k=>before[k]!==next[k]))out.push('計画の項目を変更');
  return out.length?out:['計画を保存'];
}
export function savePlan(db,input) {
  const p=packet(input),v=p.values,id=number(v.id);
  const fingerprint=createHash('sha256').update(JSON.stringify([p.action,v,p.revision,p.acknowledgeWarnings])).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    const receipt=db.prepare('SELECT * FROM plan_receipts WHERE request_id=?').get(p.requestId);
    if(receipt){if(receipt.fingerprint!==fingerprint)fail('request_reused',409);db.exec('COMMIT');return JSON.parse(receipt.response_json);}
    const stored=db.prepare('SELECT * FROM test_plans WHERE id=?').get(id),current=loadPlan(db,id);
    if(stored?.deleted_at)fail('plan_deleted',409);
    if((current?.revision??null)!==p.revision)fail('plan_conflict',409,current);
    if(!current&&!db.prepare('SELECT id FROM plan_ids WHERE id=?').get(id))fail();
    const now=new Date().toISOString(),revision=(current?.revision??0)+1;
    let response;
    const previous=current?JSON.parse(stored.values_json):null;
    if(p.action==='delete'){
      if(!current||current.state!=='Draft'||current.results.some(r=>r.recordedAt!==null))fail('plan_delete_forbidden',409,current);
      db.prepare('UPDATE test_plans SET deleted_at=?,updated_at=?,revision=? WHERE id=?').run(now,now,revision,id);
      db.prepare('INSERT INTO plan_history(plan_id,at,event,before_json,after_json) VALUES(?,?,?,?,NULL)').run(id,now,'結果のない下書き計画を削除',stored.values_json);
      response={id:v.id,deleted:true,revision};
    }else{
      if(!current&&v.state!=='Draft')fail();
      if(current){
        // 記録済み条件の書換え・ID差替えも、除外による結果破棄と同じ境界で拒否する。
        for(const r of current.results.filter(r=>r.recordedAt!==null)){
          if(!v.caseIds.includes(r.caseId)||!same(v.conditions.find(e=>e.id===r.envId),current.conditions.find(e=>e.id===r.envId)))fail('recorded_target',409,current);
        }
        if(['Completed','Archived'].includes(current.state)&&(!same(current.caseIds,v.caseIds)||!same(current.conditions,v.conditions)))fail('plan_closed',409,current);
        if(v.state==='Draft'&&current.state!=='Draft')fail('invalid_transition',409,current);
        if(current.state==='Archived'&&v.state!=='Archived')fail('invalid_transition',409,current);
        if(v.state==='Archived'&&!['Completed','Archived'].includes(current.state))fail('invalid_transition',409,current);
      }
      for(const caseId of v.caseIds){const row=db.prepare('SELECT values_json FROM cases WHERE id=?').get(number(caseId));if(!row)fail('case_missing',409,current);if(!current?.caseIds.includes(caseId)&&JSON.parse(row.values_json).status!=='Active')fail('case_not_active',409,current);}
      if(current)db.prepare('UPDATE test_plans SET values_json=?,revision=?,updated_at=? WHERE id=?').run(JSON.stringify(v),revision,now,id);
      else db.prepare('INSERT INTO test_plans(id,values_json,revision,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,JSON.stringify(v),revision,now,now);
      const wanted=new Set();
      const insert=db.prepare('INSERT OR IGNORE INTO plan_units(plan_id,case_id,condition_id) VALUES(?,?,?)');
      for(const caseId of v.caseIds)for(const e of v.conditions){wanted.add(`${caseId}|${e.id}`);insert.run(id,number(caseId),e.id);}
      for(const r of current?.results??[])if(!wanted.has(`${r.caseId}|${r.envId}`))db.prepare('DELETE FROM plan_units WHERE plan_id=? AND case_id=? AND condition_id=? AND recorded_at IS NULL').run(id,number(r.caseId),r.envId);
      const saved=loadPlan(db,id);
      if(v.state==='Completed'&&current?.state!=='Completed'){
        const c=counts(saved);if(c['Not Run'])fail('not_run_remaining',409,current);
        if(c.Failed+c.Blocked+c.Skipped+c.retest>0&&!p.acknowledgeWarnings)fail('completion_warning',409,current);
      }
      for(const event of events(previous,v))db.prepare('INSERT INTO plan_history(plan_id,at,event,before_json,after_json) VALUES(?,?,?,?,?)').run(id,now,event,previous?JSON.stringify(previous):null,JSON.stringify(v));
      response=loadPlan(db,id);
    }
    db.prepare('INSERT INTO plan_receipts VALUES(?,?,?)').run(p.requestId,fingerprint,JSON.stringify(response));
    db.exec('COMMIT');return response;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
