import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import worker from '../server/worker.mjs';
import { sqliteD1 } from './cloud-fixtures.mjs';

// Loopback-only QA harness. Simulated identity is NEVER included in the production Worker.
export async function startCloudPreview({ port = 0, filename = ':memory:', mode = 'cloud' } = {}) {
  const DB = sqliteD1(filename, { migrate: filename === ':memory:' || !existsSync(filename) });
  const root = path.resolve(fileURLToPath(new URL(mode === 'cloud' ? '../dist/client/' : '../dist/', import.meta.url)));
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  const assets = { async fetch(request) {
    try {
      const pathname = decodeURIComponent(new URL(request.url).pathname), file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) return new Response('Not found', { status: 404 });
      return new Response(await readFile(file), { headers: { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' } });
    } catch { return new Response('Not found', { status: 404 }); }
  } };
  let origin;
  const server = http.createServer(async (req, res) => {
    try {
      const headers = new Headers(req.headers); headers.delete('oai-authenticated-user-id'); headers.delete('oai-authenticated-user-email');
      const match = /(?:^|;\s*)qa-user=(qa-[a-zA-Z0-9_-]{1,64})(?:;|$)/.exec(req.headers.cookie || '');
      if (match) headers.set('oai-authenticated-user-id', match[1]);
      const buffers = []; for await (const chunk of req) buffers.push(chunk);
      const body = Buffer.concat(buffers);
      const request = new Request(origin + req.url, { method: req.method, headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body, duplex: 'half' } : {}) });
      const response = mode === 'cloud' ? await worker.fetch(request, { DB, ASSETS: assets }) : await assets.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (req.method === 'HEAD') res.end(); else res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end('QA preview unavailable'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, DB, async stop() { await new Promise(resolve => server.close(resolve)); DB.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--port') options.port = Number(args[i + 1]);
    else if (args[i] === '--mode' && ['cloud', 'browser'].includes(args[i + 1])) options.mode = args[i + 1];
    else if (args[i] === '--file') options.filename = args[i + 1];
    else throw new Error('Unknown QA preview argument');
  }
  const preview = await startCloudPreview(options);
  console.log(`QA ONLY: ${preview.origin} — simulated qa-user cookie + local SQLite. Not Sites auth or hosted D1.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await preview.stop(); process.exit(0); });
}
