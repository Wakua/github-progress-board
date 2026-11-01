import { ganttProjects, releaseGanttModel } from './release-gantt-model.mjs';
import { releaseGoalGroups } from './gantt-groups.mjs';
import { mountGanttChart } from './gantt-chart.mjs';
import { ganttTemplate } from './gantt-template.mjs';
import { githubPlan, milestoneSources } from './github-planning.mjs';
import { releaseLifecycle } from './release-lifecycle.mjs';
import { releaseTaskCounts } from './release-task-counts.mjs';
import { itemButton } from './github-planning-view.mjs';
import { releaseSummaries } from './release.mjs';
import { todayInTokyo } from './engine.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

function taskCountsMarkup(release, expanded) {
  const counts = releaseTaskCounts(release.tasks);
  const labels = [['done','完了'],['cancelled','取り下げ'],['ended','終了'],['open','未完了']];
  const parts = labels.filter(([key]) => counts[key].length)
    .map(([key,label]) => '<span>'+label+' '+counts[key].length+'件</span>');
  if (counts.pending.length) {
    const rows = counts.pending.map(task => '<li>'+itemButton(task)+'</li>').join('');
    parts.push('<details data-pending-release="'+esc(release.url)+'"'+(expanded.has(release.url) ? ' open' : '')+'><summary>受入待ち '+counts.pending.length+'件</summary><ul>'+rows+'</ul></details>');
  }
  if (!release.tasks.length) parts.push('<span>作業0件</span>');
  if (counts.pendingUnfetched) parts.push('<span class="muted">受入待ち未取得</span>');
  return '<div class="release-task-counts" aria-label="作業の内訳">'+parts.join('')+'</div>';
}

function releaseList(milestones, selectedUrl, expanded) {
  const groups = [[], []];
  for (const m of milestones) {
    const { accepted, label, published } = releaseLifecycle(m);
    const due = m.dueOn ? `期日 <time datetime="${esc(m.dueOn.slice(0,10))}">${esc(m.dueOn.slice(0,10).replaceAll('-', '/'))}</time>` : '期日未設定';
    const version = published ? `<a href="${esc(published.url)}">${esc(published.tag)} 公開済み</a>` : '';
    groups[accepted ? 1 : 0].push(`<li>
      <button type="button" class="release-choose" data-release="${esc(m.url)}" aria-pressed="${m.url === selectedUrl}" aria-label="${esc(m.title)}の詳細">${esc(m.title)}</button>
      <span class="badge ${accepted ? 'done' : 'review'}">${esc(label)}</span>
      <span class="release-facts">${due}${version ? ' · ' + version : ''}</span>
      ${taskCountsMarkup(m, expanded)}
    </li>`);
  }
  return `<div class="release-list">${groups.map((rows, index) => {
    const title = index ? '完了' : '未完了';
    return `<section aria-label="${title}"><h3>${title} <span class="count">${rows.length}件</span></h3>${rows.length ? '<ul>' + rows.join('') + '</ul>' : '<p class="empty-message">該当なし</p>'}</section>`;
  }).join('')}</div>`;
}

// 閉じたMilestoneの将来日程は計算せず、親から継承した子作業も含めて表示する。
function closedRelease(snapshot, selected) {
  const release = githubPlan(snapshot).releases.find(m => m.number === selected.number);
  const rows = release.tasks.map(task => `<li class="my-work-row">${itemButton(task)}<span class="github-state">${esc(task.item.state === 'closed' ? 'Closed' : 'Open')}</span></li>`);
  return `<section class="my-work-section" aria-label="${esc(selected.title)}"><h3>${esc(selected.title)}</h3><p class="footnote">GitHubでClosed・日程計算の対象外</p>${rows.length ? '<ul class="my-work-list">' + rows.join('') + '</ul>' : '<p class="empty-message">作業未登録</p>'}</section>`;
}

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
    const plan = githubPlan(snapshot);
    const milestones = plan.releases;
    if (!milestones.length) { root.insertAdjacentHTML('beforeend','<p class="empty-message">リリース（Milestone）がありません。</p>'); return; }
    const selected = milestones.find(m => m.url === selection.release);
    if (!selected) selection.release = '';
    selection.expandedPending ??= new Set();
    root.insertAdjacentHTML('beforeend', releaseList(milestones, selection.release, selection.expandedPending));
    const list = root.querySelector('.release-list');
    for (const details of list.querySelectorAll('details[data-pending-release]')) details.ontoggle = () => {
      if (!details.isConnected) return;
      if (details.open) selection.expandedPending.add(details.dataset.pendingRelease);
      else selection.expandedPending.delete(details.dataset.pendingRelease);
    };
    list.onclick = event => {
      const button = event.target.closest('button[data-release]');
      if (!button || button.dataset.release === selection.release) return;
      selection.release = button.dataset.release;
      draw();
      root.querySelector('.release-choose[aria-pressed="true"]').focus();
    };
    if (!selected) return;
    if (selected.state === 'closed') { root.insertAdjacentHTML('beforeend', closedRelease(snapshot, selected)); return; }
    const issues = snapshot.planning.issues;
    const sources = milestoneSources(snapshot.repositoryUrl, issues);
    if (!issues.some(i => i.childCount === 0 && sources.get(i.number)?.milestoneNumber === selected.number)) {
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
    controller = mountGanttChart(card,model.input,model.result,milestone,{ arrowId:'gantt-arrow-'+selected.number, releaseSummary:summary, groups, fold, allAcceptancePending:releaseTaskCounts(selected.tasks).allPending, tasksByKey:new Map(selected.tasks.map(task => [task.item.url.toLowerCase(),task])),
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
      if(nextKey !== lastKey) {
        const releaseFocus = root.contains(document.activeElement) && document.activeElement.dataset.release;
        lastKey = nextKey;
        draw();
        if (releaseFocus) {
          const buttons = [...root.querySelectorAll('button[data-release]')];
          (buttons.find(button => button.dataset.release === releaseFocus) || buttons[0])?.focus();
        }
      }
      else controller?.redraw();
    },
    destroy,
  };
}
