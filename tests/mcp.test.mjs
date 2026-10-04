import { spawnSync } from 'node:child_process';
import { MCP_OUTPUT_SCHEMAS } from '../server/mcp-schemas.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../server/worker.mjs';
import {cloudDatabase} from '../server/cloud-db.mjs';
import {sqliteD1} from './cloud-fixtures.mjs';
const baseline=JSON.parse(readFileSync(new URL('../samples/prepared-workspace.json',import.meta.url)));
const origin='https://progress.test';
function harness(t){const DB=sqliteD1();t.after(()=>DB.close());const db=cloudDatabase(DB);
 const rpc=async(method,params={},identity='qa-owner',options={})=>{
  // Simulates the documented dispatcher boundary; external identity headers are discarded here.
  const headers=new Headers({'Content-Type':'application/json',Accept:'application/json, text/event-stream',...options.headers});headers.delete('oai-authenticated-user-id');if(identity)headers.set('oai-authenticated-user-id',identity);
  const body=options.raw??JSON.stringify({jsonrpc:'2.0',id:1,method,params});const response=await worker.fetch(new Request(origin+(options.path??'/mcp'),{method:options.method??'POST',headers,...((options.method??'POST')==='POST'?{body}:{})}),{DB});
  return {status:response.status,body:response.status===202||response.status===405?null:await response.json()};
 };
 return {DB,db,rpc,tool:async(name,args={},identity='qa-owner')=>{const r=await rpc('tools/call',{name,arguments:args},identity);if(r.body?.result?.isError===false)validateOutput(name,r.body.result.structuredContent);else if(r.body?.result?.isError)assert.equal('structuredContent' in r.body.result,false);return r;},seed:async(identity='qa-owner',workspace=baseline)=>db.save(identity,{baseVersion:0,operationId:'qa-initial-seed-1234',workspace:structuredClone(workspace)})};
}
const result=r=>{assert.equal(r.status,200);assert.equal(r.body.result.isError,false);return r.body.result.structuredContent;};
const args=preview=>({baseVersion:preview.baseVersion,previewDigest:preview.previewDigest,operationId:preview.operationId});
test('MCP initialization, static discovery, ping and notifications implement stateless JSON transport',async t=>{
 const h=harness(t);const init=await h.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'qa',version:'1'}},null);assert.equal(init.body.result.protocolVersion,'2025-11-25');
 const discovery=await h.rpc('tools/list',{},null);assert.deepEqual(discovery.body.result.tools.map(t=>t.name),['preview_progress_update','apply_progress_update','read_github_facts','preview_github_facts','apply_github_facts','read_progress','preview_estimates','apply_estimates']);assert.ok(!JSON.stringify(discovery).includes('ingredient-search'));assert.equal(discovery.body.result.tools.find(t=>t.name==='apply_estimates').annotations.readOnlyHint,false);
 assert.deepEqual((await h.rpc('ping',{},null)).body.result,{});assert.equal((await h.rpc('',{},null,{raw:'{"jsonrpc":"2.0","method":"notifications/initialized"}'})).status,202);assert.equal((await h.rpc('',{},null,{method:'GET'})).status,405);
});
test('unauthenticated data calls and spoofed caller identities fail before database access',async t=>{
 const h=harness(t);await h.seed();for(const name of ['read_progress','preview_estimates','apply_estimates','preview_progress_update','apply_progress_update','read_github_facts','preview_github_facts','apply_github_facts'])assert.equal((await h.tool(name,{},null)).status,401);
 assert.equal((await h.rpc('tools/call',{name:'read_progress',arguments:{}},null,{headers:{'oai-authenticated-user-id':'qa-owner'}})).status,401);
 assert.equal((await h.tool('read_progress',{userId:'qa-owner'})).body.result.isError,true);assert.equal((await h.tool('preview_estimates',{userId:'qa-other'})).body.result.isError,true);
});
test('private progress is isolated by dispatcher identity, never caller project/user fields',async t=>{
 const h=harness(t);await h.seed();assert.equal(result(await h.tool('read_progress')).totalTasks,18);assert.equal(result(await h.tool('read_progress',{},'qa-other')).totalTasks,0);assert.equal((await h.tool('read_progress',{projectId:'recipe-app'},'qa-other')).body.result.isError,true);
 const one=result(await h.tool('read_progress',{limit:1}));assert.equal(one.tasks.length,1);assert.equal(one.nextOffset,1);assert.equal('userId' in one,false);
});
test('explicit preview and estimate apply preserve all non-estimate task values, existing estimates and prior history',async t=>{
 const h=harness(t),w=structuredClone(baseline);w.projects[0].data.tasks[0].estimatePoints=7;w.projects[0].data.tasks[1].evidence='owner edit';await h.seed('qa-owner',w);
 const preview=result(await h.tool('preview_estimates'));assert.equal(preview.changes.length,17);assert.equal((await h.db.load('qa-owner')).version,1);
 const applied=result(await h.tool('apply_estimates',args(preview)));assert.equal(applied.version,2);assert.equal(applied.count,17);
 const saved=await h.db.load('qa-owner');assert.equal(saved.workspace.projects[0].data.tasks[0].estimatePoints,7);assert.equal(saved.workspace.projects[0].data.tasks[1].evidence,'owner edit');
 for(let p=0;p<w.projects.length;p++){const original=w.projects[p],after=saved.workspace.projects[p];for(let i=0;i<original.data.tasks.length;i++){const {estimatePoints,estimateProvenance,...actual}=after.data.tasks[i];const {estimatePoints:ignored,...expected}=original.data.tasks[i];assert.deepEqual(actual,expected);}assert.deepEqual(after.data.history.slice(after.data.history.length-original.data.history.length),original.data.history);}
 assert.equal((await h.db.backup('qa-owner')).versions.length,2);
});
test('exact retry replays once without new version or history; different operation/digest cannot reuse it',async t=>{
 const h=harness(t);await h.seed();const preview=result(await h.tool('preview_estimates'));const a=args(preview);result(await h.tool('apply_estimates',a));const saved=await h.db.load('qa-owner');const retry=result(await h.tool('apply_estimates',a));assert.equal(retry.replayed,true);assert.equal(retry.version,2);assert.deepEqual(await h.db.load('qa-owner'),saved);
 assert.equal((await h.tool('apply_estimates',{...a,previewDigest:'a'.repeat(64)})).body.result.isError,true);assert.equal((await h.tool('apply_estimates',{...a,operationId:'mcp-estimates-'+'b'.repeat(64),previewDigest:'b'.repeat(64)})).body.result.isError,true);
});
test('preview cannot be applied by another identity or after an owner edit/version change',async t=>{
 const h=harness(t);await h.seed();await h.seed('qa-other');const preview=result(await h.tool('preview_estimates'));assert.equal((await h.tool('apply_estimates',args(preview),'qa-other')).body.result.isError,true);
 const record=await h.db.load('qa-owner');record.workspace.projects[0].data.tasks[0].evidence+=' newer';await h.db.save('qa-owner',{baseVersion:record.version,operationId:'qa-newer-edit-1234',workspace:record.workspace});assert.equal((await h.tool('apply_estimates',args(preview))).body.result.isError,true);assert.equal((await h.db.load('qa-owner')).workspace.projects[0].data.tasks[0].estimatePoints,null);
});
test('unknown fields, arbitrary writes, notifications and malformed requests never mutate records',async t=>{
 const h=harness(t);await h.seed();const before=await h.db.load('qa-owner'),preview=result(await h.tool('preview_estimates'));
 for(const extra of [{userId:'qa-other'},{sql:'DELETE FROM progress_workspaces'},{workspace:{}},{status:'done'},{url:'https://example.com'}])assert.equal((await h.tool('apply_estimates',{...args(preview),...extra})).body.result.isError,true);
 assert.equal((await h.tool('delete_workspace',{})).body.error.code,-32602);assert.equal((await h.rpc('tools/call',{},'qa-owner',{raw:JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name:'apply_estimates',arguments:args(preview)}})})).status,400);
 assert.equal((await h.rpc('tools/list',{},null,{raw:'['})).status,400);assert.equal((await h.rpc('tools/list',{},null,{raw:'[]'})).status,400);assert.equal((await h.rpc('tools/list',{},null,{raw:'x'.repeat(70000)})).status,400);assert.deepEqual(await h.db.load('qa-owner'),before);
});
test('cross-origin/browser requests and unsupported protocols reject; no CORS authorization fallback',async t=>{
 const h=harness(t);assert.equal((await h.rpc('tools/list',{},null,{headers:{Origin:'https://hostile.test'}})).status,403);assert.equal((await h.rpc('tools/list',{},null,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);assert.equal((await h.rpc('tools/list',{},null,{headers:{'MCP-Protocol-Version':'1900-01-01'}})).status,400);
});
test('changed scope is skipped and empty/already-estimated plans never write',async t=>{
 const h=harness(t);let p=result(await h.tool('preview_estimates'));assert.equal(p.changes.length,0);assert.equal(result(await h.tool('apply_estimates',args(p))).applied,false);assert.equal((await h.db.load('qa-owner')).version,0);
 const w=structuredClone(baseline);w.projects[0].data.tasks[0].title+=' changed';await h.seed('qa-owner',w);p=result(await h.tool('preview_estimates'));assert.equal(p.changes.length,17);assert.ok(p.skipped.some(x=>x.taskId==='ingredient-search'));result(await h.tool('apply_estimates',args(p)));assert.equal((await h.db.load('qa-owner')).workspace.projects[0].data.tasks[0].estimatePoints,null);
});

function validateOutput(name,value){
 const run=spawnSync('python',['-c','import json,sys,jsonschema; s,v=json.load(sys.stdin); jsonschema.Draft202012Validator.check_schema(s); jsonschema.Draft202012Validator(s).validate(v)'],{input:JSON.stringify([MCP_OUTPUT_SCHEMAS[name],value]),encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
}
test('descriptors declare exact structured output contracts; discovery accepts standard metadata',async t=>{
 const h=harness(t),r=await h.rpc('tools/list',{_meta:{'openai/locale':'ja'}},null);
 assert.equal(r.body.jsonrpc,'2.0');assert.equal(r.body.id,1);assert.equal('error' in r.body,false);
 for(const tool of r.body.result.tools.filter(t=>MCP_OUTPUT_SCHEMAS[t.name]))assert.deepEqual(tool.outputSchema,MCP_OUTPUT_SCHEMAS[tool.name]);
 const init=await h.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'qa',version:'1'},_meta:{'openai/locale':'ja'}},null);
 assert.equal(init.body.jsonrpc,'2.0');assert.equal(init.body.id,1);assert.equal(init.body.result.capabilities.tools.listChanged,false);
 await h.seed();result(await h.tool('read_progress'));const p=result(await h.tool('preview_estimates'));result(await h.tool('apply_estimates',args(p)));result(await h.tool('read_progress'));result(await h.tool('apply_estimates',args(p)));
});
test('protocol diagnostics contain only allowlisted metadata and never request or response values',async t=>{
 const h=harness(t),logs=[],original=console.info;console.info=x=>logs.push(JSON.parse(x));
 try{await h.rpc('tools/list',{},'private-identity');await h.rpc('secret-method',{},'private-identity');await h.rpc('tools/call',{name:'read_progress',arguments:{secret:'private-argument'}},'private-identity');await h.rpc('tools/list',{},null,{headers:{'MCP-Protocol-Version':'private-token'}});}finally{console.info=original;}
 for(const log of logs)assert.deepEqual(Object.keys(log).sort(),['code','event','method','outcome','protocol','status']);
 assert.equal(JSON.stringify(logs).includes('private'),false);assert.ok(logs.some(x=>x.method==='tools/list'&&x.outcome==='success'));assert.ok(logs.some(x=>x.outcome==='rpc_error'&&x.code===-32601));assert.ok(logs.some(x=>x.outcome==='tool_error'));
});
