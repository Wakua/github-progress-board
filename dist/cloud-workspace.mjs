import { emptyWorkspace, validateWorkspace, STORAGE_KEY, BACKUP_KEY, RECOVERY_KEY, findProject } from './workspace.mjs';

export const MAX_CLOUD_BYTES = 6 * 1024 * 1024;
const preferenceKey = userId => `progress-tool.selection.${userId}`;
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function planWorkspaceMigration(current, incoming) {
  validateWorkspace(current); validateWorkspace(incoming);
  const next = structuredClone(current), added = [], skipped = [];
  for (const project of incoming.projects) {
    const existing = current.projects.find(item => item.id === project.id);
    if (existing) {
      if (canonical(existing) !== canonical(project)) throw new Error(`同じプロジェクトIDの異なるデータがあります：${project.name}。両方を書き出し、内容を確認してください。既存データは上書きしません。`);
      skipped.push(project.id);
    } else { next.projects.push(structuredClone(project)); added.push(project.id); }
  }
  if (!current.projects.length) next.selectedProjectId = incoming.selectedProjectId;
  validateWorkspace(next);
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_CLOUD_BYTES) throw new Error('移行後の全データは6MiB以下にしてください。');
  return { workspace: next, added, skipped };
}
export function readLocalMigration(storage) {
  const { primary, backup, recovery } = readLocalBackup(storage);
  if (primary === null) throw new Error('このブラウザに移行元データがありません。以前のURLで書き出したJSONを読み込んでください。');
  // A corrupt primary is exported intact, never silently replaced with its backup.
  const workspace = validateWorkspace(JSON.parse(primary));
  return { workspace: structuredClone(workspace), raw: { primary, backup, recovery } };
}
export function readLocalBackup(storage) {
  return { primary: storage.getItem(STORAGE_KEY), backup: storage.getItem(BACKUP_KEY), recovery: storage.getItem(RECOVERY_KEY) };
}
export function createCloudWorkspaceStore(fetcher, { storage = null, makeId = () => crypto.randomUUID(), timeoutMs = 15000 } = {}) {
  let workspace = emptyWorkspace(), loaded = false, readOnly = true, problem = 'クラウドのデータを読み込んでいます。編集は読込完了後に行えます。';
  let userId = null, version = null, updatedAt = null, pending = null, saving = false;
  async function request(path, options = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(path, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
      let body;
      try { body = await response.json(); } catch { throw new Error('クラウドの応答を確認できません。'); }
      if (!response.ok) throw new Error(body?.error || 'クラウド保存を利用できません。');
      return body;
    } finally { clearTimeout(timer); }
  }
  function checkedRecord(record) {
    if (!record || typeof record.userId !== 'string' || !record.userId || !Number.isSafeInteger(record.version) || record.version < 0 ||
        (record.version === 0 ? record.updatedAt !== null : !Number.isFinite(Date.parse(record.updatedAt)))) throw new Error('クラウドの保存状態を検証できません。');
    if (userId !== null && record.userId !== userId) throw new Error('ログインしたアカウントが変わりました。');
    validateWorkspace(record.workspace);
    if (record.version === 0 && record.workspace.projects.length) throw new Error('未保存データを保存済みとして表示できません。');
    return record;
  }
  function rememberSelection(projectId) {
    if (projectId !== null) findProject(workspace, projectId);
    workspace.selectedProjectId = projectId;
    try { storage?.setItem(preferenceKey(userId), projectId || ''); } catch { /* cloud progress remains durable without local preferences */ }
  }
  async function initialize() {
    // Never replace a visible document or pending edits with an unannounced refresh.
    if (loaded) throw new Error('最新データは変更候補を退避してから再読み込みしてください。');
    try {
      const record = checkedRecord(await request('/api/workspace'));
      userId = record.userId; version = record.version; updatedAt = record.updatedAt;
      workspace = structuredClone(record.workspace);
      try {
        const preferred = storage?.getItem(preferenceKey(userId));
        if (preferred !== null && preferred !== undefined && (!preferred || workspace.projects.some(project => project.id === preferred))) workspace.selectedProjectId = preferred || null;
      } catch { /* preferences do not gate authenticated progress */ }
      loaded = true; readOnly = false; problem = '';
    } catch (error) { readOnly = true; problem = `クラウドのデータを読み込めません。自動で空データを保存せず、編集を停止しています。${error.message}`; }
  }
  async function transact(action) {
    if (readOnly || !loaded) throw new Error(problem);
    if (saving) throw new Error('保存中です。完了を待ってから変更してください。');
    const draft = structuredClone(workspace);
    action(draft); validateWorkspace(draft);
    const selection = draft.selectedProjectId;
    const cloudDraft = { ...draft, selectedProjectId: null };
    if (new TextEncoder().encode(JSON.stringify(cloudDraft)).byteLength > MAX_CLOUD_BYTES) throw new Error('全プロジェクト合計6MiB以下にしてください。変更は保存していません。');
    pending = { baseVersion: version, expectedUserId: userId, operationId: makeId(), workspace: cloudDraft };
    saving = true;
    try {
      const record = checkedRecord(await request('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Progress-Write': '1' }, body: JSON.stringify(pending) }));
      if (record.version !== version + 1 || canonical(record.workspace) !== canonical(cloudDraft)) throw new Error('保存内容と応答が一致しません。');
      workspace = structuredClone(record.workspace); version = record.version; updatedAt = record.updatedAt;
      rememberSelection(selection); pending = null; problem = '';
    } catch (error) {
      readOnly = true;
      problem = `保存結果を確認するまで編集を停止します。表示は最後に確認したデータです。変更候補を退避し、再読み込みしてください。${error.message}`;
      throw new Error(problem);
    } finally { saving = false; }
  }
  return {
    initialize, transact, select: rememberSelection,
    snapshot: () => structuredClone(workspace),
    status: () => ({ mode: 'cloud', loaded, readOnly, problem, hasBackup: false, hasPending: pending !== null, version, updatedAt }),
    localMigration: () => readLocalMigration(storage),
    localRaw: () => readLocalBackup(storage),
    migrationPlan: incoming => planWorkspaceMigration(workspace, incoming),
    markStale() { /* browser progress keys are only legacy data in cloud mode */ },
    async raw() {
      const result = { type: 'progress-cloud-diagnostic', schemaVersion: 1, exportedAt: new Date().toISOString(), confirmed: loaded ? { userId, version, updatedAt, workspace: structuredClone(workspace) } : null, pending: structuredClone(pending) };
      try { result.legacyBrowserData = readLocalBackup(storage); } catch (error) { result.legacyBrowserError = error.message; }
      try {
        const server = await request('/api/workspace/backup');
        if (userId !== null && server.userId !== userId) throw new Error('アカウントが変わりました。');
        result.serverBackup = server;
      } catch (error) { result.backupError = error.message; }
      // Even offline, unconfirmed input can be exported; never claim it is server data.
      return result;
    }
  };
}
