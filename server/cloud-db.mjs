import { emptyWorkspace, validateWorkspace } from '../dist/workspace.mjs';

export const MAX_WORKSPACE_BYTES = 6 * 1024 * 1024;
const CHUNK_CHARACTERS = 256 * 1024;
export class WorkspaceError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
const corrupt = () => new WorkspaceError('data_corrupt', 'クラウドの保存データを検証できません。上書きを停止しました。保存データを退避してください。');
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function serializeWorkspace(workspace) {
  try { validateWorkspace(workspace); }
  catch { throw new WorkspaceError('invalid_workspace', 'プロジェクト・所属・参照を検証できません。変更は保存していません。', 422); }
  // Display selection is a device preference, never a competing cloud write.
  const payload = JSON.stringify({ ...workspace, selectedProjectId: null });
  if (new TextEncoder().encode(payload).byteLength > MAX_WORKSPACE_BYTES) {
    throw new WorkspaceError('too_large', 'クラウド保存は全プロジェクト合計6MiB以下です。変更を退避し、データ量を確認してください。', 413);
  }
  return payload;
}
export function splitPayload(payload) {
  const chunks = [];
  for (let start = 0; start < payload.length;) {
    let end = Math.min(start + CHUNK_CHARACTERS, payload.length);
    const last = payload.charCodeAt(end - 1), next = payload.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    chunks.push(payload.slice(start, end)); start = end;
  }
  return chunks;
}
function checkedHead(head) {
  if (!Number.isSafeInteger(head.version) || head.version < 1 || !Number.isInteger(head.chunk_count) || head.chunk_count < 1 || head.chunk_count > 25 ||
      !Number.isFinite(Date.parse(head.updated_at)) || !/^[a-f0-9]{64}$/.test(head.digest)) throw corrupt();
  return head;
}
function envelope(userId, head, workspace) {
  return { userId, version: head?.version || 0, updatedAt: head?.updated_at || null, workspace };
}
export function cloudDatabase(DB) {
  if (!DB?.prepare || !DB?.batch) throw new WorkspaceError('storage_unavailable', 'クラウド保存を利用できません。編集を停止しています。', 503);
  async function readCurrent(userId) {
    const result = await DB.batch([
      DB.prepare('SELECT * FROM progress_workspaces WHERE user_id = ?').bind(userId),
      DB.prepare('SELECT part, payload FROM progress_workspace_chunks WHERE user_id = ? AND version = (SELECT version FROM progress_workspaces WHERE user_id = ?) ORDER BY part').bind(userId, userId),
      DB.prepare('SELECT EXISTS(SELECT 1 FROM progress_workspace_versions WHERE user_id = ?) OR EXISTS(SELECT 1 FROM progress_workspace_chunks WHERE user_id = ?) AS has_history').bind(userId, userId)
    ]);
    if (!result[0].results.length && result[2].results[0].has_history) throw corrupt();
    return { head: result[0].results[0] || null, chunks: result[1].results };
  }
  async function payloadFor(head, results) {
    checkedHead(head);
    if (results.length !== head.chunk_count || results.some((chunk, index) => chunk.part !== index || typeof chunk.payload !== 'string')) throw corrupt();
    const payload = results.map(chunk => chunk.payload).join('');
    if (new TextEncoder().encode(payload).byteLength > MAX_WORKSPACE_BYTES || await digest(payload) !== head.digest) throw corrupt();
    return payload;
  }
  async function load(userId) {
    const { head, chunks } = await readCurrent(userId);
    if (!head) return envelope(userId, null, emptyWorkspace());
    const payload = await payloadFor(head, chunks);
    let workspace;
    try { workspace = validateWorkspace(JSON.parse(payload)); } catch { throw corrupt(); }
    return envelope(userId, head, workspace);
  }
  async function save(userId, { baseVersion, operationId, workspace }) {
    const payload = serializeWorkspace(workspace), checksum = await digest(payload);
    const { head: current, chunks: currentChunks } = await readCurrent(userId);
    if (current) {
      checkedHead(current);
      // Existing corruption must not become an automatic replacement.
      const existing = await payloadFor(current, currentChunks);
      try { validateWorkspace(JSON.parse(existing)); } catch { throw corrupt(); }
      if (current.last_write_id === operationId && current.version === baseVersion + 1) {
        if (current.digest === checksum) return envelope(userId, current, JSON.parse(existing));
        throw new WorkspaceError('version_conflict', '同じ保存操作IDに異なる内容があります。保存済みデータを保持し、変更候補を退避してください。');
      }
    }
    const chunks = splitPayload(payload), version = baseVersion + 1, updatedAt = new Date().toISOString();
    const headWrite = baseVersion === 0
      ? DB.prepare('INSERT INTO progress_workspaces (user_id, version, updated_at, last_write_id, chunk_count, digest) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING RETURNING *').bind(userId, version, updatedAt, operationId, chunks.length, checksum)
      : DB.prepare('UPDATE progress_workspaces SET version = ?, updated_at = ?, last_write_id = ?, chunk_count = ?, digest = ? WHERE user_id = ? AND version = ? RETURNING *').bind(version, updatedAt, operationId, chunks.length, checksum, userId, baseVersion);
    // A losing same-ID request must not append its different chunks to the winner.
    const ownsWrite = 'EXISTS (SELECT 1 FROM progress_workspaces WHERE user_id = ? AND version = ? AND last_write_id = ? AND digest = ?)';
    const operations = [headWrite,
      DB.prepare(`INSERT INTO progress_workspace_versions (user_id, version, updated_at, chunk_count, digest) SELECT user_id, version, updated_at, chunk_count, digest FROM progress_workspaces WHERE user_id = ? AND version = ? AND last_write_id = ? AND digest = ? ON CONFLICT(user_id, version) DO NOTHING`).bind(userId, version, operationId, checksum),
      ...chunks.map((chunk, index) => DB.prepare(`INSERT INTO progress_workspace_chunks (user_id, version, part, payload) SELECT ?, ?, ?, ? WHERE ${ownsWrite} ON CONFLICT(user_id, version, part) DO NOTHING`).bind(userId, version, index, chunk, userId, version, operationId, checksum)),
      DB.prepare(`DELETE FROM progress_workspace_chunks WHERE user_id = ? AND version < ? AND ${ownsWrite}`).bind(userId, version - 5, userId, version, operationId, checksum),
      DB.prepare(`DELETE FROM progress_workspace_versions WHERE user_id = ? AND version < ? AND ${ownsWrite}`).bind(userId, version - 5, userId, version, operationId, checksum)
    ];
    // D1 batch is transactional: a failed chunk or metadata write rolls back the pointer too.
    const result = await DB.batch(operations);
    const written = result[0]?.results?.[0];
    if (!written) {
      const replay = await readCurrent(userId);
      if (replay.head?.last_write_id === operationId && replay.head.version === version && replay.head.digest === checksum) return load(userId);
      throw new WorkspaceError('version_conflict', '別の端末またはタブで更新されています。変更候補を退避し、最新データを読み込んでください。');
    }
    return envelope(userId, written, JSON.parse(payload));
  }
  async function backup(userId) {
    const result = await DB.batch([
      DB.prepare('SELECT * FROM progress_workspaces WHERE user_id = ?').bind(userId),
      DB.prepare('SELECT * FROM progress_workspace_versions WHERE user_id = ? ORDER BY version DESC LIMIT 2').bind(userId),
      DB.prepare('SELECT version, part, payload FROM progress_workspace_chunks WHERE user_id = ? AND (version IN (SELECT version FROM progress_workspace_versions WHERE user_id = ? ORDER BY version DESC LIMIT 2) OR version = (SELECT version FROM progress_workspaces WHERE user_id = ?)) ORDER BY version DESC, part').bind(userId, userId, userId)
    ]);
    const head = result[0].results[0] || null, versions = result[1].results, chunks = result[2].results;
    // Export raw bytes represented as strings, including corrupt/unsupported records; never restore implicitly.
    return { type: 'progress-cloud-backup', schemaVersion: 1, exportedAt: new Date().toISOString(), userId, head, versions, chunks };
  }
  async function operationState(userId) {
    const { head, chunks } = await readCurrent(userId);
    if (!head) return { version: 0, operationId: null };
    await payloadFor(head, chunks);
    return { version: head.version, operationId: head.last_write_id };
  }
  return { load, save, backup, operationState };
}
