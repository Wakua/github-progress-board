import { createReadStream, createWriteStream, existsSync, openSync, writeFileSync, readFileSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { BugError } from './bug-store.mjs';

export function sendJson(response,status,value) {
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  response.end(JSON.stringify(value));
}
export function requestActor(store) { return store.sharedActor(); }
async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new BugError(415,'JSON形式で送信してください。');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 ** 2) throw new BugError(413,'報告の情報が大きすぎます。');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new BugError(400,'送信内容を確認してください。'); }
}
export function acquireDataLock(store) {
  const lockPath = path.join(store.dataDir,'server.lock');
  const token = JSON.stringify({pid:process.pid,id:randomUUID()});
  if (existsSync(lockPath)) {
    let previous;
    try { previous = JSON.parse(readFileSync(lockPath,'utf8')); } catch { throw new Error('保存先のロックを確認してください。'); }
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('保存先のロックが不正です。');
    try { process.kill(previous.pid,0); throw new Error('この保存先を使うサーバーが起動しています。'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(lockPath);
  }
  const descriptor = openSync(lockPath,'wx',0o600);
  try { writeFileSync(descriptor,token); } finally { closeSync(descriptor); }
  return () => { if (existsSync(lockPath) && readFileSync(lockPath,'utf8') === token) unlinkSync(lockPath); };
}
export function recoverIncompleteUploads(store) {
  const rows = store.db.prepare("SELECT id FROM attachments WHERE state='uploading'").all();
  for (const row of rows) {
    for (const partial of [true,false]) {
      const file = store.filePath(row.id,partial);
      if (existsSync(file)) unlinkSync(file);
    }
    store.discardIncomplete(row.id);
  }
  for (const row of store.db.prepare("SELECT id FROM attachments WHERE state='ready'").all()) {
    if (!existsSync(store.filePath(row.id))) store.db.prepare("UPDATE attachments SET state='missing' WHERE id=?").run(row.id);
  }
}
async function upload(request,store,actor,reportId) {
  const length = request.headers['content-length'];
  if (typeof length !== 'string' || !/^\d+$/.test(length)) throw new BugError(411,'ファイル容量を指定してください。');
  let name;
  try { name = decodeURIComponent(request.headers['x-file-name'] || ''); } catch { throw new BugError(400,'ファイル名を確認してください。'); }
  const file = store.reserveAttachment(actor,reportId,{name,size:Number(length),type:request.headers['x-file-type'] || ''});
  const temporary = store.filePath(file.id,true), final = store.filePath(file.id);
  const hash = createHash('sha256'); let received = 0, moved = false;
  try {
    await pipeline(request,new Transform({transform(chunk,encoding,done) {
      received += chunk.length;
      if (received > file.size) { done(new BugError(413,'送信した容量が指定と一致しません。')); return; }
      hash.update(chunk); done(null,chunk);
    }}),createWriteStream(temporary,{flags:'wx',mode:0o600,flush:true}));
    if (received !== file.size) throw new BugError(400,'ファイルの送信が完了していません。');
    store.assertActive(actor);
    await rename(temporary,final); moved = true;
    return store.finishAttachment(file.id,hash.digest('hex'),actor);
  } catch (error) {
    await unlink(moved ? final : temporary).catch(failure => { if (failure.code !== 'ENOENT') throw failure; });
    store.discardIncomplete(file.id);
    throw error;
  }
}
export async function handleBugApi(request,response,store,pathname,worker) {
  if (!pathname.startsWith('/api/bugs/')) return false;
  try {
    if (!store) throw new BugError(503,'保存先と利用者を初期化してからサーバーを起動してください。');
    const origin = 'http://127.0.0.1:' + request.socket.localPort;
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) throw new BugError(403,'この接続元は許可されていません。');
    const actor = requestActor(store,request);
    if (pathname === '/api/bugs/me' && request.method === 'GET') {
      sendJson(response,200,{id:actor.id,name:actor.name,role:actor.role,shared:actor.shared,policy:store.policy,github:{enabled:Boolean(worker),repository:worker?.client.repository||null}}); return true;
    }
    if (pathname === '/api/bugs/reports') {
      if (request.method === 'GET') sendJson(response,200,{reports:store.listReports(actor)});
      else if (request.method === 'POST') {
        const input = await readJson(request);
        store.assertActive(actor);
        const report=store.createReport(actor,input);worker?.wake();sendJson(response,201,{report});
      } else throw new BugError(405,'この操作は利用できません。');
      return true;
    }
    if (pathname === '/api/bugs/uploads' && request.method === 'GET') {
      sendJson(response,200,{attachments:store.pendingUploads(actor)}); return true;
    }
    if (pathname === '/api/bugs/uploads' && request.method === 'POST') {
      sendJson(response,201,{attachment:await upload(request,store,actor,null)}); return true;
    }
    const githubAction=/^\/api\/bugs\/reports\/([0-9a-f-]+)\/github\/(register|reconcile|retry|tags)$/.exec(pathname);
    if(githubAction&&request.method==='POST') {
      if(actor.role!=='admin')throw new BugError(403,'GitHubの登録管理は管理者だけが利用できます。');
      if(!worker)throw new BugError(503,'GitHubの接続先を設定してサーバーを再起動してください。');
      const input=await readJson(request),id=githubAction[1],action=githubAction[2];
      const report=await (action==='register'?worker.register(actor,id):action==='reconcile'?worker.reconcile(actor,id):action==='retry'?worker.retryUnknown(actor,id,input):worker.refreshLabels(actor,id));
      sendJson(response,200,{report});return true;
    }
    const workflowAction=/^\/api\/bugs\/reports\/([0-9a-f-]+)\/(status|confirmations)$/.exec(pathname);
    if(workflowAction&&request.method==='POST') {
      const input=await readJson(request),id=workflowAction[1];
      const result=workflowAction[2]==='status'?{report:store.updateStatus(actor,id,input)}:store.recordConfirmation(actor,id,input);
      sendJson(response,200,result);return true;
    }
    const detail = /^\/api\/bugs\/reports\/([0-9a-f-]+)$/.exec(pathname);
    if (detail && request.method === 'GET') { sendJson(response,200,{report:store.getReport(actor,detail[1])}); return true; }
    const collection = /^\/api\/bugs\/reports\/([0-9a-f-]+)\/attachments$/.exec(pathname);
    if (collection && request.method === 'POST') {
      sendJson(response,201,{attachment:await upload(request,store,actor,collection[1])}); return true;
    }
    const attachment = /^\/api\/bugs\/reports\/([0-9a-f-]+)\/attachments\/([0-9a-f-]+)$/.exec(pathname);
    if (attachment && ['GET','HEAD'].includes(request.method)) {
      const file = store.attachment(actor,attachment[1],attachment[2]);
      const diskPath = store.filePath(file.id);
      let stat;
      try { stat = statSync(diskPath); } catch { throw new BugError(404,'保存したファイルが見つかりません。'); }
      if (!stat.isFile() || stat.size !== file.size) throw new BugError(409,'保存したファイルの内容を確認してください。');
      const encoded = encodeURIComponent(file.name).replace(/[!'()*]/g,character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
      response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':file.size,
        'Content-Disposition':"attachment; filename=\"reproduction-data\"; filename*=UTF-8''" + encoded,
        'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      if (request.method === 'HEAD') response.end();
      else await pipeline(createReadStream(diskPath),response);
      return true;
    }
    throw new BugError(404,'対象の操作が見つかりません。');
  } catch (error) {
    if (response.headersSent) response.destroy();
    else sendJson(response,error instanceof BugError ? error.status : 503,{error:error instanceof BugError ? error.message : '保存処理を完了できませんでした。入力を保持して再試行してください。'});
    return true;
  }
}
