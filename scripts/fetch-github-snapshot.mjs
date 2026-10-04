// Uses an already authorized gh installation; never logs in or asks for a token.
// Offline mode accepts complete REST page arrays exported by an authorized connector.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildSnapshot, repositoryKey } from '../dist/github-snapshot.mjs';

export function collectPages(repository, endpoint, read = route => JSON.parse(execFileSync('gh', ['api', '--method', 'GET', route], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }))) {
  const pages = [];
  for (let page = 1; page <= 50; page++) {
    const data = read(`repos/${repository}/${endpoint}?state=all&per_page=100&sort=updated&direction=desc&page=${page}`);
    if (!Array.isArray(data) || data.length > 100) throw new Error('GitHubのcollection応答を確認してください。');
    pages.push(data);
    if (data.length < 100) return pages;
  }
  throw new Error('取得上限に達しました。全ページを取得できず、ファイルは更新しません。');
}

export async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--repo', '--output', '--from-pages'].includes(args[index]) || !args[index + 1] || Object.hasOwn(options, args[index])) throw new Error('使用法: node scripts/fetch-github-snapshot.mjs --repo owner/repo --output snapshot.json [--from-pages pages.json]');
    options[args[index]] = args[index + 1];
  }
  const repository = options['--repo'], output = options['--output'];
  repositoryKey(`https://github.com/${repository}`);
  if (!output) throw new Error('--outputを指定してください。');
  let issuePages, pullPages, fetchedAt;
  if (options['--from-pages']) {
    const input = JSON.parse(await readFile(options['--from-pages'], 'utf8'));
    ({ issuePages, pullPages, fetchedAt } = input);
    if (input.repositoryUrl?.toLowerCase() !== `https://github.com/${repository}`.toLowerCase()) throw new Error('入力repositoryが一致しません。');
  } else {
    issuePages = collectPages(repository, 'issues');
    pullPages = collectPages(repository, 'pulls');
    fetchedAt = new Date().toISOString();
  }
  const snapshot = buildSnapshot({ repositoryUrl: `https://github.com/${repository}`, fetchedAt, issuePages, pullPages });
  // The destination is created only after every read and validation succeeds.
  // Existing files are never truncated or replaced, including on write failure.
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
  return snapshot;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(snapshot => {
    process.stdout.write(`${snapshot.repositoryUrl}: ${snapshot.items.length}件 / ${snapshot.fetchedAt}\n`);
  }).catch(error => { process.stderr.write(`snapshotを取得できませんでした。${error.message}\n`); process.exitCode = 1; });
}
