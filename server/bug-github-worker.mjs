import {BugError} from './bug-store.mjs';
import {GitHubFailure,parseBugRepository,validateIssue,validateLabels} from './bug-github-client.mjs';
export function retryTime(error,now,attempt=1) {
  const h=error.headers||{};
  const rate=error.status===429||(error.status===403&&(h['retry-after']||h['x-ratelimit-remaining']==='0'||h['rate-limited']==='true'));
  if(!rate)return 0;
  const after=Number(h['retry-after']),reset=Number(h['x-ratelimit-reset']);
  const delay=Math.min(3600000,60000*2**Math.min(6,Math.max(0,attempt-1)));
  return Math.max(now+delay,Number.isFinite(after)&&after>=0?now+after*1000:0,h['x-ratelimit-remaining']==='0'&&Number.isFinite(reset)?reset*1000:0);
}
export class GitHubWorker {
  constructor(store,client,{clock=()=>Date.now(),origin='http://127.0.0.1:4319'}={}) {
    if(!parseBugRepository(client.repository))throw new Error('GitHubの接続先を設定してください。');
    const url=new URL(origin);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('報告の入口はこのPCのURLを指定してください。');
    if(store.githubWorker&&!store.githubWorker.stopped)throw new Error('この保存先の登録処理は実行中です。');
    store.githubWorker=this;
    this.store=store;this.client=client;this.clock=clock;this.origin=url.origin;this.stopped=false;this.tail=Promise.resolve();
    store.githubRepository=client.repository;
    store.db.prepare("UPDATE registration_queue SET state='unknown',error='前回の作成結果を確認してください。',revision=revision+1 WHERE state='creating' AND repository=?").run(client.repository);
  }
  marker(id) {return '<!-- github-progress-board-report:'+this.store.db.prepare('SELECT instance_id FROM github_runtime WHERE id=1').get().instance_id+':'+id+' -->';}
  row(id) {const row=this.store.db.prepare('SELECT * FROM registration_queue WHERE report_id=?').get(id);if(!row)throw new BugError(404,'報告が見つかりません。');return row;}
  serialize(action) {
    const result=this.tail.then(()=>{if(this.stopped)throw new BugError(503,'サーバーを停止しています。');return action();});
    this.tail=result.catch(()=>{});return result;
  }
  cooldown() {return this.store.db.prepare('SELECT cooldown_until FROM github_runtime WHERE id=1').get().cooldown_until;}
  rememberRate(error,attempt=1) {
    const time=retryTime(error,this.clock(),attempt);
    if(time)this.store.db.prepare('UPDATE github_runtime SET cooldown_until=max(cooldown_until,?) WHERE id=1').run(time);
    return time;
  }
  requireAvailable() {if(this.cooldown()>this.clock())throw new BugError(429,'GitHubの利用制限が解除されるまで待ってください。');}
  wake() {
    if(this.stopped||this.timer)return;
    this.timer=setTimeout(()=>{this.timer=null;this.serialize(()=>this.processOne()).catch(()=>{}).finally(()=>this.wakeIfPending());},1000);
    this.timer.unref?.();
  }
  wakeIfPending() {
    if(this.stopped||this.timer)return;
    const pending=this.store.db.prepare("SELECT min(retry_at) AS at FROM registration_queue WHERE state='pending' AND repository=?").get(this.client.repository);
    if(pending.at!==null){
      const wait=Math.max(1000,Math.min(2147483647,Math.max(pending.at,this.cooldown())-this.clock()));
      this.timer=setTimeout(()=>{this.timer=null;this.serialize(()=>this.processOne()).catch(()=>{}).finally(()=>this.wakeIfPending());},wait);
      this.timer.unref?.();
    }
  }
  async stop(){this.stopped=true;clearTimeout(this.timer);this.timer=null;await this.tail;}
  payload(id) {
    const report=this.store.db.prepare('SELECT * FROM reports WHERE id=?').get(id);
    const actor=this.store.db.prepare('SELECT name FROM users WHERE id=?').get(report.reporter_id);
    const excerpt=Array.from(report.body).slice(0,14000).join('');
    const body=[this.marker(id),'','# バグ報告','',
      '報告者: '+actor.name,'発生したバージョン: '+(report.version||'未記入'),'受付: '+report.created_at,'',
      excerpt,excerpt!==report.body?'\n（報告文の抜粋。全文は本ツールの報告詳細で確認する。）':'','',
      '[報告詳細と再現データ]('+this.origin+'/bugs/?report='+id+')',
      '再現データはこのPCの本ツールで取得する。'].join('\n');
    return{title:report.body.trim().split(/\r?\n/)[0].slice(0,120),body};
  }
  async processOne() {
    if(this.cooldown()>this.clock())return;
    const row=this.store.transaction(()=>{
      const next=this.store.db.prepare("SELECT * FROM registration_queue WHERE state='pending' AND repository=? AND retry_at<=? ORDER BY rowid LIMIT 1").get(this.client.repository,this.clock());
      if(!next)return null;
      this.store.db.prepare("UPDATE registration_queue SET state='creating',attempts=attempts+1,error=NULL,revision=revision+1 WHERE report_id=? AND state='pending'").run(next.report_id);
      return this.row(next.report_id);
    });
    if(!row)return;
    try {
      const input=this.payload(row.report_id);
      const issue=validateIssue(await this.client.createIssue(input.title,input.body),this.client.repository);
      if(!issue.body.startsWith(this.marker(row.report_id)+'\n'))throw new GitHubFailure('作成結果の識別子を確認できません。',{uncertain:true});
      this.link(row.report_id,issue);
      await this.refreshLabelsInternal(row.report_id);
    } catch(error) {
      // The association is committed before labels are fetched. Never undo a successful creation.
      if(this.row(row.report_id).state==='registered')return;
      const retryAt=this.rememberRate(error,row.attempts);
      const state=retryAt?'pending':error instanceof GitHubFailure&&!error.uncertain&&error.status>=400&&error.status<500?'failed':'unknown';
      this.store.db.prepare('UPDATE registration_queue SET state=?,error=?,retry_at=?,revision=revision+1 WHERE report_id=?').run(state,this.safeError(error),retryAt,row.report_id);
    }
  }
  safeError(error){return error instanceof GitHubFailure||error instanceof BugError?error.message:'GitHubの処理結果を確認できません。';}
  link(id,issue) {
    this.store.db.prepare("UPDATE registration_queue SET state='registered',issue_number=?,issue_url=?,error=NULL,retry_at=0,checked_at=NULL,candidates=NULL,revision=revision+1 WHERE report_id=?").run(issue.number,issue.html_url,id);
  }
  async refreshLabelsInternal(id) {
    const row=this.row(id);
    try {
      this.requireAvailable();
      const issue=await this.client.getIssue(row.issue_number);
      if(issue.number!==row.issue_number)throw new GitHubFailure('関連付けたIssueと一致しません。');
      const labels=validateLabels(issue.labels);
      this.store.db.prepare("UPDATE registration_queue SET labels=?,label_state='ok',labels_at=?,labels_error=NULL,revision=revision+1 WHERE report_id=?").run(JSON.stringify(labels),new Date(this.clock()).toISOString(),id);
    } catch(error) {
      this.rememberRate(error);
      this.store.db.prepare("UPDATE registration_queue SET label_state='error',labels_error=?,revision=revision+1 WHERE report_id=?").run(this.safeError(error),id);
    }
  }
  authorize(actor,id) {this.store.assertActive(actor);if(actor.role!=='admin')throw new BugError(403,'GitHubの登録管理は管理者だけが利用できます。');this.store.reportRow(actor,id);const row=this.row(id);if(row.repository&&row.repository!==this.client.repository)throw new BugError(409,'保存されたGitHub接続先が一致しません。');return row;}
  register(actor,id) {
    return this.serialize(()=>{
      const row=this.authorize(actor,id);this.requireAvailable();
      if(!['pending','failed'].includes(row.state))throw new BugError(409,'作成結果を照合してから操作してください。');
      this.store.db.prepare("UPDATE registration_queue SET repository=?,state='pending',retry_at=0,error=NULL,revision=revision+1 WHERE report_id=?").run(this.client.repository,id);
      this.wake();return this.store.getReport(actor,id);
    });
  }
  refreshLabels(actor,id) {
    return this.serialize(async()=>{const row=this.authorize(actor,id);if(row.state!=='registered')throw new BugError(409,'登録済みの報告を選んでください。');this.requireAvailable();await this.refreshLabelsInternal(id);return this.store.getReport(actor,id);});
  }
  reconcile(actor,id) {
    return this.serialize(async()=>{
      const row=this.authorize(actor,id);this.requireAvailable();if(row.state!=='unknown')throw new BugError(409,'結果未確認の報告を選んでください。');
      let candidates;
      try{candidates=await this.client.findIssues(this.marker(id));}
      catch(error){this.rememberRate(error);throw new BugError(503,this.safeError(error));}
      if(candidates.length===1) {this.link(id,validateIssue(candidates[0],this.client.repository));await this.refreshLabelsInternal(id);}
      else this.store.db.prepare('UPDATE registration_queue SET checked_at=?,candidates=?,revision=revision+1 WHERE report_id=?').run(this.clock(),JSON.stringify(candidates.map(issue=>({number:issue.number,url:issue.html_url}))),id);
      return this.store.getReport(actor,id);
    });
  }
  retryUnknown(actor,id,input) {
    return this.serialize(()=>{
      const row=this.authorize(actor,id);this.requireAvailable();
      if(row.state!=='unknown'||input.confirmNoIssue!==true||input.revision!==row.revision||!row.checked_at||this.clock()-row.checked_at>300000||row.candidates!=='[]')throw new BugError(409,'最新の照合結果を確認してから再試行してください。');
      this.store.db.prepare("UPDATE registration_queue SET state='pending',checked_at=NULL,candidates=NULL,error=NULL,retry_at=0,revision=revision+1 WHERE report_id=?").run(id);
      this.wake();return this.store.getReport(actor,id);
    });
  }
}
