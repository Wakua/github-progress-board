import baseline from '../samples/prepared-workspace.json' with {type:'json'};
import {updateProject,validateWorkspace} from '../dist/workspace.mjs';
import {transition,setCriterion,setWait} from '../dist/engine.mjs';
export const PROGRESS_SOURCE='verified-progress-2026-10-04T0607Z';
export const PROGRESS_AS_OF='2026-10-04T06:07:15Z';
const recipe='https://github.com/example/recipe-app/pull/19';
// サンプル記録（架空）。実在のrepositoryの進捗ではない。
export const PROGRESS_ENTRIES=[
 {projectId:'recipe-app',taskId:'nutrition-data-terms',complete:true,evidence:`データ提供元から同梱を認める回答を受け取り、利用条件と更新の頻度を記録した。\n${recipe}`},
 {projectId:'recipe-app',taskId:'weekly-menu-generator',complete:true,evidence:`6つの完了条件をテストで確認し、PR19を統合した。家族による利用の確認は別の作業として残す。\n${recipe}`},
 {projectId:'progress-board',taskId:'private-hosting',complete:true,evidence:'本人だけが開けるURLで画面を表示し、保存先のデータベースと公開したソースの一致を確認した。'},
 {projectId:'booking-app',taskId:'annual-user-trial',complete:false,evidence:'年間の予約結果表示のPR26はDraftのまま。自動入力の確認はあるが、利用者による評価はまだ行っていない。\nhttps://github.com/example/booking-app/pull/26'}
];
const taskAt=(w,p,id)=>w.projects.find(x=>x.id===p)?.data.tasks.find(x=>x.id===id);
const comparable=t=>{const {estimatePoints,estimateProvenance,...rest}=t;return rest;};
export function progressPlan(workspace){
 validateWorkspace(workspace);const changes=[],skipped=[];
 for(const entry of PROGRESS_ENTRIES){const project=workspace.projects.find(p=>p.id===entry.projectId),originalProject=baseline.projects.find(p=>p.id===entry.projectId),task=taskAt(workspace,entry.projectId,entry.taskId),original=taskAt(baseline,entry.projectId,entry.taskId);
  let reason=null;
  if(!task||project.repositoryUrl!==originalProject.repositoryUrl)reason='対象またはrepositoryが一致しない';
  else if(task.progressUpdateProvenance?.source===PROGRESS_SOURCE)reason='更新済み';
  else if(JSON.stringify(comparable(task))!==JSON.stringify(comparable(original)))reason='原本以降の作業編集を保持する';
  if(reason){skipped.push({projectId:entry.projectId,taskId:entry.taskId,reason});continue;}
  const before={status:task.status,waitReason:task.waitReason,criteria:structuredClone(task.criteria),evidence:task.evidence};
  const after={status:entry.complete?'done':task.status,waitReason:entry.complete?'':task.waitReason,criteria:task.criteria.map(c=>({...c,checked:entry.complete?true:c.checked})),evidence:task.evidence+'\n\n証拠に基づく記録更新（'+PROGRESS_AS_OF+'）:\n'+entry.evidence};
  changes.push({projectId:entry.projectId,taskId:entry.taskId,title:task.title,before,after});
 }
 // A dependent completion cannot bypass an excluded prerequisite.
 for(let i=changes.length-1;i>=0;i--){const c=changes[i],t=taskAt(workspace,c.projectId,c.taskId);if(c.after.status==='done'&&t.deps.some(id=>taskAt(workspace,c.projectId,id)?.status!=='done'&&!changes.some(x=>x.projectId===c.projectId&&x.taskId===id&&x.after.status==='done'))){changes.splice(i,1);skipped.push({projectId:c.projectId,taskId:c.taskId,reason:'未完了または除外された前提作業を保持する'});}}
 return {changes,skipped};
}
export function applyProgressPlan(workspace,changes,receipt){
 const current=progressPlan(workspace);if(JSON.stringify(current.changes)!==JSON.stringify(changes))throw new Error('Progress preview changed');
 for(const c of changes)updateProject(workspace,c.projectId,data=>{const task=data.tasks.find(t=>t.id===c.taskId),start=data.history.length;
  if(c.after.status==='done'){setWait(data,task.id,'');transition(data,task.id,'active');for(let i=0;i<task.criteria.length;i++)setCriterion(data,task.id,i,true);transition(data,task.id,'review');transition(data,task.id,'done');}
  task.evidence=c.after.evidence;task.progressUpdateProvenance={source:PROGRESS_SOURCE,...receipt,change:structuredClone(c)};
  for(const h of data.history.slice(0,data.history.length-start))h.text='証拠に基づく記録更新（過去の実作業日時ではない）：'+h.text;
  data.history.unshift({text:'証拠に基づく記録更新：'+task.title+'の検証根拠を追記',goalId:task.goalId,at:new Date().toISOString()});
 });validateWorkspace(workspace);
}
