import { attachSnapshot, repositoryKey, validateSnapshot, MAX_IMPORT_BYTES } from './github-snapshot.mjs';

// The browser selects a registered project, never an arbitrary gh command/repo.
// 自動取得してよいrepositoryは、ローカルサーバーの設定（PROGRESS_GITHUB_REPOS）から受け取る。既定は空。
export const MAX_LOCAL_REPOSITORIES = 50;
// normalizeRepositoryUrlはURLを500文字まで許可する。JSONの区切りとCSRFも含める。
const MAX_CONFIG_BYTES = MAX_LOCAL_REPOSITORIES * 512 + 256;
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let localRepositories = Object.freeze([]), allowed = new Set();
export const getLocalRepositories = () => localRepositories;
export function setLocalRepositories(urls) {
  if (!Array.isArray(urls) || urls.length > MAX_LOCAL_REPOSITORIES) throw new Error('自動取得するrepositoryの一覧を確認してください。');
  const keys = urls.map(repositoryKey);
  if (new Set(keys).size !== keys.length) throw new Error('自動取得するrepositoryが重複しています。');
  localRepositories = Object.freeze([...urls]); allowed = new Set(keys);
}
const repositoryKeyOrNull = url => { try { return repositoryKey(url); } catch { return null; } };
export const localRepositoryKey = url => { const key = url && repositoryKeyOrNull(url); return key && allowed.has(key) ? key : null; };
export const isLocalRuntime = location => location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname);
export function refreshTargets(workspace, key) {
  return workspace.projects.filter(project => localRepositoryKey(project.repositoryUrl) === key).map(project => project.id);
}
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};

// Called on a cloned workspace inside the existing storage lock/transaction.
// A coalesced server response is a no-op if that exact snapshot is already saved.
export function applyRefreshedSnapshot(workspace, snapshot, targets) {
  validateSnapshot(snapshot);
  if (Object.hasOwn(snapshot, 'projectId') || !localRepositoryKey(snapshot.repositoryUrl) || !Array.isArray(targets) || new Set(targets).size !== targets.length) throw new Error('自動更新の取込先を確認してください。');
  const key = repositoryKey(snapshot.repositoryUrl);
  const projects = targets.map(id => {
    const project = workspace.projects.find(project => project.id === id);
    if (!project || localRepositoryKey(project.repositoryUrl) !== key) throw new Error('自動更新のrepositoryとプロジェクトが一致しません。');
    return project;
  });
  const updates = projects.map(project => {
    if (project.githubSnapshot?.fetchedAt === snapshot.fetchedAt) {
      const { projectId, ...previous } = project.githubSnapshot;
      if (JSON.stringify(canonical(previous)) === JSON.stringify(canonical(snapshot))) return null;
    }
    const copy = structuredClone(project);
    attachSnapshot(copy, snapshot);
    return copy.githubSnapshot;
  });
  updates.forEach((snapshot, index) => { if (snapshot) projects[index].githubSnapshot = snapshot; });
  return updates.filter(Boolean).length;
}

const messages = {
  gh_unavailable: 'ghを起動できません。Nodeと同じ環境の既存ghを確認してください。',
  gh_failed: 'GitHubを取得できません。既存ghの認証とrepositoryの読み取り許可を確認してください。',
  timeout: 'GitHub取得が時間内に完了しませんでした。',
  busy: '別repositoryを取得中です。次回の自動更新または再取得を待ってください。',
  rate_limited: 'GitHubのAPIの残りが少ないため、取得を止めています。',
  invalid_snapshot: '全ページの整合性を確認できず、更新を見送りました。',
  forbidden: 'ローカル接続を確認するため、ページを再読み込みしてください。',
};
// 取得を止めているときは、再開できる時刻が分かれば示す。
function failureMessage(value) {
  const resetAt = value.error === 'rate_limited' ? Date.parse(value.resetAt) : NaN;
  if (Number.isFinite(resetAt)) return `GitHubのAPIの残りが少ないため、${new Date(resetAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}まで取得を止めています。`;
  return messages[value.error] || 'ローカル取得に失敗しました。';
}

export function createLocalGithubClient({ fetchImpl = fetch, getWorkspace, canRefresh, saveSnapshot, onState = () => {}, now = Date.now, timeoutMs = 95000 }) {
  let config = null, connecting = null, running = null, pending = null;
  const states = new Map(), attempts = new Map();
  const state = key => ({ available: !!config, ...(states.get(key) || { phase: 'idle' }) });
  const publish = (key, value) => { states.set(key, value); onState(); };
  async function request(url, options, limit, timeout) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
      let length = 0;
      const reader = response.body.getReader(), chunks = [];
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > limit) throw new Error('応答サイズが上限を超えました。');
          chunks.push(value);
        }
      } catch (error) { await reader.cancel(); throw error; }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (!response.ok) throw new Error(failureMessage(value));
      return value;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(messages.timeout);
      throw error;
    } finally { clearTimeout(timer); }
  }
  function connect() {
    if (config) return Promise.resolve(true);
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        const value = await request('/api/local-github', { headers: { 'X-Progress-Client': '1' } }, MAX_CONFIG_BYTES, 5000);
        if (value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.csrfToken)) return false;
        setLocalRepositories(value.repositories);
        config = value; onState(); return true;
      } catch { return false; }
      finally { connecting = null; }
    })();
    return connecting;
  }
  function refresh({ force = false } = {}) {
    if (running) {
      pending ||= { force: false, fresh: new Set() };
      pending.force ||= force;
      return running;
    }
    if (!config || !canRefresh()) return Promise.resolve();
    let finished = false;
    const cycle = (async () => {
      // Keys fetched after the queued request arrived already satisfy it.
      let fresh = new Set();
      try {
        for (;;) {
          const keys = [...new Set(getWorkspace().projects.map(project => localRepositoryKey(project.repositoryUrl)).filter(Boolean))];
          for (const key of keys) {
            if (!canRefresh()) break;
            const targets = refreshTargets(getWorkspace(), key), signature = JSON.stringify(targets.slice().sort());
            if (!targets.length) continue;
            const attempt = attempts.get(key);
            if (attempt?.signature === signature && (fresh.has(key) || (!force && now() < attempt.nextAt))) continue;
            attempts.set(key, { signature, nextAt: now() + REFRESH_INTERVAL_MS });
            publish(key, { phase: 'loading' });
            const requested = pending;
            try {
              const snapshot = await request('/api/github/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Progress-CSRF': config.csrfToken }, body: JSON.stringify({ repository: key }) }, MAX_IMPORT_BYTES, timeoutMs);
              validateSnapshot(snapshot);
              if (repositoryKey(snapshot.repositoryUrl) !== key || Object.hasOwn(snapshot, 'projectId')) throw new Error('応答repositoryが一致しません。');
              const count = canRefresh() ? await saveSnapshot(snapshot, targets) : null;
              publish(key, count === null ? { phase: 'deferred', message: '保存を見送りました。編集完了後に再取得してください。' } : { phase: 'updated', fetchedAt: snapshot.fetchedAt });
              if (count !== null) requested?.fresh.add(key);
            } catch (error) { publish(key, { phase: 'error', message: `更新できません。${error.message} 保存済みのデータを保持しています。` }); }
          }
          if (!pending || !canRefresh()) break;
          ({ force, fresh } = pending); pending = null;
        }
      } finally {
        // Clear synchronously so a request arriving after the last pass starts a new cycle.
        finished = true; running = null; pending = null;
      }
    })();
    if (!finished) running = cycle;
    return cycle;
  }
  return { connect, refresh, state };
}
