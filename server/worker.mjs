import { handleMcp } from './mcp.mjs';
import { cloudDatabase, MAX_WORKSPACE_BYTES, WorkspaceError } from './cloud-db.mjs';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'Vary': 'oai-authenticated-user-id', 'X-Content-Type-Options': 'nosniff' } });
async function readWriteBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new WorkspaceError('invalid_request', 'JSONの保存内容を確認してください。', 415);
  const limit = MAX_WORKSPACE_BYTES + 4096;
  if (Number(request.headers.get('content-length')) > limit) throw new WorkspaceError('too_large', '保存内容が6MiBを超えています。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new WorkspaceError('invalid_request', '保存内容がありません。', 400);
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new WorkspaceError('too_large', '保存内容が6MiBを超えています。', 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['baseVersion', 'operationId', 'expectedUserId', 'workspace'].includes(key)) ||
        !Number.isSafeInteger(body.baseVersion) || body.baseVersion < 0 || body.baseVersion >= Number.MAX_SAFE_INTEGER ||
        typeof body.operationId !== 'string' || !/^[a-zA-Z0-9_-]{16,120}$/.test(body.operationId) ||
        typeof body.expectedUserId !== 'string' || body.expectedUserId.length > 256 || !body.workspace) throw new Error('Invalid write envelope');
    return body;
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError('invalid_request', '保存内容・バージョンを確認してください。', 400);
  } finally { reader.releaseLock(); }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/mcp') return handleMcp(request, env);
    // Trust boundary: production requests must arrive only through Sites dispatch.
    // A bare incoming header is not independently authenticated by this Worker.
    // Verify dispatch replaces forged headers and no direct Worker origin is exposed before publishing.
    const userId = request.headers.get('oai-authenticated-user-id');
    if (!userId || !userId.trim() || userId.length > 256) {
      if (!url.pathname.startsWith('/api/') && request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html')) {
        return Response.redirect(`${url.origin}/signin-with-chatgpt?return_to=%2F`, 302);
      }
      return json({ code: 'authentication_required', error: 'ChatGPTへのログインを確認してください。編集を停止しています。' }, 401);
    }
    if (!url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(request.method)) return json({ code: 'method_not_allowed', error: 'この操作は利用できません。' }, 405);
      if (!env.ASSETS?.fetch) return json({ code: 'assets_unavailable', error: '画面を読み込めません。' }, 503);
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers); headers.set('Cache-Control', 'no-store'); headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(asset.body, { status: asset.status, headers });
    }
    try {
      if (url.search) throw new WorkspaceError('invalid_request', '保存先はログインしたアカウントで決まります。', 400);
      const db = cloudDatabase(env.DB);
      if (url.pathname === '/api/workspace' && request.method === 'GET') return json(await db.load(userId));
      if (url.pathname === '/api/workspace/backup' && request.method === 'GET') return json(await db.backup(userId));
      if (url.pathname === '/api/workspace' && request.method === 'PUT') {
        if (request.headers.get('origin') !== url.origin || request.headers.get('x-progress-write') !== '1' ||
            ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site'))) {
          throw new WorkspaceError('origin_rejected', 'このサイトの画面から保存してください。', 403);
        }
        const body = await readWriteBody(request);
        if (body.expectedUserId !== userId) throw new WorkspaceError('account_changed', 'ログインしたアカウントが変わりました。保存を停止しました。', 401);
        return json(await db.save(userId, body));
      }
      return json({ code: 'not_found', error: 'この操作は利用できません。' }, 404);
    } catch (error) {
      if (error instanceof WorkspaceError) return json({ code: error.code, error: error.message }, error.status);
      console.error('progress-tool storage failure', error?.name || 'Error');
      return json({ code: 'storage_unavailable', error: 'クラウド保存に接続できません。保存結果を確認するまで編集を停止します。' }, 503);
    }
  }
};
