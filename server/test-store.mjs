import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CASE_FIELDS, caseValues, validateCase } from '../dist/testing/case-editor.mjs';

export class TestStoreError extends Error {
  constructor(status, code, current) { super(code); this.status = status; this.code = code; this.current = current; }
}
const invalid = () => new TestStoreError(400, 'invalid_case');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const limits = { id: 32, title: 500, category: 120, priority: 32, type: 32, status: 32, reference: 2000 };
function packet(value) {
  if (!object(value) || Object.keys(value).sort().join() !== 'requestId,revision,values' || !object(value.values)) throw invalid();
  if (Object.keys(value.values).some(key => !CASE_FIELDS.includes(key))) throw invalid();
  for (const [key, text] of Object.entries(value.values)) if (typeof text !== 'string' || text.length > (limits[key] || 20000) || text.includes('\0')) throw invalid();
  const values = caseValues(value.values); values.category = values.category.trim();
  if (Object.keys(validateCase(values)).length || !/^TC-[1-9]\d{0,9}$/.test(values.id)) throw invalid();
  if (!['', 'High', 'Medium', 'Low'].includes(values.priority) || !['', 'Manual', 'Automated', 'Exploratory'].includes(values.type)) throw invalid();
  if (value.revision !== null && (!Number.isSafeInteger(value.revision) || value.revision < 1)) throw invalid();
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.requestId)) throw invalid();
  return { values, revision: value.revision, requestId: value.requestId };
}

// バグ管理とは別のDB。ケース更新はケースと再送受付だけを同時に確定する。
export class TestStore {
  constructor(directory, { timeout = 3000 } = {}) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'tests.sqlite'), { timeout });
    try {
      this.db.exec('PRAGMA foreign_keys=ON;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) throw new Error('Unsupported test database version');
      if (version === 0 && this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) throw new Error('Unrecognized test database');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // 別接続の初期化が先に終わっていても、同じスキーマで安全に開始する。
        this.db.exec(`CREATE TABLE IF NOT EXISTS case_ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
          CREATE TABLE IF NOT EXISTS cases (
            id INTEGER PRIMARY KEY REFERENCES case_ids(id),
            values_json TEXT NOT NULL CHECK(json_valid(values_json)),
            revision INTEGER NOT NULL CHECK(revision > 0),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS case_receipts (
            request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
            response_json TEXT NOT NULL CHECK(json_valid(response_json)));
          PRAGMA user_version=1; COMMIT;`);
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  record(row) { return row ? { ...JSON.parse(row.values_json), revision: row.revision } : null; }
  load() {
    const cases = this.db.prepare('SELECT values_json,revision FROM cases ORDER BY id').all().map(row => this.record(row));
    return { cases, categories: [...new Set(cases.map(row => row.category).filter(Boolean))].sort() };
  }
  newCase() {
    const row = this.db.prepare('INSERT INTO case_ids DEFAULT VALUES').run();
    return { id: `TC-${row.lastInsertRowid}` };
  }
  save(input) {
    const { values, revision, requestId } = packet(input), id = Number(values.id.slice(3));
    const fingerprint = createHash('sha256').update(JSON.stringify([values, revision])).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.db.prepare('SELECT fingerprint,response_json FROM case_receipts WHERE request_id=?').get(requestId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new TestStoreError(409, 'request_reused');
        this.db.exec('COMMIT'); return JSON.parse(receipt.response_json);
      }
      const current = this.record(this.db.prepare('SELECT values_json,revision FROM cases WHERE id=?').get(id));
      if ((current?.revision ?? null) !== revision) throw new TestStoreError(409, 'case_conflict', current);
      if (!current && !this.db.prepare('SELECT id FROM case_ids WHERE id=?').get(id)) throw invalid();
      const next = { ...values, revision: (current?.revision ?? 0) + 1 }, now = new Date().toISOString();
      if (current) this.db.prepare('UPDATE cases SET values_json=?,revision=?,updated_at=? WHERE id=?').run(JSON.stringify(values), next.revision, now, id);
      else this.db.prepare('INSERT INTO cases(id,values_json,revision,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, JSON.stringify(values), next.revision, now, now);
      this.db.prepare('INSERT INTO case_receipts VALUES(?,?,?)').run(requestId, fingerprint, JSON.stringify(next));
      this.db.exec('COMMIT'); return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
