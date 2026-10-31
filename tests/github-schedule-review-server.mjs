// Isolated browser review: fabricated data only; never invokes gh or writes user storage.
// node tests/github-schedule-review-server.mjs <port> [baseline checkout]
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { scheduleFixture, repo, external, url } from './github-schedule-fixture.mjs';
import { qaWorkspace } from './local-github-fixture.mjs';
import { buildSnapshot } from '../dist/github-snapshot.mjs';
import { buildPlanning } from '../scripts/github-planning-fetch.mjs';
import { STORAGE_KEY, validateWorkspace } from '../dist/workspace.mjs';

const root = path.resolve(process.argv[3] || fileURLToPath(new URL('..', import.meta.url)));
const { createProgressServer } = await import(pathToFileURL(path.join(root, 'server.mjs')));
const { createGithubRefresher } = await import(pathToFileURL(path.join(root, 'scripts/local-github-refresh.mjs')));
let mode = 'ok', version = 1, release = null, reads = [], lastFailure = null;
const data = () => {
  const d = scheduleFixture();
  d.issuePages[0][0].title = `QA 予約一覧 v${version}`;
  d.issuePages[0][1].title = 'QA 予約機能';
  return d;
};
const seed = () => {
  const w = qaWorkspace(); w.projects = w.projects.slice(0, 1);
  const d = data();
  w.projects[0].githubSnapshot = { ...buildSnapshot({ ...d, planning: buildPlanning(d) }), projectId: w.projects[0].id };
  validateWorkspace(w); return w;
};
const run = async (_, args) => {
  const query = args.at(-1); reads.push(args[3] === 'graphql' ? query.includes('issue(number:') ? 'external' : 'hierarchy' : query.includes('/issues?') ? 'issues' : query.includes('/pulls?') ? 'pulls' : 'milestones');
  if (mode === 'hold') await new Promise(resolve => { release = resolve; });
  if (mode === 'fail') throw new Error('QA secret response');
  const d = data();
  if (args[3] !== 'graphql') return { stdout: JSON.stringify(query.includes('/issues?') ? d.issuePages[0] : query.includes('/pulls?') ? [] : d.milestonePages[0]) };
  const n = query.match(/issue\(number:(\d+)\)/)?.[1];
  if (n && mode === 'external-fail') return { stdout: JSON.stringify({ errors: [{ type: 'FORBIDDEN', message: 'QA secret external response' }] }) };
  const response = n ? { data: { repository: { issue: d.externalNodes.get(url(Number(n), external)) } } } : d.hierarchyPages[0];
  response.data.rateLimit = { remaining: 5000, resetAt: new Date(Date.now() + 3600000).toISOString() };
  return { stdout: JSON.stringify(response) };
};
const actual = createGithubRefresher({ repositories: [repo], run, cacheMs: 0 });
const server = createProgressServer({ root: path.join(root, 'dist'), repositories: [repo], refresher: {
  refresh: async key => { try { const s = await actual.refresh(key); lastFailure = null; return s; } catch (e) { lastFailure = e.code; throw e; } },
} });
const production = server.listeners('request')[0]; server.removeAllListeners('request');
server.on('request', async (req, res) => {
  if (req.url === '/qa') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<title>取得検証用の操作</title><h1>架空データだけの取得検証</h1>
<button id="seed">QAデータを準備して開く</button>
<label>応答 <select id="mode"><option value="ok">成功</option><option value="fail">全体の取得失敗</option><option value="external-fail">外部前提の取得失敗</option><option value="hold">取得待機</option></select></label>
<label>版 <input id="version" type="number" value="1"></label><button id="apply">応答を設定</button><p id="result"></p>
<button id="read">保存データを確認</button><pre id="saved"></pre>
<script>document.querySelector('#seed').onclick=()=>{localStorage.setItem(${JSON.stringify(STORAGE_KEY)},${JSON.stringify(JSON.stringify(seed()))});location.href='/'};
document.querySelector('#apply').onclick=async()=>{const r=await fetch('/qa-state',{method:'POST',body:JSON.stringify({mode:document.querySelector('#mode').value,version:Number(document.querySelector('#version').value)})});document.querySelector('#result').textContent=await r.text()};
document.querySelector('#read').onclick=async()=>{const raw=localStorage.getItem(${JSON.stringify(STORAGE_KEY)}),w=JSON.parse(raw),p=w?.projects[0];const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(v=>v.toString(16).padStart(2,'0')).join('');document.querySelector('#saved').textContent=JSON.stringify({workspaceHash:await hash(raw),manualHash:await hash(JSON.stringify(p.data)),snapshotHash:await hash(JSON.stringify(p.githubSnapshot)),fetchedAt:p.githubSnapshot?.fetchedAt,titles:p.githubSnapshot?.items.map(i=>i.title),hasSchedule:!!p.githubSnapshot?.planning?.schedule},null,2)};</script>`);
  } else if (req.url === '/qa-state' && req.method === 'POST') {
    const chunks = []; for await (const c of req) chunks.push(c);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (!['ok', 'fail', 'external-fail', 'hold'].includes(input.mode) || !Number.isInteger(input.version)) { res.writeHead(400).end(); return; }
    mode = input.mode; version = input.version; release?.(); release = null; res.end('設定した');
  } else if (req.url === '/qa-state' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ mode, version, reads, lastFailure }));
  } else production(req, res);
});
server.listen(Number(process.argv[2]), '127.0.0.1', () => console.log(`QA ${root}: http://127.0.0.1:${server.address().port}/qa`));
