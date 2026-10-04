// Structured outputs mirror the existing read/preview/apply results; no storage schema changes.
const str={type:'string'},num={type:'number'},bool={type:'boolean'},integer={type:'integer',minimum:0};
const nullable=s=>({anyOf:[s,{type:'null'}]});
const array=items=>({type:'array',items});
const obj=(properties,required=Object.keys(properties),additionalProperties=false)=>({type:'object',properties,required,additionalProperties});
const label={projectId:str,taskId:str,projectName:str,title:str};
const estimate={points:{type:'number',exclusiveMinimum:0},range:{type:'array',items:num,minItems:2,maxItems:2},rationale:str};
const change=obj({...label,...estimate,retrospective:bool});
const skip=obj({...label,...estimate,reason:str},[...Object.keys(label),'reason']);
const task=obj({projectId:str,projectName:str,id:str,title:str,goalId:str,parentId:str,status:{enum:['unknown','todo','active','review','done']},estimatePoints:nullable({type:'number',exclusiveMinimum:0}),estimateProvenance:{description:'Preserved JSON metadata; legacy workspace metadata has no fixed schema.'},criteria:array(obj({text:str,checked:bool},['text','checked'],true)),deps:array(str),owner:nullable(str),evidence:str,waitReason:str});
export const MCP_OUTPUT_SCHEMAS={
 read_progress:obj({version:integer,updatedAt:nullable(str),projects:array(obj({id:str,name:str,repositoryUrl:nullable(str),taskCount:integer,goals:array(obj({id:str,title:str}))})),tasks:array(task),totalTasks:integer,nextOffset:nullable(integer)}),
 preview_estimates:obj({baseVersion:integer,updatedAt:nullable(str),source:str,scopeAt:str,unit:str,changes:array(change),skipped:array(skip),addedPoints:num,previewDigest:{type:'string',pattern:'^[a-f0-9]{64}$'},operationId:{type:'string',pattern:'^mcp-estimates-[a-f0-9]{64}$'},writePerformed:{const:false}}),
 apply_estimates:{type:'object',oneOf:[
  obj({applied:{const:true},replayed:{const:false},version:integer,updatedAt:str,count:integer,addedPoints:num,operationId:str}),
  obj({applied:{const:true},replayed:{const:true},version:integer,updatedAt:str,count:integer,operationId:str}),
  obj({applied:{const:false},replayed:{const:false},version:integer,count:{const:0},reason:str})
 ]}
};
