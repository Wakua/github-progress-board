import { ganttProjects, releaseGanttModel } from './release-gantt-model.mjs';
import { releaseGoalGroups } from './gantt-groups.mjs';
import { mountGanttChart } from './gantt-chart.mjs';
import { ganttTemplate } from './gantt-template.mjs';
import { releaseSummaries } from './release.mjs';
import { todayInTokyo } from './engine.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

// UI selections are scoped to the local project and this session, never written to a snapshot.
export function createReleaseGantt(root) {
  const selections = new Map();
  let controller, mountedRelease, lastKey = '', snapshot, projectId, status = '';
  const destroy = () => { controller?.destroy(); controller = null; };
  function draw() {
    const selection = selections.get(projectId);
    const previous = mountedRelease === selection.release ? controller?.capture() : null;
    destroy();

    root.innerHTML = '<div data-local-github>' + (typeof status === 'function' ? status() : status) + '</div>';
    if (!snapshot?.planning) { root.insertAdjacentHTML('beforeend','<p class="empty-message">GitHubの計画情報は未取得です。</p>'); return; }
    const open = snapshot.planning.milestones.filter(m => m.state === 'open');
    if (!open.length) { root.insertAdjacentHTML('beforeend','<p class="empty-message">開いているリリース（Milestone）がありません。</p>'); return; }
    if (!open.some(m => m.url === selection.release)) selection.release = '';
    root.insertAdjacentHTML('beforeend','<label class="gantt-source">表示するリリース <select data-release><option value="">選択してください</option>'+open.map(m =>
      '<option value="'+esc(m.url)+'"'+(selection.release===m.url?' selected':'')+'>'+esc(m.title)+'</option>').join('')+'</select></label>');
    const releases = root.querySelector('[data-release]');
    releases.onchange = () => {
      selection.release = releases.value;
      draw();
      root.querySelector('[data-release]').focus();
    };
    const selected = open.find(m => m.url === selection.release);
    if (!selected) return;
    if (!snapshot.planning.issues.some(i => i.milestoneNumber === selected.number && i.childCount === 0)) {
      root.insertAdjacentHTML('beforeend','<section class="gantt"><h2>'+esc(selected.title)+'</h2><p>作業未登録</p><p>'+(selected.dueOn?'期日 '+esc(selected.dueOn.slice(0,10)):'期日未設定')+'</p></section>'); return;
    }
    const choices = ganttProjects(snapshot);
    const selectedProjectId = selection.selectedProjectId === undefined && choices.length === 1
      ? choices[0].id : selection.selectedProjectId;
    const model = releaseGanttModel(snapshot, {...selection, selectedProjectId});
    root.insertAdjacentHTML('beforeend','<label class="gantt-source">計算に使うProject <select aria-label="計算に使うProject"><option value="">選択してください</option>'+choices.map(p=>'<option value="'+esc(p.id)+'"'+(p.id===model.selectedProjectId?' selected':'')+'>'+esc(p.title)+'</option>').join('')+'</select></label>');
    const picker = root.querySelector('[aria-label="計算に使うProject"]');
    picker.onchange = () => { selection.selectedProjectId = picker.value || null; draw(); root.querySelector('[aria-label="計算に使うProject"]').focus(); };
    if (!model.result) { if (!choices.length) root.insertAdjacentHTML('beforeend','<p class="empty-message">Projectの計画情報を取得してください。</p>'); return; }
    const milestone = model.result.milestones.find(m => m.key === selected.url.toLowerCase());
    if (!milestone) {
      root.insertAdjacentHTML('beforeend','<p class="empty-message">日程を計算できません。</p>');
      return;
    }
    const summaries = releaseSummaries(snapshot,selection.baseDate);
    const tasks = new Map(model.result.tasks.map(task => [task.key, task]));
    const ordered = model.input.issues.map(issue => tasks.get(issue.key)).filter(Boolean);

    const card = document.createElement('section'); card.className = 'gantt'; card.dataset.milestone = milestone.key;
    card.setAttribute('aria-label', selected.title);
    card.innerHTML = ganttTemplate; root.append(card);
    const summary = summaries.find(s => s.number === selected.number);
    if (summary?.attention) card.insertAdjacentHTML('beforeend','<button class="text-button" data-view-go="attention">要対応 '+summary.attention+'件'+(summary.overdue?'（期限切れ '+summary.overdue+'件）':'')+' →</button>');
    if (!selection.folds.has(milestone.key)) selection.folds.set(milestone.key, { collapsed:false, parents:new Set(), known:new Set() });
    const groups = releaseGoalGroups(milestone, ordered, model.input.issues);
    const fold = selection.folds.get(milestone.key);
    for (const group of groups) {
      if (!fold.known.has(group.key)) { fold.known.add(group.key); fold.parents.add(group.key); }
    }
    controller = mountGanttChart(card,model.input,model.result,milestone,{ arrowId:'gantt-arrow-'+selected.number, releaseSummary:summary, groups, fold,
      scale:selection.scales[milestone.key] || 'day', onScale:scale=>{selection.scales[milestone.key]=scale;},
      onSourceProject:(key,id)=>{ selection.sourceProjectIds[key] = id || null; draw(); } });
    mountedRelease = selected.url;
    if (previous) controller.restore(previous);
  }
  return {
    update(nextSnapshot, nextProjectId, visible, localStatus = '') {
      if (!visible) { destroy(); lastKey=''; return; }
      const date = todayInTokyo();
      const nextKey = JSON.stringify([nextProjectId,date,nextSnapshot]);
      if (projectId !== nextProjectId) { destroy(); lastKey = ''; }
      snapshot = nextSnapshot; projectId = nextProjectId; status = localStatus;
      if(!selections.has(projectId)) selections.set(projectId,{release:'',sourceProjectIds:{},scales:{},folds:new Map(),baseDate:date});
      selections.get(projectId).baseDate = date;
      if(nextKey !== lastKey) { lastKey=nextKey; draw(); }
      else controller?.redraw();
    },
    destroy,
  };
}
