import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BugStore, initialPolicy, validatePolicy } from '../server/bug-store.mjs';

const args = process.argv.slice(2), command = args.shift();
const options = {};
for (let index=0; index<args.length; index+=2) {
  if (!args[index]?.startsWith('--') || !args[index+1]) throw new Error('引数を確認してください。');
  options[args[index].slice(2)] = args[index+1];
}
const dataDir = path.resolve(options['data-dir'] || process.env.BUG_REPORTING_DATA_DIR || '.bug-reporting-data');
const publicDir = fileURLToPath(new URL('../dist/',import.meta.url));
const isPublic = location => { const relative=path.relative(publicDir,location); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
let store;
try {
  if (isPublic(dataDir)) throw new Error('保存先は配信フォルダーdistの外に置いてください。');
  if (command === 'init') {
    if (existsSync(path.join(dataDir,'reports.sqlite'))) throw new Error('保存先は初期化済みです。');
    const policy = validatePolicy({maxBytes:Number(options['max-bytes'] || initialPolicy.maxBytes),maxFiles:Number(options['max-files'] || initialPolicy.maxFiles)});
    store = new BugStore(dataDir,{initialize:true,policy});
    store.sharedActor();process.stdout.write('報告の保存先を初期化しました。\n');
  } else {
    store = new BugStore(dataDir);
    if (command === 'set-policy') {
      const policy = validatePolicy({maxBytes:Number(options['max-bytes']),maxFiles:Number(options['max-files'])});
      store.db.prepare('UPDATE policy SET max_bytes=?,max_files=? WHERE id=1').run(policy.maxBytes,policy.maxFiles);
      process.stdout.write('容量と件数の設定を更新しました。既存ファイルは保持しています。\n');
    } else throw new Error('init、set-policyを指定してください。');
  }
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode=1; }
finally { store?.close(); }
