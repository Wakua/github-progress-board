import http from 'node:http';
import { readFile } from 'node:fs/promises';

// Only serve the fictional prototype and its calculation modules, never a workspace snapshot.
const files = new Map([
  '/docs/prototypes/milestone-gantt.html',
  '/docs/prototypes/milestone-gantt.mjs',
  '/docs/prototypes/milestone-gantt-samples.mjs',
  '/docs/prototypes/milestone-gantt-view.mjs',
  '/dist/milestone-schedule.mjs',
  '/dist/milestone-schedule-math.mjs',
].map(path => [path, new URL(`..${path}`, import.meta.url)]));
const port = Number(process.env.PORT || 4397);
http.createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') { response.writeHead(302, { Location: '/docs/prototypes/milestone-gantt.html' }); response.end(); return; }
  if (!files.has(path)) { response.writeHead(404); response.end('Not found'); return; }
  try {
    const bytes = await readFile(files.get(path));
    response.writeHead(200, { 'Content-Type': path.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(bytes);
  } catch { response.writeHead(500); response.end('Read failed'); }
}).listen(port, '127.0.0.1', () => console.log(`Gantt prototype: http://127.0.0.1:${port}/`));
