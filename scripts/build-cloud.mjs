import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await rm(path.join(root, 'dist/client'), { recursive: true, force: true });
await rm(path.join(root, 'dist/server'), { recursive: true, force: true });
await mkdir(path.join(root, 'dist/client'), { recursive: true });
await mkdir(path.join(root, 'dist/server'), { recursive: true });
for (const entry of await readdir(path.join(root, 'dist'), { withFileTypes: true })) {
  if (entry.isFile() && /\.(html|css|mjs|json)$/.test(entry.name) && entry.name !== 'data.json') await cp(path.join(root, 'dist', entry.name), path.join(root, 'dist/client', entry.name));
}
// Preserve the reviewed snapshot exactly; serve it only behind the Worker auth boundary.
await cp(path.join(root, 'samples/prepared-workspace.json'), path.join(root, 'dist/client/prepared-workspace.json'));
const index = await readFile(path.join(root, 'dist/index.html'), 'utf8');
await writeFile(path.join(root, 'dist/client/index.html'), index.replace('<html lang="ja">', '<html lang="ja" data-storage-mode="cloud">'));
await build({ entryPoints: [path.join(root, 'server/worker.mjs')], outfile: path.join(root, 'dist/server/index.js'), bundle: true, platform: 'browser', target: 'es2022', format: 'esm' });
// Logical resources are provisioned by Sites; no physical D1 IDs or credentials belong in source.
await writeFile(path.join(root, 'dist/server/wrangler.json'), JSON.stringify({ name: 'progress-tool', main: 'index.js', compatibility_date: '2026-10-03', workers_dev: false, preview_urls: false, assets: { directory: '../client', binding: 'ASSETS', run_worker_first: true } }, null, 2));
await cp(path.join(root, 'drizzle'), path.join(root, 'dist/server/drizzle'), { recursive: true });
console.log('Built existing progress-tool UI and shared-storage Worker. Sites supplies identity, DB binding and migrations during supported publication.');
