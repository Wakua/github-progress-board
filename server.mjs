import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { createGithubRefresher, configuredRepositories } from './scripts/local-github-refresh.mjs';
import { repositoryKey } from './dist/github-snapshot.mjs';

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

export function createProgressServer({ root = defaultRoot, repositories = configuredRepositories(), refresher = createGithubRefresher({ repositories }) } = {}) {
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
      const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) throw failure(403, 'forbidden');
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }).end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      const status = error.status || (error.code === 'busy' ? 429 : error.code === 'timeout' ? 504 : error.code?.startsWith('gh_') || error.code === 'invalid_snapshot' ? 502 : 404);
      if (!res.headersSent) json(status, { error: ['forbidden', 'invalid_request', 'not_found', 'busy', 'timeout', 'gh_unavailable', 'gh_failed', 'invalid_snapshot'].includes(error.code) ? error.code : 'not_found' });
    }
  });
  server.headersTimeout = 10000; server.requestTimeout = 100000;
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
      const server = createProgressServer({ repositories });
      process.stdout.write(`GitHubを自動取得するrepository：${repositories.length ? repositories.join(', ') : 'なし（PROGRESS_GITHUB_REPOSで指定する）'}\n`);
      server.on('error', error => { process.stderr.write(error.code === 'EADDRINUSE' ? `127.0.0.1:${port}は使用中です。既存の起動を確認してください。\n` : 'ローカルサーバーを起動できません。\n'); process.exitCode = 1; });
      server.listen(port, '127.0.0.1', () => process.stdout.write(`Local: http://127.0.0.1:${port}\n`));
    }
  }
}
