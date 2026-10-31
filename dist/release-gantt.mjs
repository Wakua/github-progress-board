import { releaseGanttModel } from './release-gantt-model.mjs';
import { mountGanttChart } from './gantt-chart.mjs';
import { ganttTemplate } from './gantt-template.mjs';
import { releaseSummaries } from './release.mjs';
import { todayInTokyo } from './engine.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

// UI selections are scoped to the local project and this session, never written to a snapshot.
export function createReleaseGantt(root) {
  const selections = new Map();
  let controllers = new Map(), lastKey = '', snapshot, projectId, status = '';
  const destroy = () => { for(const c of controllers.values()) c.destroy(); controllers.clear(); };
  function draw() {
    const selection = selections.get(projectId);
    const previous = new Map([...controllers].map(([key,c]) => [key,c.capture()]));
    destroy();
    const model = releaseGanttModel(snapshot, selection);
    const choices = model?.projects ?? [];
    root.innerHTML = '<div data-local-github>' + (typeof status === 'function' ? status() : status) + '</div>';
    if (!model) { root.insertAdjacentHTML('beforeend','<p class="empty-message">GitHubの計画情報は未取得です。</p>'); return; }
    const open = snapshot.planning.milestones.filter(m => m.state === 'open');
    if (!open.length) { root.insertAdjacentHTML('beforeend','<p class="empty-message">開いているリリース（Milestone）がありません。</p>'); return; }
    if (!choices.length && !snapshot.planning.issues.some(i => i.milestoneNumber && i.childCount === 0)) {
      root.insertAdjacentHTML('beforeend',open.map(m => '<section class="gantt"><h2>'+esc(m.title)+'</h2><p>作業未登録</p><p>'+(m.dueOn?'期日 '+esc(m.dueOn.slice(0,10)):'期日未設定')+'</p></section>').join('')); return;
    }
    root.insertAdjacentHTML('beforeend','<label class="gantt-source">計算に使うProject <select aria-label="計算に使うProject"><option value="">選択してください</option>'+choices.map(p=>'<option value="'+esc(p.id)+'"'+(p.id===model.selectedProjectId?' selected':'')+'>'+esc(p.title)+'</option>').join('')+'</select></label>');
    const picker = root.querySelector('.gantt-source select');
    picker.onchange = () => { selection.selectedProjectId = picker.value || null; draw(); root.querySelector('.gantt-source select').focus(); };
    if (!model.result) { if (!choices.length) root.insertAdjacentHTML('beforeend','<p class="empty-message">Projectの計画情報を取得してください。</p>'); return; }
    const milestones = model.result.milestones.filter(m=>m.state !== 'excluded');
    if (!milestones.length) root.insertAdjacentHTML('beforeend','<p class="empty-message">開いているリリース（Milestone）がありません。</p>');
    const summaries = releaseSummaries(snapshot,selection.baseDate);
    for (const [index,milestone] of milestones.entries()) {
      const card = document.createElement('section'); card.className = 'gantt'; card.dataset.milestone = milestone.key;
      card.setAttribute('aria-label',model.input.milestones.find(m=>m.key===milestone.key).title);
      card.innerHTML = ganttTemplate; root.append(card);
      const summary = summaries.find(s=>snapshot.planning.milestones.find(m=>m.number===s.number)?.url.toLowerCase()===milestone.key);
      if (summary?.attention) card.insertAdjacentHTML('beforeend','<button class="text-button" data-view-go="attention">要対応 '+summary.attention+'件'+(summary.overdue?'（期限切れ '+summary.overdue+'件）':'')+' →</button>');
      const controller = mountGanttChart(card,model.input,model.result,milestone,{ arrowId:'gantt-arrow-'+index, releaseSummary:summary,
        scale:selection.scales[milestone.key] || 'day', onScale:scale=>{selection.scales[milestone.key]=scale;},
        onSourceProject:(key,id)=>{ selection.sourceProjectIds[key] = id || null; draw(); } });
      controllers.set(milestone.key,controller);
      if(previous.has(milestone.key)) controller.restore(previous.get(milestone.key));
    }
  }
  return {
    update(nextSnapshot, nextProjectId, visible, localStatus = '') {
      if (!visible) { destroy(); lastKey=''; return; }
      const date = todayInTokyo();
      const nextKey = JSON.stringify([nextProjectId,date,nextSnapshot]);
      if (projectId !== nextProjectId) { destroy(); lastKey = ''; }
      snapshot = nextSnapshot; projectId = nextProjectId; status = localStatus;
      if(!selections.has(projectId)) selections.set(projectId,{selectedProjectId:null,sourceProjectIds:{},scales:{},baseDate:date});
      selections.get(projectId).baseDate = date;
      if(nextKey !== lastKey) { lastKey=nextKey; draw(); }
      else for(const c of controllers.values()) c.redraw();
    },
    destroy,
  };
}
