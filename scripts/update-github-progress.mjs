import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createProgressClient } from './github-progress-client.mjs';
import { setupProgress, updateProgress } from './github-progress-update.mjs';

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, strict: true, options: {
    'project-id': { type: 'string' }, repo: { type: 'string' }, setup: { type: 'boolean' }, apply: { type: 'boolean' },
    issue: { type: 'string' }, actor: { type: 'string' }, operation: { type: 'string' }, progress: { type: 'string' },
    'expected-progress': { type: 'string' }, estimate: { type: 'string' }, 'expected-estimate': { type: 'string' },
    'reason-file': { type: 'string' }, 'confirm-unstarted': { type: 'boolean' },
  } });
  const client = createProgressClient({ projectId: values['project-id'], repository: values.repo });
  if (values.setup) {
    if (Object.keys(values).some(key => !['project-id', 'repo', 'setup', 'apply'].includes(key))) throw new Error('フィールド作成とIssue更新は別々に実行してください。');
    return setupProgress(client, { apply: values.apply });
  }
  const numeric = (value, optional = false) => {
    if (value === undefined && optional) return undefined;
    if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) throw new Error('数値引数がありません。未入力の変更前値には unset を指定してください。');
    return Number(value);
  };
  const previous = value => value === 'unset' ? null : numeric(value);
  if (!values['reason-file']) throw new Error('--reason-fileを指定してください。');
  return updateProgress(client, {
    issue: numeric(values.issue), actor: values.actor, operation: values.operation, progress: numeric(values.progress),
    expectedProgress: previous(values['expected-progress']), expectedEstimate: previous(values['expected-estimate']),
    estimate: numeric(values.estimate, true), reason: readFileSync(values['reason-file'], 'utf8'),
    confirmUnstarted: values['confirm-unstarted'] === true,
  }, { apply: values.apply });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
