import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { createGithubRefresher, configuredRepositories } from './scripts/local-github-refresh.mjs';
import { repositoryKey } from './dist/github-snapshot.mjs';
import { BugStore } from './server/bug-store.mjs';
import { handleBugApi, acquireDataLock, recoverIncompleteUploads } from './server/bug-api.mjs';
import { GitHubClient, parseBugRepository } from './server/bug-github-client.mjs';
import { GitHubWorker } from './server/bug-github-worker.mjs';

const defaultRoot = path.resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const failure = (status, code) => Object.assign(new Error(code), { status, code });
async function readRequest(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw failure(415, 'invalid_request');
  if (Number(req.headers['content-length']) > 256) throw failure(413, 'invalid_request');
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const timer = setTimeout(() => finish(failure(408, 'timeout')), 5000);
    function finish(error, value) {
      clearTimeout(timer); req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onError);
      req.resume(); error ? reject(error) : resolve(value);
    }
    function onData(chunk) { size += chunk.length; if (size > 256) finish(failure(413, 'invalid_request')); else chunks.push(chunk); }
    function onError() { finish(failure(400, 'invalid_request')); }
    function onEnd() { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(failure(400, 'invalid_request')); } }
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError);
  });
}

export function createProgressServer({ root = defaultRoot, repositories = configuredRepositories(), refresher = createGithubRefresher({ repositories }), dataDir = process.env.BUG_REPORTING_DATA_DIR || path.resolve('.bug-reporting-data'), githubRepository = process.env.BUG_REPORTING_GITHUB_REPO || null, githubClient } = {}) {
  const bugRepository = parseBugRepository(githubRepository);
  const relative = path.relative(root, path.resolve(dataDir));
  if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('報告の保存先はdistの外に置いてください。');
  if (githubClient && bugRepository && githubClient.repository !== bugRepository) throw new Error('GitHubの接続先が設定と一致しません。');
  let store, release, worker;
  if (existsSync(path.join(dataDir, 'reports.sqlite'))) {
    store = new BugStore(dataDir);
    try {
      release = acquireDataLock(store); recoverIncompleteUploads(store);
      if (githubClient || bugRepository) worker = new GitHubWorker(store, githubClient || new GitHubClient(bugRepository));
    } catch (error) { release?.(); store.close(); throw error; }
  }
  const allowed = new Set(repositories.map(repositoryKey));
  const csrfToken = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    try {
      const port = server.address()?.port;
      const host = req.headers.host;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) throw failure(403, 'forbidden');
      const origin = `http://${host}`, url = new URL(req.url, origin);
      if (url.origin !== origin) throw failure(403, 'forbidden');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/api/bugs/')) {
        if (url.search || url.hash || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw failure(403, 'forbidden');
        await handleBugApi(req, res, store, pathname, worker); return;
      }
      if (pathname.startsWith('/api/')) {
        if (url.search || url.hash || req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw failure(403, 'forbidden');
        if (pathname === '/api/local-github') {
          if (req.method !== 'GET') throw failure(405, 'invalid_request');
          if (req.headers['x-progress-client'] !== '1') throw failure(403, 'forbidden');
          json(200, { schemaVersion: 1, repositories, csrfToken }); return;
        }
        if (pathname === '/api/github/refresh') {
          if (req.method !== 'POST') throw failure(405, 'invalid_request');
          const token = req.headers['x-progress-csrf'];
          if (req.headers.origin !== origin || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken))) throw failure(403, 'forbidden');
          const body = await readRequest(req);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !allowed.has(body.repository)) throw failure(400, 'invalid_request');
          const snapshot = await refresher.refresh(body.repository);
          json(200, snapshot); return;
        }
        throw failure(404, 'not_found');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw failure(405, 'invalid_request');
      const location = pathname === '/bugs' || pathname === '/bugs/' ? '/bugs/index.html' : pathname === '/' ? '/index.html' : pathname;
      const file = path.resolve(root, `.${location}`);
      if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) throw failure(403, 'forbidden');
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }).end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      const status = error.status || (error.code === 'busy' || error.code === 'rate_limited' ? 429 : error.code === 'timeout' ? 504 : error.code?.startsWith('gh_') || error.code === 'invalid_snapshot' ? 502 : 404);
      if (!res.headersSent) json(status, {
        error: ['forbidden', 'invalid_request', 'not_found', 'busy', 'rate_limited', 'timeout', 'gh_unavailable', 'gh_failed', 'invalid_snapshot'].includes(error.code) ? error.code : 'not_found',
        // 取得を再開できる時刻。ブラウザが止めている理由と一緒に表示する。
        ...(error.code === 'rate_limited' && Number.isFinite(error.resetAt) ? { resetAt: new Date(error.resetAt).toISOString() } : {}),
      });
    }
  });
  server.headersTimeout = 10000; server.requestTimeout = store ? 0 : 100000;
  server.once('listening', () => { if (worker) { worker.origin = 'http://127.0.0.1:' + server.address().port; worker.wakeIfPending(); } });
  let resolveBugClosed;
  server.bugClosed = new Promise(resolve => { resolveBugClosed = resolve; });
  server.once('close', () => {
    const close = () => { release?.(); store?.close(); resolveBugClosed(); };
    if (worker) worker.stop().then(close, close); else close();
  });
  server.bugWorker = worker; server.bugStore = store;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.env.PORT === undefined ? 4319 : Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`PORTは1〜65535の整数で指定してください：${process.env.PORT}\n`); process.exitCode = 1;
  } else {
    let repositories = null;
    try { repositories = configuredRepositories(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
    if (repositories) {
      let server;
      try { server = createProgressServer({ repositories }); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
      if (server) {
        process.stdout.write(`GitHubを自動取得するrepository：${repositories.length ? repositories.join(', ') : 'なし（PROGRESS_GITHUB_REPOSで指定する）'}\n`);
        server.on('error', error => { process.stderr.write(error.code === 'EADDRINUSE' ? `127.0.0.1:${port}は使用中です。既存の起動を確認してください。\n` : 'ローカルサーバーを起動できません。\n'); server.close(); process.exitCode = 1; });
        server.listen(port, '127.0.0.1', () => process.stdout.write(`Local: http://127.0.0.1:${port}\n`));
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
      }
    }
  }
}
