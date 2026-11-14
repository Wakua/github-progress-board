import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgressServer } from '../server.mjs';
import { TestStore } from '../server/test-store.mjs';
import { fixtureCases } from './support/test-case-fixture.mjs';
import { caseValues } from '../dist/testing/case-editor.mjs';

// 専用の架空データだけを実SQLiteへ保存し、通常の製品ルートを起動する。
const directory = process.argv[2], port = Number(process.argv[3] || 4497);
if (!directory || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('保存先とポートを指定してください。');
const store = new TestStore(directory);
if (!store.load().cases.length) for (const record of fixtureCases) {
  const id = store.newCase().id;
  store.save({ values: { ...caseValues(record), id }, revision: null, requestId: `fixture-${id}` });
}
store.close();
const server = createProgressServer({ root: path.resolve(fileURLToPath(new URL('../dist/', import.meta.url))), repositories: [], testDataDir: directory, dataDir: path.join(directory, 'unused-bugs') });
server.listen(port, '127.0.0.1', () => console.log(`Fictional cases / real SQLite: http://127.0.0.1:${port}/testing/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
