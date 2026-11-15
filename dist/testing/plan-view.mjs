import {RESULT_STATES as statuses,statusNames,clone,emptyPlan,counts,recorded,canDelete,completion,validatePlan as validate,planValues} from './plan-model.mjs';
import {createPlanRepository} from './plan-repository.mjs';
import {createPlanSession} from './plan-session.mjs';
const session=createPlanSession(createPlanRepository());
let cases=[],busy=false,loadError='',saveError=null,retryAction=null;
const app=document.querySelector('#app'),modal=document.querySelector('#modal');
let dialogTriggerId='';
let plans=[],selected=null,view='empty',step=1,draft=null,sidebar=true,filter='',query='',error='';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const findCase=id=>cases.find(c=>c.id===id)||{id,title:id,category:''};
const current=()=>plans.find(p=>p.id===selected);
const envName=e=>`${e.os} ${e.version} / ${e.model}`;
const stateName={Draft:'下書き', 'In Progress':'実施中',Completed:'完了',Archived:'保管済み'};
const el=id=>document.getElementById(id);
function notify(text){el('notice').textContent=text;setTimeout(()=>{if(el('notice').textContent===text)el('notice').textContent='';},5000);}
function focus(id){requestAnimationFrame(()=>el(id)?.focus());}
function on(id,event,handler){el(id)?.addEventListener(event,handler);}
function badge(s){return `<span class="badge ${s.replaceAll(' ','')}">${esc(stateName[s]||statusNames[s]||s)}</span>`;}
function showDialog(title,body,setup){
 dialogTriggerId=document.activeElement?.id||'';
 modal.innerHTML=`<h2 id="dialog-title">${title}</h2>${body}`;modal.showModal();
 modal.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>modal.close());
 setup?.();
}
function confirmAction(title,body,label,action,danger=false){
 showDialog(title,`${body}<div class="actions"><button data-close autofocus>戻る</button><button id="confirm" class="${danger?'danger':'primary'}">${label}</button></div>`,()=>on('confirm','click',()=>{modal.close();action();}));
}
function navigation(action){if(busy)return;const go=()=>{clearError();retryAction=null;action();};if(view==='create')confirmAction('入力を破棄しますか？','<p>作成中の計画は保存されていません。</p>','破棄する',go,true);else go();}
function openPlan(id){navigation(()=>{selected=id;view='detail';error='';if(innerWidth<=800)sidebar=false;render('plan-title');});}
function newPlan(){navigation(async()=>{busy=true;setBusy();try{const reserved=await session.newPlan();draft=emptyPlan(reserved.id);step=1;view='create';error='';filter='';query='';saveError=null;if(innerWidth<=800)sidebar=false;render('name');}catch(cause){saveError=cause;retryAction=newPlan;render();}finally{busy=false;setBusy();}});}
function render(focusId){
 const p=current();
 app.innerHTML=`<header class="toolbar"><button id="toggle" aria-expanded="${sidebar}" aria-controls="plans">${sidebar?'一覧を閉じる':'一覧を開く'}</button><h1>テスト計画</h1><button id="refresh">再取得</button><button id="new" class="primary">＋ 計画を作る</button></header>${errorView()}<div class="workspace ${sidebar?'':'closed'}"><aside id="plans" class="sidebar" ${sidebar?'':'hidden'}><h2>計画 <span class="muted">${plans.length}</span></h2>${plans.map(p=>`<button class="plan-row" id="plan-${p.id}" data-plan="${p.id}" aria-current="${selected===p.id&&view==='detail'}"><small><span>${p.id}</span><span>${stateName[p.state]}</span></small><strong>${esc(p.name)}</strong><small><span>v${esc(p.version)}</span><span>未実施 ${counts(p)['Not Run']}/${p.results.length}</span></small></button>`).join('')||'<p class="muted">計画はありません</p>'}</aside><section class="panel">${view==='create'?createView():view==='detail'&&p?detailView(p):'<div class="empty"><h2>何を、どの環境で試しますか？</h2><button id="empty-new" class="primary">計画を作る</button></div>'}</section></div>`;
 on('toggle','click',()=>{if(view==='create'&&step===1)readBasics();sidebar=!sidebar;render('toggle');});on('refresh','click',()=>navigation(()=>load()));on('new','click',newPlan);on('empty-new','click',newPlan);
 app.querySelectorAll('[data-plan]').forEach(b=>b.onclick=()=>openPlan(b.dataset.plan));
 if(view==='create')bindCreate();else if(view==='detail'&&p)bindDetail(p);
 bindError(app);setBusy();if(focusId)focus(focusId);
}
function environmentFields(e,i){return `<div class="env-row"><label>OS<input id="os-${i}" value="${esc(e.os)}" placeholder="Windows" required></label><label>OSバージョン<input id="osv-${i}" value="${esc(e.version)}" placeholder="11 24H2" required></label><label>モデル<input id="model-${i}" value="${esc(e.model)}" list="models" required></label><button type="button" data-remove-env="${i}" aria-label="実施条件${i+1}を外す" ${draft.conditions.length===1?'disabled':''}>外す</button></div>`;}
function basicFields(p){return `<div class="form-grid"><label class="wide">計画名<input id="name" value="${esc(p.name)}" placeholder="予約アプリ 1.4.0 確認" required></label><label>対象バージョン<input id="version" value="${esc(p.version)}" placeholder="1.4.0" required></label><label>計画の状態<input value="${stateName[p.state]}" readonly aria-readonly="true"></label></div>`;}
function optionalFields(p){return `<details class="optional"><summary>その他の項目</summary><div class="form-grid"><label>対象ビルド<input id="build" value="${esc(p.build)}"></label><label>計画の担当者<input id="owner" value="${esc(p.owner)}" placeholder="未割当"></label><label>開始日<input id="start" type="date" value="${esc(p.start)}"></label><label>完了日<input id="end" type="date" value="${esc(p.end)}"></label><label class="wide">目的<textarea id="purpose">${esc(p.purpose)}</textarea></label><label class="wide">関連Issue<input id="issue" value="${esc(p.issue)}" placeholder="IssueのURL"></label></div></details>`;}
function createView(){
 return `<div class="panel-head"><div><small>${draft.id} · 新しい計画</small><h2>計画を作る</h2></div>${badge('Draft')}</div><div class="steps"><${step===1?'b':'span'}>1 対象版・実施条件</${step===1?'b':'span'}><${step===2?'b':'span'}>2 ケースを選ぶ</${step===2?'b':'span'}></div>${error?`<p class="error" role="alert">${esc(error)}</p>`:''}${step===1?`<form id="basics">${basicFields(draft)}<div class="section"><div class="section-head"><h3>実施条件</h3><button type="button" id="add-env">＋ 条件を追加</button></div>${draft.conditions.map(environmentFields).join('')}<datalist id="models"><option value="なし（共通）"><option value="Model A"><option value="Model B"></datalist></div>${optionalFields(draft)}<div class="footer"><button type="button" id="cancel-create">キャンセル</button><button class="primary" type="submit">ケースを選ぶ →</button></div></form>`:`<div class="summary"><span><strong>${esc(draft.name)}</strong><br><small>v${esc(draft.version)} · ${draft.conditions.map(envName).map(esc).join('、')}</small></span><button id="back" class="quiet">条件を編集</button></div>${picker(draft.caseIds)}<div class="summary"><span id="selection-total">${draft.caseIds.length}ケース × ${draft.conditions.length}条件</span><strong id="unit-total">Not Run ${draft.caseIds.length*draft.conditions.length}件</strong></div><div class="footer"><button id="back-bottom">← 戻る</button><button id="save-plan" class="primary" ${draft.caseIds.length?'':'disabled'}>計画を作成</button></div>`}`;
}
function readBasics(){
 for(const key of ['name','version','build','owner','start','end','purpose','issue'])if(el(key))draft[key]=el(key).value;
 draft.conditions=draft.conditions.map((e,i)=>({...e,os:el(`os-${i}`).value,version:el(`osv-${i}`).value,model:el(`model-${i}`).value}));
}
function bindCreate(){
 if(step===1){
 on('basics','submit',e=>{e.preventDefault();readBasics();error=validate(draft,{casesRequired:false});if(error){render('name');return;}step=2;render('case-search');});
 on('add-env','click',()=>{readBasics();draft.conditions.push({id:`env-${Date.now()}`,os:'',version:'',model:'なし（共通）'});render(`os-${draft.conditions.length-1}`);});
 app.querySelectorAll('[data-remove-env]').forEach(b=>b.onclick=()=>{readBasics();draft.conditions.splice(Number(b.dataset.removeEnv),1);render('add-env');});
 on('cancel-create','click',()=>navigation(()=>{view=current()?'detail':'empty';render('new');}));
 }else{
 const back=()=>{step=1;error='';render('name');};on('back','click',back);on('back-bottom','click',back);
 bindPicker(draft.caseIds,ids=>{draft.caseIds=ids;render();});
 on('save-plan','click',()=>{if(!draft.caseIds.length)return;error=validate(draft);if(error){step=1;render('name');return;}persist(draft,()=>{selected=draft.id;view='detail';notify('計画を保存しました');render('plan-title');});});
 }
}
function visibleCases(excluded=[]){return cases.filter(c=>c.status==='Active'&&!excluded.includes(c.id)&&(!filter||c.category===filter)&&`${c.title} ${c.id}`.toLowerCase().includes(query.toLowerCase()));}
function picker(ids,excluded=[]){const visible=visibleCases(excluded);return `<div class="filter"><input type="search" id="case-search" aria-label="ケースを検索" placeholder="ケース名・ID" value="${esc(query)}"><select id="category" aria-label="カテゴリ"><option value="">すべてのカテゴリ</option>${[...new Set(cases.map(c=>c.category))].filter(Boolean).sort().map(c=>`<option ${filter===c?'selected':''}>${esc(c)}</option>`).join('')}</select><small>Activeのみ</small></div><div class="selection"><span>${visible.length}件 <span class="muted">· 選択 ${ids.length}件</span></span><button type="button" id="select-visible" ${visible.length?'':'disabled'}>${visible.every(c=>ids.includes(c.id))&&visible.length?'表示中の選択を外す':'表示中をすべて選ぶ'}</button></div><div id="case-picker">${visible.map(c=>`<label class="case-pick"><input type="checkbox" id="pick-${c.id}" data-case="${c.id}" ${ids.includes(c.id)?'checked':''}><span class="title"><small>${esc(c.id)} · ${esc(c.category)}</small>${esc(c.title)}</span></label>`).join('')||'<p class="empty">該当するActiveケースがありません</p>'}</div>`;}
function bindPicker(ids,update,excluded=[],redraw){
 const refresh=()=>redraw?redraw():render('case-search');
 on('case-search','input',e=>{query=e.target.value;const pos=e.target.selectionStart;refresh();focus('case-search');requestAnimationFrame(()=>el('case-search')?.setSelectionRange(pos,pos));});
 on('category','change',e=>{filter=e.target.value;refresh();focus('category');});
 const root=modal.open?modal:app;
 root.querySelectorAll('[data-case]').forEach(b=>b.onchange=()=>{update(b.checked?[...new Set([...ids,b.dataset.case])]:ids.filter(id=>id!==b.dataset.case));focus(`pick-${b.dataset.case}`);});
 on('select-visible','click',()=>{const visible=visibleCases(excluded).map(c=>c.id);update(visible.every(id=>ids.includes(id))?ids.filter(id=>!visible.includes(id)):[...new Set([...ids,...visible])]);focus('select-visible');});
}
function summaryTotals(p){const c=counts(p);return `<div class="totals">${statuses.map(s=>`<span class="total ${s==='Not Run'?'notrun':''}"><b>${c[s]}</b>${statusNames[s]}</span>`).join('')}<span class="total"><b>${c.retest}</b>再テスト待ち</span></div>`;}
function detailView(p){const c=counts(p),done=['Completed','Archived'].includes(p.state);return `<div class="panel-head"><div><small>${p.id} · v${esc(p.version)}</small><h2 id="plan-title" tabindex="-1">${esc(p.name)}</h2></div><div class="right">${badge(p.state)}<button id="edit-plan">編集</button></div></div><div class="summary"><span>${p.caseIds.length}ケース × ${p.conditions.length}条件 <strong>全${p.results.length}件</strong></span><span>${done?'計画を完了':'未実施'} <strong>${done?`合格 ${c.Passed}件`:`${c['Not Run']}件`}</strong></span></div>${summaryTotals(p)}<div class="section-head"><h3>ケース</h3><button id="add-cases" ${done?'disabled':''}>＋ ケースを追加</button></div><table class="results"><thead><tr><th>ケース・担当</th><th>実施条件ごとの結果</th><th>計画から</th></tr></thead><tbody>${p.caseIds.map(id=>{const tc=findCase(id),locked=recorded(p,'case',id);return `<tr><td><small>${esc(id)} · ${esc(tc.category)}</small>${esc(tc.title)}<small><button class="quiet" id="assignee-${id}" data-assignee="${id}">${esc(p.assignees[id]||'担当を設定')}</button></small></td><td class="result-stack">${p.results.filter(r=>r.caseId===id).map(r=>`<div class="result-line"><span>${esc(envName(p.conditions.find(e=>e.id===r.envId)))}</span>${badge(r.status)}</div>`).join('')}</td><td><button data-remove-case="${id}" ${locked||done?'disabled':''}>外す</button>${locked?`<small class="lock">記録済み ${locked}件</small>`:''}</td></tr>`;}).join('')}</tbody></table><div class="section"><div class="section-head"><h3>実施条件 <span class="muted">${p.conditions.length}</span></h3><button id="manage-env" ${done?'disabled':''}>条件を編集</button></div><p class="muted">${p.conditions.map(envName).map(esc).join(' ／ ')}</p></div><details class="optional"><summary>履歴 ${p.history.length}件・実施記録</summary><ul class="history">${p.history.map(h=>`<li><time>${esc(new Date(h.at).toLocaleString('ja-JP'))}</time>${esc(h.text)}<details><summary>変更内容</summary><pre>${esc(historyDetails(h))}</pre></details></li>`).join('')}</ul><h3>実施者・実施日時</h3>${p.results.map(r=>`<p class="hint">${r.caseId} · ${esc(envName(p.conditions.find(e=>e.id===r.envId)))}：${r.recordedAt===null?'未実施（実施者・日時なし）':`${esc(r.performer)} · ${esc(r.date)}`}</p>`).join('')}</details><div class="admin">${canDelete(p)?'<button id="delete-plan" class="danger">下書きを削除</button>':`<span class="lock">${p.results.some(r=>r.recordedAt!==null)?'結果を記録した計画は削除できません':'削除できるのは結果のない下書きです'}</span>`}<div class="right">${done?`${p.state==='Completed'?'<button id="archive">保管する</button> <button id="reopen" class="primary">再開する</button>':''}`:`${p.state==='Draft'?'<button id="start-plan">実施を開始</button> ':''}<button id="complete" class="primary" ${c['Not Run']?'disabled':''}>計画を完了</button>${c['Not Run']?`<p class="hint">未実施 ${c['Not Run']}件が残っています</p>`:''}`}</div></div>`;}

// 保存に成功するまで一覧の値と入力欄を置き換えない。
async function persist(proposal,after,{action='save',acknowledgeWarnings=false}={}) {
 if(busy)return;
 const next=clone(proposal);busy=true;saveError=null;setBusy();
 try {
  const saved=await session.save(next,{action,acknowledgeWarnings});
  plans=plans.filter(p=>p.id!==saved.id);if(!saved.deleted)plans.unshift(saved);
  retryAction=null;clearError();after(saved);
 } catch(cause) {
  saveError=cause;retryAction=()=>persist(next,after,{action,acknowledgeWarnings});showError();
 } finally {busy=false;setBusy();}
}
function setBusy(){
 for(const control of document.querySelectorAll('button,input,textarea,select')){
  if(busy){if(!control.hasAttribute('data-was-disabled'))control.dataset.wasDisabled=String(control.disabled);control.disabled=true;}
  else if(control.hasAttribute('data-was-disabled')){control.disabled=control.dataset.wasDisabled==='true';delete control.dataset.wasDisabled;}
 }
 app.setAttribute('aria-busy',String(busy));modal.setAttribute('aria-busy',String(busy));
}
function errorView(){
 const message=saveError?.message||loadError;if(!message)return '';
 const latest=saveError?.current;
 return `<div class="global-error error" role="alert"><p>${esc(message)}</p>${latest?`<details><summary>保存済みの内容（入力は保持しています）</summary><pre>${esc(historyDetails({after:planValues(latest)}))}</pre></details>`:''}<button id="retry">再試行</button><button id="discard-reload">入力を破棄して再取得</button></div>`;
}
function clearError(){saveError=null;loadError='';document.querySelectorAll('.global-error').forEach(e=>e.remove());}
function showError(){
 document.querySelectorAll('.global-error').forEach(e=>e.remove());
 const root=modal.open?modal:app;root.insertAdjacentHTML('afterbegin',errorView());bindError(root);focus('retry');
}
function bindError(root){
 root.querySelector('#retry')?.addEventListener('click',()=>{if(!busy)(retryAction||load)();});
 root.querySelector('#discard-reload')?.addEventListener('click',()=>{
  if(busy)return;
  if(!window.confirm('保存していない入力を破棄し、最新の内容を取得しますか？'))return;
  if(modal.open)modal.close();view='empty';draft=null;load();
 });
}
async function load(){
 if(busy)return;busy=true;setBusy();
 try {const data=await session.load();plans=data.plans;cases=data.cases;clearError();retryAction=null;if(!current()){selected=null;view='empty';}render(selected?'plan-title':'new');}
 catch(cause){loadError=cause.message;retryAction=load;showError();}
 finally{busy=false;setBusy();}
}
function historyDetails(h){
 const names={name:'計画名',version:'対象バージョン',build:'対象ビルド',owner:'担当者',purpose:'目的',start:'開始日',end:'完了日',issue:'関連Issue',state:'状態',conditions:'実施条件',caseIds:'ケース',assignees:'ケースの担当'};
 const display=(key,value)=>key==='conditions'?value.map(envName).join('、'):key==='state'?stateName[value]:Array.isArray(value)?value.join('、'):value&&typeof value==='object'?Object.entries(value).map(([k,v])=>`${k}：${v}`).join('、'):value||'—';
 return Object.keys(names).filter(k=>JSON.stringify(h.before?.[k])!==JSON.stringify(h.after?.[k])).map(k=>`${names[k]}：${h.before?display(k,h.before[k]):'—'} → ${h.after?display(k,h.after[k]):'—'}`).join('\n');
}
function saved(message,focusId='plan-title'){
 return ()=>{if(modal.open)modal.close();notify(message);render(focusId);};
}
function changeState(p,state,acknowledgeWarnings=false){
 persist({...clone(p),state},saved(state==='Completed'?'計画を完了しました':state==='Archived'?'計画を保管しました':'実施中にしました'),{acknowledgeWarnings});
}
function bindDetail(p){
 on('edit-plan','click',()=>editPlan(p));on('add-cases','click',()=>addCases(p));on('manage-env','click',()=>manageEnv(p));
 app.querySelectorAll('[data-remove-case]').forEach(b=>b.onclick=()=>confirmAction('計画から外しますか？',`<p>${esc(findCase(b.dataset.removeCase).title)}</p><p class="muted">ケース本体は残ります。</p>`,'外す',()=>{
  const next=clone(p),id=b.dataset.removeCase;next.caseIds=next.caseIds.filter(c=>c!==id);delete next.assignees[id];persist(next,saved('計画から外しました','add-cases'));
 }));
 app.querySelectorAll('[data-assignee]').forEach(b=>b.onclick=()=>showDialog('この計画での担当者',`<p>${esc(findCase(b.dataset.assignee).title)}</p><form id="assignee-form"><label>担当者<input id="assignee-name" value="${esc(p.assignees[b.dataset.assignee]||'')}" maxlength="200" placeholder="未割当"></label><div class="actions"><button type="button" data-close>キャンセル</button><button class="primary">保存</button></div></form>`,()=>on('assignee-form','submit',e=>{
  e.preventDefault();const next=clone(p);next.assignees[b.dataset.assignee]=el('assignee-name').value;persist(next,saved('担当者を保存しました',b.id));
 })));
 on('delete-plan','click',()=>confirmAction('下書き計画を削除しますか？',`<p><strong>${esc(p.name)}</strong></p><p>${p.caseIds.length}ケース・${p.conditions.length}条件。実施済みの結果はありません。</p><p class="muted">テストケース本体は削除しません。</p>`,'この下書きを削除',()=>persist(p,()=>{selected=null;view='empty';saved('下書き計画を削除しました','new')();},{action:'delete'}),true));
 on('start-plan','click',()=>changeState(p,'In Progress'));
 on('complete','click',()=>{
  const result=completion(p);if(result.blocked)return;
  if(!result.warning){changeState(p,'Completed');return;}
  const c=result.counts;
  showDialog('未解決の結果を残して完了しますか？',`<div class="totals">${['Failed','Blocked','Skipped'].map(s=>`<span class="total"><b>${c[s]}</b>${statusNames[s]}</span>`).join('')}<span class="total"><b>${c.retest}</b>再テスト待ち</span></div><p>結果と履歴は残ります。全件合格にはなりません。</p><label class="check"><input id="acknowledge" type="checkbox">残っている結果を確認しました</label><div class="actions"><button data-close autofocus>戻る</button><button id="finish-plan" class="primary" disabled>計画を完了</button></div>`,()=>{
   on('acknowledge','change',e=>el('finish-plan').disabled=!e.target.checked);on('finish-plan','click',()=>{if(el('acknowledge').checked)changeState(p,'Completed',true);});
  });
 });
 on('reopen','click',()=>changeState(p,'In Progress'));on('archive','click',()=>changeState(p,'Archived'));
}
function editPlan(p){
 showDialog('計画を編集',`<form id="edit-basic">${basicFields(p)}${optionalFields(p)}<p id="edit-error" class="error" hidden></p><div class="actions"><button type="button" data-close>キャンセル</button><button class="primary">保存</button></div></form>`,()=>on('edit-basic','submit',e=>{
  e.preventDefault();const next=clone(p);for(const key of ['name','version','build','owner','start','end','purpose','issue'])next[key]=el(key).value;
  const err=validate(next);if(err){el('edit-error').textContent=err;el('edit-error').hidden=false;return;}
  persist(next,saved('計画を保存しました'));
 }));
}
function addCases(p){
 let ids=[];filter='';query='';
 const draw=()=>{
  modal.innerHTML=`<h2 id="dialog-title">ケースを追加</h2>${picker(ids,p.caseIds)}<div class="summary"><span>${ids.length}ケース × ${p.conditions.length}条件</span><strong>Not Run ＋${ids.length*p.conditions.length}件</strong></div><div class="actions"><button data-close>キャンセル</button><button id="add-selected" class="primary" ${ids.length?'':'disabled'}>${ids.length}ケースを追加</button></div>`;
  modal.querySelector('[data-close]').onclick=()=>modal.close();bindPicker(ids,next=>{ids=next;draw();},p.caseIds,draw);
  on('add-selected','click',()=>persist({...clone(p),caseIds:[...p.caseIds,...ids]},saved(`${ids.length}ケースを追加しました`,'add-cases')));
 };showDialog('ケースを追加','',draw);
}
function manageEnv(p){
 let active=p;
 const draw=()=>{
  modal.innerHTML=`<h2 id="dialog-title">実施条件</h2>${active.conditions.map(e=>{const n=recorded(active,'env',e.id);return `<div class="env-row"><span>${esc(envName(e))}${n?`<small class="lock"> · 記録済み ${n}件</small>`:''}</span><button data-remove-condition="${e.id}" ${n||active.conditions.length===1?'disabled':''}>外す</button></div>`;}).join('')}<form id="new-condition"><h3 class="section">条件を追加</h3><div class="form-grid section"><label>OS<input id="new-os" required placeholder="Windows"></label><label>OSバージョン<input id="new-osv" required placeholder="11 24H2"></label><label class="wide">モデル<input id="new-model" required value="なし（共通）"></label></div><p id="env-error" class="error" hidden></p><div class="actions"><button type="button" data-close>閉じる</button><button class="primary">条件を追加</button></div></form>`;
  modal.querySelector('[data-close]').onclick=()=>modal.close();
  const after=message=>next=>{active=next;render();draw();notify(message);focus('new-os');};
  modal.querySelectorAll('[data-remove-condition]').forEach(b=>b.onclick=()=>{
   const next=clone(active);next.conditions=next.conditions.filter(e=>e.id!==b.dataset.removeCondition);persist(next,after('実施条件を外しました'));
  });
  on('new-condition','submit',ev=>{
   ev.preventDefault();const next=clone(active);next.conditions.push({id:crypto.randomUUID(),os:el('new-os').value,version:el('new-osv').value,model:el('new-model').value});
   const err=validate(next);if(err){el('env-error').textContent=err;el('env-error').hidden=false;return;}
   persist(next,after('実施条件を追加しました'));
  });
 };showDialog('実施条件','',draw);
}
// 失敗後に入力を直した場合は、過去の入力を再送するボタンを残さない。
for(const event of ['input','change'])document.addEventListener(event,()=>{if(saveError&&!busy){clearError();retryAction=null;}},true);
modal.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
modal.addEventListener('close',()=>{if(dialogTriggerId&&el(dialogTriggerId))focus(dialogTriggerId);});
window.addEventListener('beforeunload',e=>{if(view==='create'||busy||saveError||modal.open){e.preventDefault();e.returnValue='';}});
render();load();
