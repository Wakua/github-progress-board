import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import baseline from '../samples/prepared-workspace.json' with {type:'json'};
import {snapshotTool,SNAPSHOT_TOOLS} from '../server/snapshot-mcp.mjs';
import {cloudDatabase} from '../server/cloud-db.mjs';
import {sqliteD1} from './cloud-fixtures.mjs';
const repo='https://github.com/Wakua/github-progress-board';
const snapshot=(time='2026-10-04T05:00:00Z')=>({schemaVersion:1,source:'github',repositoryUrl:repo,fetchedAt:time,sources:{issues:{complete:true,urls:['https://api.github.com/repos/Wakua/github-progress-board/issues?state=all&per_page=100&sort=updated&direction=desc&page=1']},pullRequests:{complete:true,urls:['https://api.github.com/repos/Wakua/github-progress-board/pulls?state=all&per_page=100&sort=updated&direction=desc&page=1']}},items:[{kind:'issue',number:5,url:repo+'/issues/5',title:'untrusted title',state:'open',updatedAt:'2026-10-04T04:00:00Z',closedAt:null,estimatePoints:null,deadline:null}]});
const applyArgs=(p,s)=>({snapshot:s,baseVersion:p.baseVersion,previewDigest:p.previewDigest,operationId:p.operationId});
function setup(t){const DB=sqliteD1();t.after(()=>DB.close());const db=cloudDatabase(DB),call=async(name,args={},user='owner')=>{const v=await snapshotTool(name,args,user,{DB}),s=SNAPSHOT_TOOLS.find(t=>t.name===name).outputSchema;const r=spawnSync('python',['-c','import json,sys,jsonschema; s,v=json.load(sys.stdin);jsonschema.Draft202012Validator.check_schema(s);jsonschema.validate(v,s)'],{input:JSON.stringify([s,v]),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return v;};return {db,call,seed:()=>db.save('owner',{baseVersion:0,operationId:'snapshot-seed',workspace:structuredClone(baseline)})};}
test('snapshot preview/apply/replay preserves every manual field and other project; readback matches',async t=>{const h=setup(t);await h.seed();const before=await h.db.load('owner'),s=snapshot(),p=await h.call('preview_github_facts',{snapshot:s});assert.equal(p.summary.issueCount,1);assert.equal((await h.db.load('owner')).version,1);const a=await h.call('apply_github_facts',applyArgs(p,s));assert.equal(a.version,2);assert.equal((await h.call('apply_github_facts',applyArgs(p,s))).replayed,true);const after=await h.db.load('owner');const target=after.workspace.projects.find(x=>x.id==='progress-board');delete target.githubSnapshot;delete target.githubSnapshotReceipt;assert.deepEqual(after.workspace,before.workspace);const r=await h.call('read_github_facts');assert.deepEqual(r.snapshot,{...s,projectId:'progress-board'});});
test('new/closed Issue facts do not create or complete planned tasks',async t=>{const h=setup(t);await h.seed();let s=snapshot(),p=await h.call('preview_github_facts',{snapshot:s});await h.call('apply_github_facts',applyArgs(p,s));const before=(await h.db.load('owner')).workspace.projects.find(x=>x.id==='progress-board').data;s=snapshot('2026-10-04T05:01:00Z');s.items[0].state='closed';s.items[0].closedAt=s.items[0].updatedAt='2026-10-04T05:00:30Z';s.items.push({...s.items[0],number:6,url:repo+'/issues/6'});p=await h.call('preview_github_facts',{snapshot:s});assert.deepEqual(p.summary.added,[6]);assert.deepEqual(p.summary.changed,[5]);await h.call('apply_github_facts',applyArgs(p,s));assert.deepEqual((await h.db.load('owner')).workspace.projects.find(x=>x.id==='progress-board').data,before);});
test('reject wrong repo, URL, partial, arbitrary fields, fake estimates and future snapshots',async t=>{const h=setup(t);await h.seed();for(const change of [s=>s.repositoryUrl='https://github.com/qa-fixture/other',s=>s.sources.issues.complete=false,s=>s.sources.issues.urls[0]='https://evil.test',s=>s.items[0].estimatePoints=1,s=>s.items[0].command='run',s=>s.projectId='progress-board',s=>s.fetchedAt='2099-01-01T00:00:00Z']){const s=snapshot();change(s);await assert.rejects(h.call('preview_github_facts',{snapshot:s}));}assert.equal((await h.db.load('owner')).version,1);});
test('old timestamps, missing old facts, identity and version conflicts cannot overwrite',async t=>{const h=setup(t);await h.seed();const s=snapshot(),p=await h.call('preview_github_facts',{snapshot:s});await assert.rejects(h.call('apply_github_facts',{...applyArgs(p,s),userId:'owner'}));await assert.rejects(h.call('apply_github_facts',applyArgs(p,s),'other'));await h.call('apply_github_facts',applyArgs(p,s));await assert.rejects(h.call('preview_github_facts',{snapshot:s}));let next=snapshot('2026-10-04T05:01:00Z');next.items=[];await assert.rejects(h.call('preview_github_facts',{snapshot:next}),/欠落/);next=snapshot('2026-10-04T05:01:00Z');const preview=await h.call('preview_github_facts',{snapshot:next}),old=await h.db.load('owner');await h.db.save('owner',{baseVersion:2,operationId:'concurrent-edit',workspace:old.workspace});await assert.rejects(h.call('apply_github_facts',applyArgs(preview,next)),/更新/);assert.equal((await h.db.load('owner')).version,3);});

test('main planning metadata is readable under the output contract and cannot be erased by the limited facts tool',async t=>{
 const h=setup(t);await h.seed();const s=snapshot();
 s.planning={sources:{hierarchy:{complete:true,url:'https://api.github.com/graphql'},milestones:{complete:true,urls:['https://api.github.com/repos/Wakua/github-progress-board/milestones?state=all&per_page=100&sort=due_on&direction=asc&page=1']}},issues:[{number:5,parent:null,childCount:0,milestoneNumber:null,projects:[]}],milestones:[]};
 const r=await h.db.load('owner');r.workspace.projects.find(p=>p.id==='progress-board').githubSnapshot={...s,projectId:'progress-board'};
 await h.db.save('owner',{baseVersion:r.version,operationId:'planning-existing',workspace:r.workspace});
 const before=await h.db.load('owner');assert.deepEqual((await h.call('read_github_facts')).snapshot.planning,s.planning);
 await assert.rejects(h.call('preview_github_facts',{snapshot:s}),e=>e.code==='invalid_arguments');
 await assert.rejects(h.call('preview_github_facts',{snapshot:snapshot('2026-10-04T05:01:00Z')}),e=>e.code==='planning_not_supported');
 assert.deepEqual(await h.db.load('owner'),before);
});

test('read contract preserves valid stored repository casing while hosted writes require the fixed canonical repository',async t=>{
 const h=setup(t),w=structuredClone(baseline),s=snapshot();
 s.repositoryUrl=s.repositoryUrl.toLowerCase();
 for(const item of s.items)item.url=item.url.toLowerCase();
 for(const source of Object.values(s.sources))source.urls=source.urls.map(url=>url.toLowerCase());
 w.projects.find(p=>p.id==='progress-board').githubSnapshot={...s,projectId:'progress-board'};
 await h.db.save('owner',{baseVersion:0,operationId:'snapshot-case-seed',workspace:w});
 const before=await h.db.load('owner'),r=await h.call('read_github_facts');
 assert.deepEqual(r.snapshot,{...s,projectId:'progress-board'});
 await assert.rejects(h.call('preview_github_facts',{snapshot:s}),e=>e.code==='invalid_arguments');
 assert.deepEqual(await h.db.load('owner'),before);
});
