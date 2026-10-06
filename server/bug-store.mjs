import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

export const initialPolicy = { maxBytes: 1024 ** 3, maxFiles: 20 };
export class BugError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const digest = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
export function validatePolicy(policy) {
  if (!Number.isSafeInteger(policy?.maxBytes) || policy.maxBytes < 1
      || !Number.isSafeInteger(policy?.maxFiles) || policy.maxFiles < 1) throw new BugError(400, '容量と件数の設定を確認してください。');
  return policy;
}

export class BugStore {
  constructor(dataDir, { initialize = false, policy = initialPolicy } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.filesDir = path.join(this.dataDir, 'files');
    const dbFile = path.join(this.dataDir, 'reports.sqlite');
    if (!initialize && !existsSync(dbFile)) throw new Error('先にbug:initで保存先を初期化してください。');
    mkdirSync(this.filesDir, { recursive: true });
    this.db = new DatabaseSync(dbFile, { timeout: 3000 });
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new Error('未対応の報告データです。保存先を保持しました。');
      if (version === 0) {
        if (!initialize || this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n) throw new Error('報告データの形式を確認できません。');
        validatePolicy(policy);
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE policy(id INTEGER PRIMARY KEY CHECK(id=1), max_bytes INTEGER NOT NULL, max_files INTEGER NOT NULL) STRICT;
          CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('tester','admin'))) STRICT;
          CREATE TABLE api_keys(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), hash TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1) STRICT;
          CREATE TABLE sessions(hash TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES api_keys(id), expires_at INTEGER NOT NULL) STRICT;
          CREATE TABLE reports(id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
            request_hash TEXT NOT NULL, body TEXT NOT NULL, version TEXT NOT NULL, created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            UNIQUE(reporter_id,request_id)) STRICT;
          CREATE TABLE attachments(id TEXT PRIMARY KEY, report_id TEXT REFERENCES reports(id), owner_id TEXT NOT NULL REFERENCES users(id),
            name TEXT NOT NULL, size INTEGER NOT NULL, type TEXT NOT NULL, hash TEXT,
            state TEXT NOT NULL CHECK(state IN ('uploading','ready','missing')), created_at TEXT NOT NULL) STRICT;
          CREATE TABLE registration_queue(report_id TEXT PRIMARY KEY REFERENCES reports(id), state TEXT NOT NULL DEFAULT 'pending') STRICT;
          PRAGMA user_version=1;
        `);
        this.db.prepare('INSERT INTO policy VALUES(1,?,?)').run(policy.maxBytes, policy.maxFiles);
        this.db.exec('COMMIT');
      }
      this.policy;
      if(this.db.prepare('PRAGMA user_version').get().user_version===1) this.transaction(()=>{
        this.db.exec(`
          ALTER TABLE registration_queue ADD COLUMN repository TEXT;
          ALTER TABLE registration_queue ADD COLUMN issue_number INTEGER;
          ALTER TABLE registration_queue ADD COLUMN issue_url TEXT;
          ALTER TABLE registration_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE registration_queue ADD COLUMN error TEXT;
          ALTER TABLE registration_queue ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE registration_queue ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE registration_queue ADD COLUMN labels TEXT;
          ALTER TABLE registration_queue ADD COLUMN label_state TEXT NOT NULL DEFAULT 'unfetched';
          ALTER TABLE registration_queue ADD COLUMN labels_at TEXT;
          ALTER TABLE registration_queue ADD COLUMN labels_error TEXT;
          ALTER TABLE registration_queue ADD COLUMN checked_at INTEGER;
          ALTER TABLE registration_queue ADD COLUMN candidates TEXT;
          CREATE TABLE github_runtime(id INTEGER PRIMARY KEY CHECK(id=1),instance_id TEXT NOT NULL,cooldown_until INTEGER NOT NULL DEFAULT 0) STRICT;
          PRAGMA user_version=2;
        `);
        this.db.prepare('INSERT INTO github_runtime(id,instance_id) VALUES(1,?)').run(randomUUID());
      });
      if(this.db.prepare('PRAGMA user_version').get().user_version===2) this.transaction(()=>{
        this.db.exec(`
          ALTER TABLE reports ADD COLUMN status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','working','fixed','checking','complete'));
          ALTER TABLE reports ADD COLUMN target_version TEXT NOT NULL DEFAULT '';
          ALTER TABLE reports ADD COLUMN developer_note TEXT NOT NULL DEFAULT '';
          CREATE TABLE report_events(id INTEGER PRIMARY KEY,report_id TEXT NOT NULL REFERENCES reports(id),actor_id TEXT NOT NULL REFERENCES users(id),
            kind TEXT NOT NULL CHECK(kind IN ('status','confirmation')),from_status TEXT NOT NULL,to_status TEXT NOT NULL,
            target_version TEXT NOT NULL,version TEXT,result TEXT CHECK(result IN ('resolved','unresolved')),matches_target INTEGER CHECK(matches_target IN (0,1)),
            note TEXT NOT NULL,created_at TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,
            UNIQUE(report_id,actor_id,request_id)) STRICT;
          PRAGMA user_version=3;
        `);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  get policy() {
    const value = this.db.prepare('SELECT max_bytes,max_files FROM policy WHERE id=1').get();
    if (!value) throw new Error('報告の容量設定がありません。');
    return validatePolicy({ maxBytes: value.max_bytes, maxFiles: value.max_files });
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createUser(id, name, role) {
    if (!validId(id) || typeof name !== 'string' || !name.trim() || name.length > 100 || !['tester','admin'].includes(role)) throw new BugError(400, '利用者の設定を確認してください。');
    this.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, name.trim(), role);
    return { id, name: name.trim(), role };
  }
  sharedActor() {
    const id='local-shared';
    const user=this.db.prepare('SELECT * FROM users WHERE id=?').get(id) || this.createUser(id,'共通の利用者','admin');
    if(user.role!=='admin')throw new Error('共通の利用者の設定を確認してください。');
    return {...user,shared:true};
  }
  issueKey(userId) {
    if (!this.db.prepare('SELECT id FROM users WHERE id=?').get(userId)) throw new BugError(404, '利用者が見つかりません。');
    const secret = 'br_' + randomBytes(32).toString('hex');
    const id = randomUUID();
    this.db.prepare('INSERT INTO api_keys(id,user_id,hash) VALUES(?,?,?)').run(id, userId, digest(secret));
    return { id, secret };
  }
  revokeKey(id) {
    const result = this.db.prepare('UPDATE api_keys SET active=0 WHERE id=?').run(id);
    if (!result.changes) throw new BugError(404, 'キーが見つかりません。');
  }
  actorForKey(secret) {
    if (typeof secret !== 'string' || secret.length > 200) return null;
    return this.db.prepare('SELECT users.*,api_keys.id AS keyId FROM api_keys JOIN users ON users.id=api_keys.user_id WHERE hash=? AND active=1').get(digest(secret)) || null;
  }
  startSession(secret) {
    const actor = this.actorForKey(secret);
    if (!actor) throw new BugError(401, 'APIキーを確認してください。');
    const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), actor.keyId, Date.now() + 86400000);
    return { token, actor };
  }
  actorForSession(token) {
    if (typeof token !== 'string' || token.length > 200) return null;
    return this.db.prepare(`SELECT users.*,api_keys.id AS keyId FROM sessions JOIN api_keys ON api_keys.id=sessions.key_id
      JOIN users ON users.id=api_keys.user_id WHERE sessions.hash=? AND sessions.expires_at>? AND api_keys.active=1`).get(digest(token), Date.now()) || null;
  }
  endSession(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token)); }
  assertActive(actor) {
    if(actor.shared && actor.id===this.sharedActor().id && actor.role==='admin')return;
    const key=this.db.prepare('SELECT user_id,active FROM api_keys WHERE id=?').get(actor.keyId);
    if (!key?.active || key.user_id !== actor.id) throw new BugError(401,'APIキーが取り消されています。');
  }
  reportRow(actor, id, {ownOnly=true}={}) {
    const report = this.db.prepare('SELECT * FROM reports WHERE id=?').get(id);
    if (!report || (ownOnly && actor.role !== 'admin' && report.reporter_id !== actor.id)) throw new BugError(404, '報告が見つかりません。');
    return report;
  }
  registration(id) {
    const value=this.db.prepare('SELECT * FROM registration_queue WHERE report_id=?').get(id);
    return {state:value.state,repository:value.repository,number:value.issue_number,url:value.issue_url,error:value.error,retryAt:value.retry_at,revision:value.revision,
      tags:{state:value.label_state,labels:value.labels?JSON.parse(value.labels):[],fetchedAt:value.labels_at,error:value.labels_error},
      checkedAt:value.checked_at,candidates:value.candidates?JSON.parse(value.candidates):null};
  }
  summary(row,actor) {
    const totals = this.db.prepare("SELECT count(*) AS count,coalesce(sum(size),0) AS bytes FROM attachments WHERE report_id=? AND state<>'uploading'").get(row.id);
    const person = this.db.prepare('SELECT name FROM users WHERE id=?').get(row.reporter_id);
    const github=this.registration(row.id);
    return { id: row.id, title: row.body.trim().split(/\r?\n/)[0].slice(0,72), status: row.status, targetVersion: row.target_version, developerNote: row.developer_note, ticketState: github.state, github,
      reportedVersion: row.version, createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision,
      reporterName: person.name, isOwn: row.reporter_id===actor.id, attachmentCount: totals.count, attachmentBytes: totals.bytes };
  }
  listReports(actor) {
    const rows = this.db.prepare('SELECT * FROM reports ORDER BY updated_at DESC,id').all();
    return rows.map(row => this.summary(row,actor));
  }
  pendingUploads(actor) {
    if(actor.shared)return this.db.prepare("SELECT id,name,size,type,hash,state FROM attachments WHERE report_id IS NULL AND state='ready' ORDER BY created_at,id").all();
    if (actor.role !== 'tester') return [];
    return this.db.prepare("SELECT id,name,size,type,hash,state FROM attachments WHERE owner_id=? AND report_id IS NULL AND state='ready' ORDER BY created_at,id").all(actor.id);
  }
  getReport(actor, id) {
    const row = this.reportRow(actor,id,{ownOnly:false});
    const attachments = this.db.prepare("SELECT id,name,size,type,hash,state,created_at FROM attachments WHERE report_id=? AND state<>'uploading' ORDER BY created_at,id").all(id);
    const history=this.db.prepare('SELECT report_events.*,users.name AS actor_name FROM report_events JOIN users ON users.id=report_events.actor_id WHERE report_id=? ORDER BY report_events.id').all(id).map(event=>({
      id:event.id,kind:event.kind,fromStatus:event.from_status,toStatus:event.to_status,targetVersion:event.target_version,
      version:event.version,result:event.result,matchesTarget:event.matches_target===null?null:Boolean(event.matches_target),note:event.note,at:event.created_at,actorName:event.actor_name
    }));
    return { ...this.summary(row,actor), body: row.body, attachments: attachments.map(item => ({ ...item, addedAt: item.created_at })),history,confirmations:history.filter(event=>event.kind==='confirmation') };
  }
  createReport(actor, input) {
    if (actor.role !== 'tester'&&!actor.shared) throw new BugError(403, '報告を作成できる利用者として操作してください。');
    if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 256000
        || typeof input.reportedVersion !== 'string' || input.reportedVersion.length > 200 || !validId(input.requestId)
        || !Array.isArray(input.uploadIds) || input.uploadIds.some(id => typeof id !== 'string')
        || new Set(input.uploadIds).size !== input.uploadIds.length) throw new BugError(400, '報告文と添付を確認してください。');
    const fingerprint = digest(JSON.stringify([input.body,input.reportedVersion,input.uploadIds]));
    return this.transaction(() => {
      this.assertActive(actor);
      const previous = this.db.prepare('SELECT * FROM reports WHERE reporter_id=? AND request_id=?').get(actor.id,input.requestId);
      if (previous) {
        if (previous.request_hash !== fingerprint) throw new BugError(409, '同じ受付キーで別の報告は送れません。');
        return this.getReport(actor,previous.id);
      }
      const files = input.uploadIds.map(id => this.db.prepare('SELECT * FROM attachments WHERE id=?').get(id));
      if (files.some(item => !item || (!actor.shared && item.owner_id !== actor.id) || item.report_id || item.state !== 'ready' || !existsSync(this.filePath(item.id)))) throw new BugError(409, '添付の保存完了を確認してください。');
      this.checkBudget(files.length,files.reduce((sum,item) => sum + item.size,0));
      const id = randomUUID(), at = now();
      this.db.prepare('INSERT INTO reports(id,reporter_id,request_id,request_hash,body,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,actor.id,input.requestId,fingerprint,input.body,input.reportedVersion,at,at);
      for (const file of files) this.db.prepare('UPDATE attachments SET report_id=? WHERE id=?').run(id,file.id);
      this.db.prepare('INSERT INTO registration_queue(report_id,repository) VALUES(?,?)').run(id,this.githubRepository||null);
      return this.getReport(actor,id);
    });
  }
  validateAction(input) {
    if(!Number.isSafeInteger(input?.revision)||input.revision<1||!validId(input.requestId))throw new BugError(400,'更新番号と再送用の受付キーを指定してください。');
  }
  previousEvent(actor,id,input,fingerprint) {
    const event=this.db.prepare('SELECT * FROM report_events WHERE report_id=? AND actor_id=? AND request_id=?').get(id,actor.id,input.requestId);
    if(event&&event.request_hash!==fingerprint)throw new BugError(409,'同じ受付キーで別の更新は送れません。');
    return event;
  }
  updateStatus(actor,id,input) {
    if(actor.role!=='admin')throw new BugError(403,'対応状況は管理者だけが更新できます。');
    this.validateAction(input);
    if(typeof input.targetVersion!=='string'||input.targetVersion.length>200||typeof input.developerNote!=='string'||input.developerNote.length>4000)throw new BugError(400,'対象バージョンと開発側からの連絡を確認してください。');
    const target=input.targetVersion.trim(),note=input.developerNote.trim();
    const fingerprint=digest(JSON.stringify(['status',input.revision,target,note]));
    return this.transaction(()=>{
      this.assertActive(actor);const row=this.reportRow(actor,id);
      if(this.previousEvent(actor,id,input,fingerprint))return this.getReport(actor,id);
      if(row.revision!==input.revision)throw new BugError(409,'報告が更新されています。「更新」で最新の状況を確認してください。');
      const next={received:'working',working:'fixed',fixed:'checking'}[row.status];
      if(!next)throw new BugError(409,'テスターからの確認結果を待ってください。');
      if(next==='checking'&&!target)throw new BugError(400,'確認してほしいバージョンを入力してください。');
      const at=now();
      this.db.prepare('UPDATE reports SET status=?,target_version=?,developer_note=?,updated_at=?,revision=revision+1 WHERE id=?').run(next,target,note,at,id);
      this.db.prepare('INSERT INTO report_events(report_id,actor_id,kind,from_status,to_status,target_version,note,created_at,request_id,request_hash) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,actor.id,'status',row.status,next,target,note,at,input.requestId,fingerprint);
      return this.getReport(actor,id);
    });
  }
  recordConfirmation(actor,id,input) {
    if(actor.role!=='tester'&&!actor.shared)throw new BugError(403,'確認結果を送信できる利用者として操作してください。');
    this.validateAction(input);
    if(typeof input.version!=='string'||!input.version.trim()||input.version.length>200||!['resolved','unresolved'].includes(input.result)||typeof input.note!=='string'||input.note.length>4000)throw new BugError(400,'確認したバージョンと結果を入力してください。');
    const version=input.version.trim(),note=input.note.trim();
    const fingerprint=digest(JSON.stringify(['confirmation',input.revision,version,input.result,note]));
    return this.transaction(()=>{
      this.assertActive(actor);const row=this.reportRow(actor,id);
      const previous=this.previousEvent(actor,id,input,fingerprint);
      if(previous)return {report:this.getReport(actor,id),matchesTarget:Boolean(previous.matches_target),confirmationId:previous.id};
      if(row.revision!==input.revision)throw new BugError(409,'報告が更新されています。「更新」で確認対象を読み直してください。');
      if(row.status!=='checking')throw new BugError(409,'修正版の確認を依頼されている報告で送信してください。');
      const matches=version===row.target_version,next=matches?(input.result==='resolved'?'complete':'working'):row.status,at=now();
      this.db.prepare('UPDATE reports SET status=?,updated_at=?,revision=revision+1 WHERE id=?').run(next,at,id);
      const result=this.db.prepare('INSERT INTO report_events(report_id,actor_id,kind,from_status,to_status,target_version,version,result,matches_target,note,created_at,request_id,request_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,actor.id,'confirmation',row.status,next,row.target_version,version,input.result,Number(matches),note,at,input.requestId,fingerprint);
      return {report:this.getReport(actor,id),matchesTarget:matches,confirmationId:Number(result.lastInsertRowid)};
    });
  }
  checkBudget(count,bytes) {
    const policy = this.policy;
    if (count > policy.maxFiles || bytes > policy.maxBytes) throw new BugError(413, '再現データが容量または件数の上限を超えています。');
  }
  reserveAttachment(actor, reportId, file) {
    if (actor.role !== 'tester'&&!actor.shared) throw new BugError(403, '再現データを追加できる利用者として操作してください。');
    if (typeof file.name !== 'string' || !file.name || file.name.length > 240 || /[\x00-\x1f/\\]/.test(file.name)
        || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.type !== 'string' || file.type.length > 160
        || /[\x00-\x1f]/.test(file.type)) throw new BugError(400, 'ファイルの情報を確認してください。');
    return this.transaction(() => {
      this.assertActive(actor);
      if (reportId) this.reportRow(actor,reportId);
      const totals = reportId
        ? this.db.prepare('SELECT count(*) AS count,coalesce(sum(size),0) AS bytes FROM attachments WHERE report_id=?').get(reportId)
        : actor.shared ? this.db.prepare('SELECT count(*) AS count,coalesce(sum(size),0) AS bytes FROM attachments WHERE report_id IS NULL').get()
        : this.db.prepare('SELECT count(*) AS count,coalesce(sum(size),0) AS bytes FROM attachments WHERE owner_id=? AND report_id IS NULL').get(actor.id);
      this.checkBudget(totals.count + 1,totals.bytes + file.size);
      const id = randomUUID();
      this.db.prepare("INSERT INTO attachments(id,report_id,owner_id,name,size,type,state,created_at) VALUES(?,?,?,?,?,?,'uploading',?)").run(id,reportId,actor.id,file.name,file.size,file.type,now());
      return { id,...file };
    });
  }
  finishAttachment(id,hash,actor) {
    return this.transaction(() => {
      if (actor) this.assertActive(actor);
      const row = this.db.prepare("SELECT * FROM attachments WHERE id=? AND state='uploading'").get(id);
      if (!row) throw new BugError(409, '添付の保存状態を確認できません。');
      this.db.prepare("UPDATE attachments SET state='ready',hash=? WHERE id=?").run(hash,id);
      if (row.report_id) this.db.prepare('UPDATE reports SET updated_at=?,revision=revision+1 WHERE id=?').run(now(),row.report_id);
      return { id,name:row.name,size:row.size,type:row.type,hash,state:'ready' };
    });
  }
  discardIncomplete(id) { this.db.prepare("DELETE FROM attachments WHERE id=? AND state='uploading'").run(id); }
  filePath(id, partial = false) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('ファイルIDが不正です。');
    return path.join(this.filesDir,id + (partial ? '.part' : ''));
  }
  attachment(actor,reportId,id) {
    this.reportRow(actor,reportId,{ownOnly:false});
    const item = this.db.prepare("SELECT * FROM attachments WHERE id=? AND report_id=? AND state='ready'").get(id,reportId);
    if (!item) throw new BugError(404, '再現データが見つかりません。');
    return item;
  }
}
