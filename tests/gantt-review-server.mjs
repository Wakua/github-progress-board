// Fictional browser QA only. No GitHub writes or live credentials.
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ganttSnapshot, repositoryUrl } from './gantt-fixture.mjs';
import { qaWorkspace } from './local-github-fixture.mjs';
import { validateWorkspace, STORAGE_KEY } from '../dist/workspace.mjs';
import { scheduleSnapshot } from './github-schedule-fixture.mjs';
import { samples } from '../docs/prototypes/milestone-gantt-samples.mjs';
const root=path.resolve(process.argv[3]||fileURLToPath(new URL('..',import.meta.url)));
const { createProgressServer }=await import(pathToFileURL(path.join(root,'server.mjs')));
const foreign = await scheduleSnapshot();
const choices = {...samples,foreign:{label:'別repositoryの同番号'}};
let mode='ok', sample='basic', progress=null, resume;
const snapshot=()=>sample==='foreign'?{...structuredClone(foreign),fetchedAt:new Date().toISOString()}:ganttSnapshot(sample,progress,new Date().toISOString());
const seed=()=>{const w=qaWorkspace();w.projects=w.projects.slice(0,1);w.projects[0].repositoryUrl=snapshot().repositoryUrl;w.projects[0].githubSnapshot={...snapshot(),projectId:w.projects[0].id};validateWorkspace(w);return w;};
const server=createProgressServer({root:path.join(root,'dist'),repositories:[repositoryUrl,foreign.repositoryUrl],refresher:{refresh:async()=>{if(mode==='hold')await new Promise(r=>{resume=r;});if(mode==='fail')throw Object.assign(new Error('fixture failure'),{code:'network'});return snapshot();}}});
const production=server.listeners('request')[0];server.removeAllListeners('request');
server.on('request',async(req,res)=>{
 if(req.url==='/qa-text200') {
   const html=await readFile(path.join(root,'dist/index.html'),'utf8');
   const css='.gantt{font-size:32px}.gantt button,.gantt .task-button,.gantt .summary,.gantt .visible-range{font-size:28px}.gantt h2{font-size:36px}.gantt h3{font-size:30px}.gantt .hint,.gantt .legend,.gantt .duration,.gantt .dates,.gantt .row-warning,.gantt [data-gantt="alerts"] button{font-size:24px}.gantt .chart{--name-width:250px}.gantt .row{min-height:110px}.gantt .row.header{min-height:80px}.gantt .bar{top:40px}.gantt .bar.point{top:49px}.gantt dialog{max-width:740px}';
   res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html.replace('</head>','<style>'+css+'</style></head>'));
 }
 else if(req.url==='/qa'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<title>ガント組込みQA</title><h1>架空データの操作検証</h1><label>サンプル <select id="sample">'+Object.entries(choices).map(([k,v])=>'<option value="'+k+'">'+v.label+'</option>').join('')+'</select></label><label>取得応答 <select id="mode"><option value="ok">成功</option><option value="fail">失敗</option><option value="hold">待機</option></select></label><label>進捗率 <input id="progress" type="number" min="0" max="100"></label><button id="apply">応答を設定</button><button id="seed">QAデータを準備して開く</button><button id="saved">保存状態を確認</button><pre id="result"></pre><script>const $=s=>document.querySelector(s);$("#apply").onclick=async()=>{$("#result").textContent=await(await fetch("/qa-state",{method:"POST",body:JSON.stringify({sample:$("#sample").value,mode:$("#mode").value,progress:$("#progress").value===""?null:Number($("#progress").value)})})).text()};$("#seed").onclick=async()=>{localStorage.setItem('+JSON.stringify(STORAGE_KEY)+',await(await fetch("/qa-seed")).text());location.href="/"};$("#saved").onclick=async()=>{const w=JSON.parse(localStorage.getItem('+JSON.stringify(STORAGE_KEY)+')),p=w.projects[0],hash=async v=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(v))))).map(n=>n.toString(16).padStart(2,"0")).join("");$("#result").textContent=JSON.stringify({manual:await hash(p.data),snapshot:await hash(p.githubSnapshot),fetchedAt:p.githubSnapshot.fetchedAt})};</script>');}
 else if(req.url==='/qa-seed'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(seed()));}
 else if(req.url==='/qa-state'&&req.method==='POST'){const chunks=[];for await(const c of req)chunks.push(c);const v=JSON.parse(Buffer.concat(chunks));if(!Object.hasOwn(choices,v.sample)||!['ok','fail','hold'].includes(v.mode)||!(v.progress===null||Number.isInteger(v.progress)&&v.progress>=0&&v.progress<=100)){res.writeHead(400).end();return;}sample=v.sample;mode=v.mode;progress=v.progress;resume?.();resume=null;res.end('設定した');}
 else production(req,res);
});
server.listen(Number(process.argv[2]),'127.0.0.1',()=>console.log('Gantt QA http://127.0.0.1:'+server.address().port+'/qa'));
