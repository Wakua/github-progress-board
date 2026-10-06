import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSnapshot, repositoryKey, MAX_IMPORT_BYTES } from '../dist/github-snapshot.mjs';
import { MAX_LOCAL_REPOSITORIES } from '../dist/local-github.mjs';
import { normalizeRepositoryUrl } from '../dist/workspace.mjs';
import { planningQuery, buildPlanning } from './github-planning-fetch.mjs';

const runFile = promisify(execFile);
// PROGRESS_GITHUB_REPOS はカンマ区切りの owner/repository または https://github.com/owner/repository。
export function parseRepositoryList(value = '') {
  const urls = String(value).split(',').map(item => item.trim()).filter(Boolean)
    .map(item => normalizeRepositoryUrl(/^https?:\/\//.test(item) ? item : `https://github.com/${item}`));
  const keys = urls.map(repositoryKey);
  if (urls.length > MAX_LOCAL_REPOSITORIES) throw new Error(`PROGRESS_GITHUB_REPOSは${MAX_LOCAL_REPOSITORIES}件までです。`);
  if (new Set(keys).size !== keys.length) throw new Error('PROGRESS_GITHUB_REPOSに同じrepositoryが重複しています。');
  return Object.freeze(urls);
}
export const configuredRepositories = (env = process.env) => parseRepositoryList(env.PROGRESS_GITHUB_REPOS);
export class RefreshError extends Error {
  // resetAtは、rate_limitedのときだけ持つ取得再開の時刻（ミリ秒）。
  constructor(code, resetAt) { super(code); this.code = code; if (resetAt !== undefined) this.resetAt = resetAt; }
}
// GraphQLの残りポイントがこの値を下回る間は、リセット時刻まで取得を始めない。
// 同じ認証のghを使う、ほかの作業（`gh pr`・`gh issue`など）の分を残すための下限である。
export const GRAPHQL_RESERVE = 1000;
export function createGithubRefresher({ repositories: urls = configuredRepositories(), run = runFile, now = Date.now, timeoutMs = 90000, commandTimeoutMs = 20000, cacheMs = 15000, reserve = GRAPHQL_RESERVE } = {}) {
  const repositories = new Map(urls.map(url => [repositoryKey(url), url]));
  const cache = new Map();
  // 直近のGraphQL応答が示した、全体の残りポイントとリセット時刻。応答がなければnull。
  let active = null, budget = null;
  const assertBudget = () => { if (budget && budget.remaining < reserve && now() < budget.resetAt) throw new RefreshError('rate_limited', budget.resetAt); };
  async function fetchSnapshot(key) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    let bytes = 0;
    try {
      async function read(args) {
        if (controller.signal.aborted) throw new RefreshError('timeout');
        let stdout;
        try {
          ({ stdout } = await run('gh', ['api', '--hostname', 'github.com', ...args], {
            encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 20 * 1024 * 1024,
            timeout: commandTimeoutMs, killSignal: 'SIGKILL', signal: controller.signal,
            env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
          }));
        } catch (error) {
          throw new RefreshError(controller.signal.aborted || error.killed || error.name === 'AbortError' ? 'timeout' : error.code === 'ENOENT' ? 'gh_unavailable' : 'gh_failed');
        }
        if (controller.signal.aborted) throw new RefreshError('timeout');
        bytes += Buffer.byteLength(stdout);
        if (bytes > 20 * 1024 * 1024) throw new RefreshError('invalid_snapshot');
        return JSON.parse(stdout);
      }
      async function collect(endpoint) {
        const pages = [], sort = endpoint === 'milestones' ? 'due_on&direction=asc' : 'updated&direction=desc';
        for (let page = 1; page <= 50; page++) {
          const route = `repos/${repositories.get(key).slice(19)}/${endpoint}?state=all&per_page=100&sort=${sort}&page=${page}`;
          const data = await read(['--method', 'GET', route]);
          if (!Array.isArray(data) || data.length > 100) throw new RefreshError('invalid_snapshot');
          pages.push(data);
          if (data.length < 100) return pages;
        }
        throw new RefreshError('invalid_snapshot');
      }
      const repositoryUrl = repositories.get(key);
      const issuePages = await collect('issues'), pullPages = await collect('pulls'), milestonePages = await collect('milestones');
      const hierarchyPages = [], cursors = new Set();
      let cursor = null;
      for (let page = 1; page <= 50; page++) {
        // 1ページ目は取得を始める前に確認済み。2ページ目以降は、直前の応答が示した残りで確認する。
        if (page > 1) assertBudget();
        const result = await read(['graphql', '-f', 'query=' + planningQuery(repositoryUrl, cursor)]);
        const limit = result?.data?.rateLimit, resetAt = Date.parse(limit?.resetAt);
        if (Number.isSafeInteger(limit?.remaining) && Number.isFinite(resetAt)) budget = { remaining: limit.remaining, resetAt };
        const info = result?.data?.repository?.issues?.pageInfo;
        if (result.errors?.length || !info || typeof info.hasNextPage !== 'boolean') throw new RefreshError('invalid_snapshot');
        hierarchyPages.push(result);
        if (!info.hasNextPage) break;
        if (page === 50 || typeof info.endCursor !== 'string' || !info.endCursor || cursors.has(info.endCursor)) throw new RefreshError('invalid_snapshot');
        cursors.add(info.endCursor); cursor = info.endCursor;
      }
      const planning = buildPlanning({ repositoryUrl, issuePages, milestonePages, hierarchyPages });
      const snapshot = buildSnapshot({ repositoryUrl, fetchedAt: new Date(now()).toISOString(), issuePages, pullPages, planning });
      if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_IMPORT_BYTES) throw new RefreshError('invalid_snapshot');
      cache.set(key, { snapshot, expires: now() + cacheMs });
      return snapshot;
    } catch (error) { throw error instanceof RefreshError ? error : new RefreshError('invalid_snapshot'); }
    finally { clearTimeout(timer); }
  }
  function refresh(key) {
    if (!repositories.has(key)) return Promise.reject(new RefreshError('forbidden'));
    const cached = cache.get(key);
    if (cached && now() < cached.expires) return Promise.resolve(cached.snapshot);
    if (active) return active.key === key ? active.promise : Promise.reject(new RefreshError('busy'));
    try { assertBudget(); } catch (error) { return Promise.reject(error); }
    const promise = fetchSnapshot(key).finally(() => { active = null; });
    active = { key, promise };
    return promise;
  }
  return { refresh };
}
