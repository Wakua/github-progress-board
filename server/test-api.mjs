import { TestStoreError } from './test-store.mjs';

function readJson(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw new TestStoreError(415, 'invalid_request');
  if (Number(req.headers['content-length']) > 262144) throw new TestStoreError(413, 'invalid_request');
  return new Promise((resolve, reject) => {
    let size = 0, done = false; const chunks = [];
    const timer = setTimeout(() => finish(new TestStoreError(408, 'invalid_request')), 5000);
    function finish(error, value) {
      if (done) return; done = true; clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', fail);
      req.resume(); error ? reject(error) : resolve(value);
    }
    function data(chunk) { size += chunk.length; if (size > 262144) finish(new TestStoreError(413, 'invalid_request')); else chunks.push(chunk); }
    function fail() { finish(new TestStoreError(400, 'invalid_request')); }
    function end() { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(); } }
    req.on('data', data); req.on('end', end); req.on('error', fail); req.on('aborted', fail);
  });
}

export async function handleTestApi(req, res, pathname, getStore) {
  const send = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  try {
    if (req.headers['x-test-client'] !== '1' || req.method !== 'GET' && req.headers.origin !== `http://${req.headers.host}`) throw new TestStoreError(403, 'forbidden');
    if (pathname === '/api/testing/cases' && req.method === 'GET') { send(200, getStore().load()); return; }
    if (pathname === '/api/testing/case-ids' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) throw new TestStoreError(400, 'invalid_request');
      send(201, getStore().newCase()); return;
    }
    if (pathname === '/api/testing/cases' && req.method === 'PUT') { const body = await readJson(req); send(200, getStore().save(body)); return; }
    throw new TestStoreError(['/api/testing/cases','/api/testing/case-ids'].includes(pathname) ? 405 : 404, 'invalid_request');
  } catch (error) {
    if (!res.headersSent && !res.destroyed) send(error instanceof TestStoreError ? error.status : 503,
      { error: error instanceof TestStoreError ? error.code : 'store_unavailable', ...(error.current ? { current: error.current } : {}) });
  }
}
