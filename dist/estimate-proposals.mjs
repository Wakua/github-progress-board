import { validateWorkspace, updateProject } from './workspace.mjs';
import { setEstimate } from './engine.mjs';
export const ESTIMATE_SOURCE = 'prepared-estimates-2026-10-04-v1';
const positive = n => Number.isFinite(n) && n > 0;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const scope = task => ({ title:task.title,goalId:task.goalId,parentId:task.parentId,issueNumber:task.issueNumber,criteria:task.criteria.map(c=>c.text),deps:[...task.deps].sort() });
export function isProvisionalEstimate(task) {
 const p=task.estimateProvenance;
 return p?.source===ESTIMATE_SOURCE && p.kind==='provisional' && p.points===task.estimatePoints;
}
export function planPreparedEstimates(current, baseline, proposal) {
 validateWorkspace(current);validateWorkspace(baseline);
 if(proposal?.source!==ESTIMATE_SOURCE || proposal.unit!=='point' || proposal.pointsPerWorkday!==1 || !Array.isArray(proposal.entries) || !Number.isFinite(Date.parse(proposal.scopeAt)))throw new Error('仮見積の原本を確認してください。');
 const changes=[],skipped=[],seen=new Set();
 for(const item of proposal.entries){
  const key=JSON.stringify([item.projectId,item.taskId]);
  if(seen.has(key)||!positive(item.points)||!Array.isArray(item.range)||item.range.length!==2||!item.range.every(positive)||item.range[0]>item.points||item.range[1]<item.points||typeof item.rationale!=='string'||!item.rationale.trim()||item.rationale.length>2000)throw new Error('仮見積の値・根拠を確認してください。');seen.add(key);
  const original=baseline.projects.find(p=>p.id===item.projectId),originalTask=original?.data.tasks.find(t=>t.id===item.taskId);
  if(!originalTask)throw new Error('仮見積と登録元の作業が一致しません。');
  const project=current.projects.find(p=>p.id===item.projectId),task=project?.data.tasks.find(t=>t.id===item.taskId);
  const label={...item,projectName:project?.name||original.name,title:task?.title||originalTask.title};
  let reason=null;
  if(!project||!task)reason='対象が未登録のため変更しません';
  else if(project.repositoryUrl!==original.repositoryUrl)reason='repositoryが原本と異なるため変更しません';
  else if(task.estimatePoints!==null)reason='見積入力済みのため保持します';
  else if(task.estimateProvenance!==undefined)reason='既存の見積注記を保持します';
  else if(!same(scope(task),scope(originalTask)))reason='作業名・条件・所属・依存が原本と異なるため変更しません';
  if(reason)skipped.push({...label,reason});else changes.push({...label,retrospective:task.status==='done'});
 }
 for(const project of current.projects)for(const task of project.data.tasks)if(!seen.has(JSON.stringify([project.id,task.id])))skipped.push({projectId:project.id,taskId:task.id,projectName:project.name,title:task.title,reason:'この原本にない作業のため変更しません'});
 return {changes,skipped,addedPoints:changes.reduce((n,c)=>n+c.points,0)};
}
export function applyPreparedEstimates(current,baseline,proposal,expectedChanges,recordedAt=new Date().toISOString()) {
 const plan=planPreparedEstimates(current,baseline,proposal);
 if(!same(plan.changes,expectedChanges)||!Number.isFinite(Date.parse(recordedAt)))throw new Error('確認内容が変わりました。仮見積の一覧を開き直してください。');
 for(const change of plan.changes){
  const project=current.projects.find(p=>p.id===change.projectId),task=project.data.tasks.find(t=>t.id===change.taskId);
  updateProject(current, project.id, data => setEstimate(data, task.id, change.points));
  task.estimateProvenance={source:ESTIMATE_SOURCE,kind:'provisional',points:change.points,range:[...change.range],rationale:change.rationale,retrospective:change.retrospective,scopeAt:proposal.scopeAt,recordedAt};
  // setEstimate appends history; retain all older entries and identify the new one as provisional.
  project.data.history[0].text+=`（${change.retrospective?'事後の仮見積':'仮見積'}、目安 ${change.range[0]}–${change.range[1]}pt。実績時間ではない）`;
 }
 validateWorkspace(current);return plan;
}
