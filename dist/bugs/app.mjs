import {registrationName,tagOptions,matchesFilters,statusNames,nextStatusNames,nextAction} from './view.mjs';
const $ = selector => document.querySelector(selector);
const element = (tag,text,className) => { const node=document.createElement(tag); if(text!==undefined) node.textContent=text; if(className) node.className=className; return node; };
const bytes = size => size >= 1024**3 ? (size/1024**3).toFixed(2)+' GiB' : size >= 1024**2 ? (size/1024**2).toFixed(1)+' MiB' : size>=1024 ? (size/1024).toFixed(1)+' KiB' : size+' B';
const time = value => new Date(value).toLocaleString('ja-JP');
let actor, reports=[], selected, draftId, uploaded=new Map(), pending=[], statusTimer;
let deepLink=new URL(location.href).searchParams.get('report');
async function api(route,options={}) {
  const response=await fetch('/api/bugs/'+route,{...options,credentials:'same-origin'});
  const value=await response.json();
  if(!response.ok) { const error=new Error(value.error || '処理を完了できませんでした。'); error.status=response.status; throw error; }
  return value;
}
const json = value => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
function notice(message,error=false) { const node=$('#notice'); node.textContent=message; node.classList.toggle('error',error); node.hidden=!message; }
function clearDraft() { $('#report-form').reset(); uploaded.clear(); draftId=null; pending=[]; $('#selected-files').replaceChildren(); $('#pending-files').replaceChildren(); $('#form-error').textContent=''; }
function savedDraftUploads() {
  return [...new Map([...pending,...uploaded.values()].map(file=>[file.id,file])).values()];
}
function renderDraftFiles() {
  const files=[...$('#report-form').elements.files.files].filter(file=>!uploaded.has(file));
  $('#selected-files').replaceChildren(...files.map(file=>element('div',file.name+' · '+bytes(file.size))));
  const box=$('#pending-files'),choices=new Map([...box.querySelectorAll('input')].map(input=>[input.value,input.checked]));
  const completedIds=new Set([...uploaded.values()].map(file=>file.id));
  box.replaceChildren();
  for(const file of savedDraftUploads()) {
    const label=element('label'),checkbox=element('input');checkbox.type='checkbox';checkbox.value=file.id;
    checkbox.checked=choices.has(file.id)?choices.get(file.id):completedIds.has(file.id);
    label.append(checkbox,element('span',file.name+' · '+bytes(file.size)));box.append(label);
  }
  $('#recovered').hidden=!box.childElementCount;
}
function showActor(value) {
  if(actor && actor.id!==value.id) clearDraft();
  actor=value; $('#workspace').hidden=false; $('#account').hidden=false; $('#refresh').disabled=$('#new-report').disabled=false;
  $('#person').textContent=actor.name; $('#progress-link').hidden=actor.role!=='admin'; $('#new-report').hidden=!actor.shared&&actor.role!=='tester';
  $('#scope').textContent=actor.shared?'共通の利用者 · すべての報告':actor.role==='admin'?'開発側 · すべての報告':'テスター · すべての報告';
  $('#list-heading').textContent='すべての報告';
  $('#policy').textContent='1報告あたり '+bytes(actor.policy.maxBytes)+'・'+actor.policy.maxFiles+'ファイルまで。形式は自由です。保存したデータは自動で削除しません。';
}
async function refresh() {
  const current=actor,result=await api('reports'); if(actor!==current)return; reports=result.reports; renderFilters(); renderList();
  if(selected && reports.some(report=>report.id===selected)) await openReport(selected,false);
  else if(deepLink) {const id=deepLink;deepLink=null;try{await openReport(id);}catch(error){notice(error.message,true);}}
  scheduleStatusRefresh();
}
function renderList() {
  const box=$('#reports'); box.replaceChildren();
  const visible=reports.filter(report=>matchesFilters(report,$('#tag-filter').value,$('#registration-filter').value,$('#status-filter').value));
  $('#report-count').textContent=visible.length+' / '+reports.length+'件';
  if(reports.length&&!visible.length){box.append(element('p','条件に一致する報告はありません。','empty'));return;}
  if(!reports.length) { box.append(element('p',actor.role==='admin'?'受付した報告はありません。':'報告はまだありません。「バグを報告」から送信できます。','empty')); return; }
  for(const report of visible) {
    const row=element('button',undefined,'report-row'+(report.id===selected?' active':''));
    row.append(element('span',report.title,'report-title'),element('span',statusNames[report.status],'status workflow-'+report.status),element('span',registrationName(report),'status status-'+report.github.state),
      element('span',report.reporterName+' · '+time(report.createdAt)+' · データ '+report.attachmentCount+'件','meta'));
    row.append(tagNodes(report.github.tags));
    row.addEventListener('click',()=>openReport(report.id).catch(error=>notice(error.message,true))); box.append(row);
  }
}
async function openReport(id,move=true) {
  const current=actor,{report}=await api('reports/'+id); if(actor!==current)return; selected=id; renderList();
  const url=new URL(location.href);url.searchParams.set('report',id);history.replaceState(null,'',url);
  const detail=$('#detail'); detail.replaceChildren(); if(move) detail.classList.add('mobile-open');
  const back=element('button','← 報告一覧へ','quiet back'); back.onclick=()=>detail.classList.remove('mobile-open');
  detail.append(back,element('span',statusNames[report.status],'status workflow-'+report.status),element('h2',report.title),
    element('p','報告者 '+report.reporterName+' · '+time(report.createdAt),'meta'),
    element('p','発生したバージョン：'+(report.reportedVersion||'未記入'),'meta'),
    element('div',report.body,'report-body'),element('h3','再現データ · '+report.attachmentCount+'件 / '+bytes(report.attachmentBytes)));
  detail.insertBefore(renderWorkflow(report),detail.querySelector('.report-body'));
  const githubBox=element('div');githubBox.id='github-status';githubBox.append(renderGitHub(report));detail.insertBefore(githubBox,detail.querySelector('.report-body'));
  const files=element('ul',undefined,'file-list');
  for(const file of report.attachments) {
    const item=element('li');
    if(file.state==='ready') { const link=element('a',file.name); link.href='/api/bugs/reports/'+id+'/attachments/'+file.id; item.append(link); }
    else item.append(element('span',file.name+'（保存ファイルを確認できません）'));
    item.append(element('span',bytes(file.size)+' · '+time(file.addedAt),'meta')); files.append(item);
  }
  if(!report.attachments.length) files.append(element('li','再現データはありません。','muted'));
  detail.append(files,element('p','受付ID: '+report.id,'meta'));
  if(actor.shared || actor.role==='tester'&&report.isOwn) {
    const form=element('form'), label=element('label','再現データを追加'), input=element('input');
    input.type='file'; input.multiple=true; input.required=true; label.append(input);
    const status=element('p','', 'muted'), button=element('button','データを追加');
    form.append(label,status,button); detail.append(form);
    form.onsubmit=async event=>{
      event.preventDefault(); const additions=[...input.files]; let completed=0;
      try {
        validateFiles(report.attachmentCount,report.attachmentBytes,additions);
        input.disabled=button.disabled=true;
        for(const file of additions) { status.textContent='保存中 '+(completed+1)+' / '+additions.length+' · '+file.name; await upload('reports/'+id+'/attachments',file); completed++; }
        await refresh(); notice('再現データを '+completed+'件追加しました。');
      } catch(error) {
        status.textContent=error.message+' 保存結果は「更新」で確認できます。';
        // Successful uploads stay attached even when a later upload fails.
        input.disabled=button.disabled=false;
        if(completed) { notice(completed+'件は保存済みです。報告を更新してから残りを追加してください。',true); button.disabled=true; }
      }
    };
  }
  detail.append(renderHistory(report));
  if(move && matchMedia('(max-width:760px)').matches) detail.scrollIntoView({block:'start'});
}
function renderWorkflow(report) {
  const box=element('section',undefined,'workflow-panel');
  box.append(element('h3','対応状況と次の操作'),element('p',nextAction(report,actor.shared?'shared':actor.role),'next-action'));
  if(report.targetVersion)box.append(element('p','確認対象のバージョン：'+report.targetVersion,'meta'));
  if(report.developerNote)box.append(element('p',report.developerNote,'developer-note'));
  const isAdmin=actor.role==='admin',canUpdate=isAdmin&&nextStatusNames[report.status],canConfirm=(actor.shared || actor.role==='tester'&&report.isOwn)&&report.status==='checking';
  if(!canUpdate&&!canConfirm)return box;
  const form=element('form'),error=element('p','','error-text'),requestId=crypto.randomUUID();
  function field(labelText,name,value,{multiline=false,required=false,maxLength=200}={}) {
    const label=element('label',labelText),control=element(multiline?'textarea':'input');control.name=name;control.value=value;control.required=required;control.maxLength=maxLength;
    if(multiline)control.rows=3;
    label.append(control);form.append(label);return control;
  }
  if(canUpdate) {
    field('確認してほしいバージョン','targetVersion',report.targetVersion,{required:report.status==='fixed'});
    field('開発側からの連絡（任意）','developerNote',report.developerNote,{multiline:true,maxLength:4000});
  } else {
    field('実際に確認したバージョン','version','',{required:true});
    const label=element('label','確認結果'),select=element('select');select.name='result';select.required=true;
    for(const [value,text]of [['','結果を選択'],['resolved','直った'],['unresolved','まだ起きる']]){const option=element('option',text);option.value=value;select.append(option);}
    label.append(select);form.append(label);
    field('確認内容（任意）','note','',{multiline:true,maxLength:4000});
    form.append(element('p','対象と異なるバージョンの結果は履歴に残し、確認待ちを続けます。','muted'));
  }
  const button=element('button',canUpdate?nextStatusNames[report.status]:'確認結果を送る');form.append(error,button);box.append(form);
  form.onsubmit=async event=>{
    event.preventDefault();const current=actor;
    const input=canUpdate?{targetVersion:form.elements.targetVersion.value,developerNote:form.elements.developerNote.value}:{version:form.elements.version.value,result:form.elements.result.value,note:form.elements.note.value};
    const payload={...input,revision:report.revision,requestId};
    for(const control of form.elements)control.disabled=true;error.textContent='';
    try {
      const result=await api('reports/'+report.id+(canUpdate?'/status':'/confirmations'),json(payload));
      if(actor!==current)return;
      await refresh();
      notice(canUpdate?'対応状況を更新しました。':!result.matchesTarget?'対象と異なるバージョンの結果を記録しました。確認待ちを続けます。':input.result==='resolved'?'対象バージョンでの解消を記録しました。確認完了です。':'まだ起きることを記録しました。開発側の対応を続けます。');
    } catch(failure) {
      error.textContent=failure.message+' 入力は保持しています。通信が途切れた場合は「更新」で保存結果を確認できます。';
      for(const control of form.elements)control.disabled=false;
    }
  };
  return box;
}
function renderHistory(report) {
  const section=element('section',undefined,'history-panel');section.append(element('h3','これまでの経過'));
  const list=element('ol',undefined,'history-list');
  for(const event of report.history) {
    const item=element('li');
    const title=event.kind==='status'?statusNames[event.toStatus]:event.version+' · '+(event.result==='resolved'?'直った':'まだ起きる');
    item.append(element('strong',title),element('p',time(event.at)+' · '+event.actorName,'meta'));
    if(event.kind==='confirmation')item.append(element('p',event.matchesTarget?'確認対象のバージョンでの結果':'当時の確認対象 '+event.targetVersion+' と異なるバージョン','meta'));
    else if(event.toStatus==='checking')item.append(element('p','確認対象：'+event.targetVersion,'meta'));
    if(event.note)item.append(element('p',event.note,'history-note'));
    list.append(item);
  }
  if(!report.history.length)section.append(element('p','対応状況の更新と確認結果は、ここに記録されます。','muted'));else section.append(list);
  return section;
}
function validateFiles(count,total,files) {
  if(count+files.length>actor.policy.maxFiles || total+files.reduce((sum,file)=>sum+file.size,0)>actor.policy.maxBytes) throw new Error('再現データが容量または件数の上限を超えています。');
}
async function upload(route,file) {
  const result=await api(route,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name),'X-File-Type':file.type},body:file});
  return result.attachment;
}
function tagNodes(tags) {
  const box=element('div',undefined,'tags');
  for(const label of tags.labels) {
    const chip=element('span',label.name,'tag');
    if(/^[0-9a-f]{6}$/i.test(label.color)) {chip.style.setProperty('--tag-color','#'+label.color);}
    box.append(chip);
  }
  if(tags.state==='unfetched')box.append(element('span','タグ未取得','muted'));
  else if(tags.state==='ok'&&!tags.labels.length)box.append(element('span','タグなし','muted'));
  else if(tags.state==='error')box.append(element('span',tags.fetchedAt?'タグ取得失敗 · 前回の取得結果':'タグ取得失敗','error-text'));
  return box;
}
function renderFilters() {
  const select=$('#tag-filter'),previous=select.value;
  select.replaceChildren(...[['all','すべてのタグ'],['none','タグなし（取得済み）'],['unfetched','タグ未取得'],['error','タグ取得失敗']].map(([value,text])=>{
    const option=element('option',text);option.value=value;return option;
  }));
  for(const label of tagOptions(reports)) {const option=element('option',label.name);option.value='label:'+label.id;select.append(option);}
  select.value=[...select.options].some(option=>option.value===previous)?previous:'all';
}
function renderGitHub(report) {
  const box=element('section',undefined,'github-panel'),github=report.github,tags=github.tags;
  box.append(element('h3','GitHub登録'),element('span',registrationName(report),'status status-'+github.state));
  if(github.number) {
    if(actor.role==='admin') {const link=element('a','#'+github.number+' · GitHubで開く');link.href=github.url;link.target='_blank';link.rel='noreferrer';box.append(link);}
    else box.append(element('span','Issue #'+github.number,'meta'));
  }
  if(github.state==='pending')box.append(element('p',github.repository?'保存した報告を順番に登録します。':'接続前に保存した報告です。管理者が登録先を確認して登録します。','muted'));
  if(github.state==='creating')box.append(element('p','GitHubへの作成要求を処理しています。','muted'));
  if(github.error)box.append(element('p',github.error,'error-text'));
  if(github.retryAt)box.append(element('p','再試行予定：'+time(github.retryAt),'muted'));
  box.append(element('h4','タグ'),tagNodes(tags));
  if(tags.fetchedAt)box.append(element('p','取得：'+time(tags.fetchedAt)+(tags.state==='error'?'（前回成功時）':''),'meta'));
  if(tags.error)box.append(element('p',tags.error,'error-text'));
  if(actor.role!=='admin')return box;
  box.append(element('p','登録先：'+(github.repository||actor.github.repository||'未設定'),'meta'));
  if(!actor.github.enabled) {box.append(element('p','GitHub接続を有効にすると登録管理を利用できます。','muted'));return box;}
  const controls=element('div',undefined,'actions'),actionError=element('p','','error-text');
  function action(text,route,input={},enabled=true) {
    const button=element('button',text,'quiet');button.type='button';button.disabled=!enabled;
    button.onclick=async()=>{
      const disabled=[...box.querySelectorAll('button,input')].map(control=>[control,control.disabled]);
      for(const [control] of disabled)control.disabled=true;
      actionError.textContent='';
      try {
        const {report:updated}=await api('reports/'+report.id+'/github/'+route,json(input));
        if(!actor)return;
        await refresh();
        notice(route==='register'||route==='retry'?'GitHub登録を受け付けました。':route==='tags'?(updated.github.tags.state==='error'?'タグを取得できませんでした。前回の結果を保持しています。':'GitHubのタグを取得しました。'):updated.github.state==='registered'?'既存のIssueと関連付けました。':'照合結果を表示しました。');
      } catch(error) {
        actionError.textContent=error.message;
        for(const [control,wasDisabled] of disabled)control.disabled=wasDisabled;
      }
    };
    controls.append(button);return button;
  }
  if(github.state==='registered') {
    action('GitHubのタグを取得','tags');
    box.append(element('p','タグの編集はGitHubで行います。','muted'));
  } else if(github.state==='failed')action('GitHub登録を再試行','register');
  else if(github.state==='pending'&&!github.repository)action('GitHubに登録','register');
  else if(github.state==='unknown') {
    box.append(element('p','作成された可能性があるため、自動では再作成しません。既存のIssueを照合してください。','muted'));
    action('既存のIssueと照合','reconcile');
    if(github.checkedAt)box.append(element('p','照合：'+time(github.checkedAt),'meta'));
    if(github.candidates?.length) {
      box.append(element('p','該当するIssueが複数あります。GitHubで内容を確認してください。','error-text'));
      for(const candidate of github.candidates){const link=element('a','#'+candidate.number);link.href=candidate.url;link.target='_blank';link.rel='noreferrer';box.append(link);}
    } else if(github.candidates && github.checkedAt && github.holdUntil && github.checkedAt<github.holdUntil) {
      box.append(element('p','作成の直後は該当なしを確定できません。'+(github.holdUntil>Date.now()?time(github.holdUntil)+'以降に、':'')+'もう一度照合してください。','muted'));
    } else if(github.candidates && github.checkedAt && Date.now()-github.checkedAt<=300000) {
      box.append(element('p','照合した範囲に該当するIssueはありません。GitHubでも確認してから再試行してください。','muted'));
      const label=element('label',undefined,'confirmation'),checkbox=element('input');checkbox.type='checkbox';
      label.append(checkbox,element('span','GitHubに該当するIssueがないことを確認した'));box.append(label);
      const retry=action('確認して登録を再試行','retry',{confirmNoIssue:true,revision:github.revision},false);
      checkbox.onchange=()=>{retry.disabled=!checkbox.checked;};
    }
  }
  box.append(controls,actionError);return box;
}
function scheduleStatusRefresh() {
  clearTimeout(statusTimer);
  if(!actor||!reports.some(report=>report.github.state==='creating'||report.github.state==='pending'&&report.github.repository))return;
  statusTimer=setTimeout(async()=>{
    const current=actor;
    try {
      const result=await api('reports');
      if(actor!==current)return;
      reports=result.reports;renderFilters();renderList();
      const report=reports.find(item=>item.id===selected),box=$('#github-status');
      if(report&&box)box.replaceChildren(renderGitHub(report));
    } catch(error) {notice(error.message,true);}
    scheduleStatusRefresh();
  },5000);
}

$('#tag-filter').onchange=$('#registration-filter').onchange=$('#status-filter').onchange=()=>renderList();
$('#refresh').onclick=()=>refresh().then(()=>notice('最新の受付情報を読み込みました。')).catch(error=>notice(error.message,true));
$('#new-report').onclick=async()=>{
  try {
    pending=(await api('uploads')).attachments;
    renderDraftFiles();
    draftId ||= crypto.randomUUID(); $('#report-dialog').showModal();
  } catch(error) { notice(error.message,true); }
};
$('#close-form').onclick=()=>$('#report-dialog').close();
$('#report-form').elements.files.onchange=()=>renderDraftFiles();
$('#report-dialog').addEventListener('cancel',event=>{ if($('#submit-report').disabled) event.preventDefault(); });
$('#report-form').onsubmit=async event=>{
  event.preventDefault(); const form=event.currentTarget;
  const files=[...form.elements.files.files].filter(file=>!uploaded.has(file));
  const saved=new Map(savedDraftUploads().map(file=>[file.id,file]));
  const confirmed=[...$('#pending-files').querySelectorAll('input:checked')].map(input=>saved.get(input.value));
  const completed=[];
  try {
    validateFiles(confirmed.length,confirmed.reduce((sum,file)=>sum+file.size,0),files);
    $('#form-error').textContent=''; for(const control of form.elements) control.disabled=true; $('#close-form').disabled=true;
    for(let index=0;index<files.length;index++) {
      const file=files[index];
      $('#upload-progress').textContent='再現データを保存中 '+(index+1)+' / '+files.length+' · '+file.name;
      const attachment=await upload('uploads',file);uploaded.set(file,attachment);completed.push(attachment.id);
    }
    const uploadIds=[...new Set([...confirmed.map(file=>file.id),...completed])];
    $('#upload-progress').textContent='報告を保存しています…';
    const {report}=await api('reports',json({body:form.elements.body.value,reportedVersion:form.elements.reportedVersion.value,requestId:draftId,uploadIds}));
    form.reset(); uploaded.clear(); pending=[]; draftId=null; $('#report-dialog').close();
    await refresh(); await openReport(report.id); notice('報告を受け付けました。受付ID: '+report.id);
  } catch(error) { $('#form-error').textContent=error.message+' 入力と保存済みデータは保持しています。'; }
  finally { renderDraftFiles(); for(const control of form.elements) control.disabled=false; $('#close-form').disabled=false; $('#upload-progress').textContent=''; }
};
try { showActor(await api('me')); await refresh(); } catch(error) { notice(error.message,true); }
