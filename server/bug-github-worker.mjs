import {BugError,creationSettleMs} from './bug-store.mjs';
import {GitHubFailure,parseBugRepository,validateIssue,validateLabels} from './bug-github-client.mjs';
export function retryTime(error,now,attempt=1) {
  const h=error.headers||{};
  const rate=error.status===429||(error.status===403&&(h['retry-after']||h['x-ratelimit-remaining']==='0'||h['rate-limited']==='true'));
  if(!rate)return 0;
  const after=Number(h['retry-after']),reset=Number(h['x-ratelimit-reset']);
  const delay=Math.min(3600000,60000*2**Math.min(6,Math.max(0,attempt-1)));
  return Math.max(now+delay,Number.isFinite(after)&&after>=0?now+after*1000:0,h['x-ratelimit-remaining']==='0'&&Number.isFinite(reset)?reset*1000:0);
}
// 「更新」で、Issue一覧に載らなかった報告を番号で個別に取得する件数の上限。
export const labelFallbackLimit=10;
export class GitHubWorker {
  constructor(store,client,{clock=()=>Date.now(),origin='http://127.0.0.1:4319'}={}) {
    if(!parseBugRepository(client.repository))throw new Error('GitHubの接続先を設定してください。');
    const url=new URL(origin);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('報告の入口はこのPCのURLを指定してください。');
    if(store.githubWorker&&!store.githubWorker.stopped)throw new Error('この保存先の登録処理は実行中です。');
    store.githubWorker=this;
    this.store=store;this.client=client;this.clock=clock;this.origin=url.origin;this.stopped=false;this.tail=Promise.resolve();this.labelCursor=0;
    store.githubRepository=client.repository;
    store.db.prepare("UPDATE registration_queue SET state='unknown',error='前回の作成結果を確認してください。',revision=revision+1 WHERE state='creating' AND repository=?").run(client.repository);
  }
  marker(id) {return '<!-- github-progress-board-report:'+this.store.db.prepare('SELECT instance_id FROM github_runtime WHERE id=1').get().instance_id+':'+id+' -->';}
  reportCreatedAt(id) {return this.store.db.prepare('SELECT created_at FROM reports WHERE id=?').get(id).created_at;}
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
    let sent=false;
    try {
      const input=this.payload(row.report_id);
      // 古いバックアップの復元などで、作成済みのIssueが未登録に戻っていることがある。作成の前に必ず探す。
      const existing=await this.client.findIssues(this.marker(row.report_id),{createdAfter:this.reportCreatedAt(row.report_id)});
      if(existing.length>1) {
        this.store.db.prepare("UPDATE registration_queue SET state='unknown',error='同じ識別子のIssueが複数あります。',checked_at=?,candidates=?,revision=revision+1 WHERE report_id=?").run(this.clock(),JSON.stringify(existing.map(issue=>({number:issue.number,url:issue.html_url}))),row.report_id);
        return;
      }
      let issue;
      if(existing.length===1)issue=validateIssue(existing[0],this.client.repository);
      else {
        // タグの確認は読み取りだけで、作成要求を送る前に済ませる。失敗したときは、Issueを作らない。
        const labels=await this.categoryNames(row.report_id);
        // 待ち時間は、探索の長さを含めず、作成要求を送る直前から数える。
        this.store.db.prepare('UPDATE registration_queue SET attempted_at=? WHERE report_id=?').run(this.clock(),row.report_id);
        sent=true;
        issue=validateIssue(await this.client.createIssue(input.title,input.body,labels),this.client.repository);
      }
      if(!issue.body.startsWith(this.marker(row.report_id)+'\n'))throw new GitHubFailure('作成結果の識別子を確認できません。',{uncertain:true});
      this.link(row.report_id,issue);
      await this.refreshLabelsInternal(row.report_id);
    } catch(error) {
      // The association is committed before labels are fetched. Never undo a successful creation.
      if(this.row(row.report_id).state==='registered')return;
      const retryAt=this.rememberRate(error,row.attempts);
      // 作成要求を送る前の失敗では、Issueは作られていない。
      const state=retryAt?'pending':!sent||error instanceof GitHubFailure&&!error.uncertain&&error.status>=400&&error.status<500?'failed':'unknown';
      this.store.db.prepare('UPDATE registration_queue SET state=?,error=?,retry_at=?,revision=revision+1 WHERE report_id=?').run(state,this.safeError(error),retryAt,row.report_id);
    }
  }
  safeError(error){return error instanceof GitHubFailure||error instanceof BugError?error.message:'GitHubの処理結果を確認できません。';}
  link(id,issue) {
    this.store.db.prepare("UPDATE registration_queue SET state='registered',issue_number=?,issue_url=?,error=NULL,retry_at=0,checked_at=NULL,candidates=NULL,revision=revision+1 WHERE report_id=?").run(issue.number,issue.html_url,id);
  }
  // 保留したカテゴリのタグのうち、GitHubに同じidで存在するものの名前を返す。作成の要求に含める。
  // GitHubは、存在しない名前を指定されると、新しいタグを作って付ける（実際のGitHubで確認した）。名前の変更や削除で作ってしまわないよう、idが一致するタグだけを送る。
  // 名前は、取得済みの報告に付いているタグの最後の名前。見つからないタグは送らない（作成後の確認で、付いていないことが分かる）。
  async categoryNames(id) {
    const ids=this.store.categoryIdsOf(id);
    if(!ids.length)return [];
    const names=new Map(this.store.tagRoles().tags.map(tag=>[tag.id,tag.name]));
    const found=[];
    for(const tagId of ids) {
      const name=names.get(tagId);
      if(!name)continue;
      try {
        const label=await this.client.getLabel(name);
        if(label.id===tagId)found.push(label.name);
      } catch(error) {
        if(!(error instanceof GitHubFailure&&error.status===404))throw error;
      }
    }
    return found;
  }
  // 作成後の最初の取得だけ、保留したカテゴリのタグがIssueに付いているかを確かめる。付いていないタグは、次の取得まで示す。
  saveLabels(id,labels) {
    // 全報告のタグの集計は重いため、保留したカテゴリのある報告の、最初の取得のときだけ行う。
    const chosen=this.row(id).labels_at===null?this.store.categoryIdsOf(id):[];
    let missing=[];
    if(chosen.length) {
      const names=new Map(this.store.tagRoles().tags.map(tag=>[tag.id,tag.name]));
      missing=chosen.filter(tagId=>!labels.some(label=>label.id===tagId)).map(tagId=>({id:tagId,name:names.get(tagId)??null}));
    }
    this.store.db.prepare("UPDATE registration_queue SET labels=?,label_state='ok',labels_at=?,labels_error=NULL,category_miss=?,revision=revision+1 WHERE report_id=?").run(JSON.stringify(labels),new Date(this.clock()).toISOString(),missing.length?JSON.stringify(missing):null,id);
  }
  // 取得に失敗しても、前回のタグは消さない。
  markLabelError(id,message) {
    this.store.db.prepare("UPDATE registration_queue SET label_state='error',labels_error=?,revision=revision+1 WHERE report_id=?").run(message,id);
  }
  async refreshLabelsInternal(id) {
    const row=this.row(id);
    try {
      this.requireAvailable();
      const issue=await this.client.getIssue(row.issue_number);
      if(issue.number!==row.issue_number)throw new GitHubFailure('関連付けたIssueと一致しません。');
      this.saveLabels(id,validateLabels(issue.labels));
    } catch(error) {
      this.rememberRate(error);
      this.markLabelError(id,this.safeError(error));
    }
  }
  // 現在の接続先に登録済みの全報告のタグを、Issue一覧からまとめて取り直す。
  // 一覧に載らなかった報告（作成の直後や削除されたIssue）は、番号で個別に取得する。個別の取得は直列の列を塞ぐため、labelFallbackLimit件までにし、超えた分は取得失敗にして、前回の続きから始める次の「更新」に回す。
  // 一覧を読めなかったときは個別に取得せず、全報告を取得失敗にする。
  refreshAllLabels(actor) {
    return this.serialize(async()=>{
      this.store.assertActive(actor);
      if(actor.role!=='admin')throw new BugError(403,'GitHubの登録管理は管理者だけが利用できます。');
      this.requireAvailable();
      const rows=this.store.db.prepare("SELECT q.report_id,q.issue_number,r.created_at FROM registration_queue q JOIN reports r ON r.id=q.report_id WHERE q.state='registered' AND q.repository=? ORDER BY q.issue_number").all(this.client.repository);
      if(!rows.length)return{total:0,updated:0,failed:0};
      let issues;
      try {issues=await this.client.listIssues({createdAfter:rows.reduce((oldest,row)=>row.created_at<oldest?row.created_at:oldest,rows[0].created_at)});}
      catch(error) {
        this.rememberRate(error);
        const message=this.safeError(error);
        this.store.transaction(()=>{for(const row of rows)this.markLabelError(row.report_id,message);});
        return{total:rows.length,updated:0,failed:rows.length};
      }
      let updated=0,failed=0;const missing=[];
      this.store.transaction(()=>{
        for(const row of rows) {
          const issue=issues.get(row.issue_number);
          if(!issue){missing.push(row);continue;}
          try {this.saveLabels(row.report_id,validateLabels(issue.labels));updated++;}
          catch(error) {this.markLabelError(row.report_id,this.safeError(error));failed++;}
        }
      });
      // 毎回同じ報告から始めると、取れない報告が続いたとき、後ろの報告が取得されない。前回の続きから始める。
      const start=missing.length?this.labelCursor%missing.length:0;
      this.labelCursor+=Math.min(missing.length,labelFallbackLimit);
      for(const [index,row] of [...missing.slice(start),...missing.slice(0,start)].entries()) {
        if(index>=labelFallbackLimit){this.markLabelError(row.report_id,'一覧に載らなかったため、今回は取得していません。もう一度「更新」してください。');failed++;continue;}
        await this.refreshLabelsInternal(row.report_id);
        if(this.store.registration(row.report_id).tags.state==='ok')updated++;else failed++;
      }
      return{total:rows.length,updated,failed};
    });
  }
  // A failed creation never made an issue, so only a failed report may move to the current repository.
  authorize(actor,id,{retarget=false}={}) {this.store.assertActive(actor);if(actor.role!=='admin')throw new BugError(403,'GitHubの登録管理は管理者だけが利用できます。');this.store.reportRow(actor,id);const row=this.row(id);if(row.repository&&row.repository!==this.client.repository&&!(retarget&&row.state==='failed'))throw new BugError(409,'保存されたGitHub接続先が一致しません。');return row;}
  register(actor,id) {
    return this.serialize(()=>{
      const row=this.authorize(actor,id,{retarget:true});this.requireAvailable();
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
      // 照合時刻は読み取りを始めた時刻にする。一覧への反映の遅れを、読み取りの後ではなく前から数える。
      const checkedAt=this.clock();
      try{candidates=await this.client.findIssues(this.marker(id),{createdAfter:this.reportCreatedAt(id)});}
      catch(error){this.rememberRate(error);throw new BugError(503,this.safeError(error));}
      if(candidates.length===1) {this.link(id,validateIssue(candidates[0],this.client.repository));await this.refreshLabelsInternal(id);}
      else this.store.db.prepare('UPDATE registration_queue SET checked_at=?,candidates=?,revision=revision+1 WHERE report_id=?').run(checkedAt,JSON.stringify(candidates.map(issue=>({number:issue.number,url:issue.html_url}))),id);
      return this.store.getReport(actor,id);
    });
  }
  retryUnknown(actor,id,input) {
    return this.serialize(()=>{
      const row=this.authorize(actor,id);this.requireAvailable();
      if(row.state!=='unknown'||input.confirmNoIssue!==true||input.revision!==row.revision||!row.checked_at||this.clock()-row.checked_at>300000||row.candidates!=='[]')throw new BugError(409,'最新の照合結果を確認してから再試行してください。');
      // 作成要求の直後は、Issueがあっても一覧に載らない。作成の試行から一定時間が過ぎたあとの照合だけを根拠にする。
      if(row.attempted_at!==null&&row.checked_at<row.attempted_at+creationSettleMs)throw new BugError(409,'作成の直後は該当なしを確定できません。時間をおいて、もう一度照合してください。');
      this.store.db.prepare("UPDATE registration_queue SET state='pending',checked_at=NULL,candidates=NULL,error=NULL,retry_at=0,revision=revision+1 WHERE report_id=?").run(id);
      this.wake();return this.store.getReport(actor,id);
    });
  }
}
