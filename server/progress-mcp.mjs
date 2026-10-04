import {cloudDatabase,digest,WorkspaceError} from './cloud-db.mjs';
import {progressPlan,applyProgressPlan,PROGRESS_SOURCE,PROGRESS_AS_OF,PROGRESS_ENTRIES} from './progress-update.mjs';
const str={type:'string'},integer={type:'integer',minimum:0};
const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const marker={baseVersion:integer,previewDigest:{type:'string',pattern:'^[a-f0-9]{64}$'},operationId:{type:'string',pattern:'^mcp-progress-[a-f0-9]{64}$'}};
const fields=obj({status:{enum:['unknown','todo','active','review','done']},waitReason:str,criteria:{type:'array',items:{type:'object',properties:{text:str,checked:{type:'boolean'}},required:['text','checked'],additionalProperties:true}},evidence:str});
const changes={type:'array',items:obj({projectId:str,taskId:str,title:str,before:fields,after:fields})},skipped={type:'array',items:obj({projectId:str,taskId:str,reason:str})};
export const PROGRESS_TOOLS=[
 {name:'preview_progress_update',title:'証拠付き進捗更新を確認',description:'Read-only preview of four fixed existing-task reconciliations dated 2026-10-04 from the bundled sample: recipe-app data terms/menu generator, private hosting, and booking-app draft evidence only. Recheck current source evidence before applying. Changed tasks are excluded. Does not accept arbitrary task updates or mark human acceptance done.',inputSchema:obj({}),outputSchema:obj({...marker,source:str,asOf:str,changes,skipped,writePerformed:{const:false}}),annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
 {name:'apply_progress_update',title:'確認済み進捗更新を登録',description:'Apply only the fixed four-task proof-backed preview for the authenticated owner, with version CAS and exact digest. Preserves estimates, criteria text, original evidence, history and all unrelated records. Three technical tasks can complete; booking-app human acceptance only gains dated draft evidence. No new tasks, arbitrary writes, deletes or human acceptance completion.',inputSchema:obj(marker),outputSchema:obj({applied:{type:'boolean'},replayed:{type:'boolean'},version:integer,count:integer,operationId:str}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
];
const exact=(args,keys)=>args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).length===keys.length&&keys.every(k=>Object.hasOwn(args,k));
const invalid=()=>{throw new WorkspaceError('invalid_arguments','指定された項目・値を確認してください。',400);};
const hash=(userId,version,changes)=>digest(JSON.stringify({userId,version,source:PROGRESS_SOURCE,changes}));
export async function progressTool(name,args,userId,env){
 const db=cloudDatabase(env.DB);
 if(name==='preview_progress_update'){
  if(!exact(args,[]))invalid();const record=await db.load(userId),plan=progressPlan(record.workspace),previewDigest=await hash(userId,record.version,plan.changes);
  return {baseVersion:record.version,previewDigest,operationId:`mcp-progress-${previewDigest}`,source:PROGRESS_SOURCE,asOf:PROGRESS_AS_OF,...plan,writePerformed:false};
 }
 if(!exact(args,['baseVersion','previewDigest','operationId'])||!Number.isSafeInteger(args.baseVersion)||args.baseVersion<0||args.baseVersion>=Number.MAX_SAFE_INTEGER||typeof args.previewDigest!=='string'||!/^[a-f0-9]{64}$/.test(args.previewDigest)||args.operationId!==`mcp-progress-${args.previewDigest}`)invalid();
 const record=await db.load(userId);
 if(record.version===args.baseVersion+1){const state=await db.operationState(userId);if(state.version===record.version&&state.operationId===args.operationId){const changed=PROGRESS_ENTRIES.map(e=>record.workspace.projects.find(p=>p.id===e.projectId)?.data.tasks.find(t=>t.id===e.taskId)?.progressUpdateProvenance).filter(m=>m?.source===PROGRESS_SOURCE&&m.operationId===args.operationId&&m.previewDigest===args.previewDigest&&m.baseVersion===args.baseVersion).map(m=>m.change);if(changed.length&&await hash(userId,args.baseVersion,changed)===args.previewDigest)return {applied:true,replayed:true,version:record.version,count:changed.length,operationId:args.operationId};}}
 if(record.version!==args.baseVersion)throw new WorkspaceError('version_conflict','別の更新があります。進捗更新案を読み直してください。');
 const plan=progressPlan(record.workspace);if(await hash(userId,record.version,plan.changes)!==args.previewDigest)throw new WorkspaceError('preview_conflict','確認内容が変わりました。');
 if(!plan.changes.length)return {applied:false,replayed:false,version:record.version,count:0,operationId:args.operationId};
 const workspace=structuredClone(record.workspace);applyProgressPlan(workspace,plan.changes,{operationId:args.operationId,previewDigest:args.previewDigest,baseVersion:record.version});
 const saved=await db.save(userId,{baseVersion:record.version,operationId:args.operationId,workspace});return {applied:true,replayed:false,version:saved.version,count:plan.changes.length,operationId:args.operationId};
}
