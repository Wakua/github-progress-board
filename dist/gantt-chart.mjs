import { axisFor, calendarPosition, positionText, dueText, diagnosticText, diagnosticReason, parseDate, monthDay, addDays } from './gantt-axis.mjs';
import { goalSchedule } from './gantt-groups.mjs';
import { releaseDependencies, projectDependencies } from './gantt-dependencies.mjs';
import { validWorkProgress } from './milestone-schedule.mjs';
import { incompleteForecast } from './gantt-forecast-judgment.mjs';
import { goalTaskCounts } from './release-task-counts.mjs';

function completionCount({total, remaining}, counts) {
  const done = counts ? counts.done.length : total - remaining;
  const complete = total > 0 && done === total;
  const label = complete ? total+'件すべて完了' : total+'件中'+done+'件完了';
  const other = [['cancelled','取り下げ'],['ended','終了']].filter(([key]) => counts?.[key].length)
    .map(([key,text]) => '<span>'+text+' '+counts[key].length+'件</span>').join('');
  return '<span aria-hidden="true"'+(complete ? ' class="goal-complete"' : '')+'>'+(complete ? '✓ ' : '')+done+'/'+total+'</span><span class="sr-only">'+label+'</span>'+other;
}
function progressDisplay(read) {
  if (validWorkProgress(read)) return { value: read.value, label: read.value + '%' };
  const reason = read.problem ?? (read.value === null ? 'missing-value' : 'invalid-value');
  return { value: null, label: diagnosticReason(reason) };
}
export function mountGanttChart(root, input, result, milestone, options = {}) {
const $ = selector => root.querySelector(selector.startsWith('#') ? '[data-gantt="'+selector.slice(1)+'"]' : selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const fact = (name, value) => `<div><dt>${name}</dt><dd>${value}</dd></div>`;
let scale = options.scale || 'day', opener, history = [];
const overlaps = result.overlaps.filter(item => item.taskKeys.some(key => milestone.taskKeys.includes(key)));
const unchecked = result.overlapUnchecked.filter(item => milestone.taskKeys.includes(item.key));
const dialog = $('#details'), chart = $('#chart');
const fold = options.fold;
const goalSchedules = new Map();
const task = key => result.tasks.find(item => item.key === key);
const dependencyData = releaseDependencies(input,result,milestone,options.groups);
const targets = new Set(milestone.targetTaskKeys);
const releaseByTask = new Map(input.milestones.flatMap(m => m.tasks.keys.map(k => [k,m.title])));
let projected = [];
const sources = new Map(input.issues.map(issue => [issue.key, issue]));
const source = key => sources.get(key);
const title = key => source(key)?.title || key;
const taskLink = key => `<button class="plain-action" data-follow="${escape(key)}">${escape(title(key))}</button>`;
function shortName(key) {
  const issue = source(key);
  if (!issue) return key.replace('https://github.com/','').replace('/issues/','#');
  return issue.external ? issue.title.split(' ')[0] : '#'+key.split('/').at(-1);
}
const diagnosticsById = new Map(result.diagnostics.map(issue => [issue.id, issue]));
function scheduleGap(key) {
  const id = task(key)?.diagnosticIds[0];
  const why = diagnosticsById.get(id);
  return why ? shortName(why.key) + ' ' + diagnosticText(why) : shortName(key) + ' 日程情報なし';
}
function pairName(pair) {
  if (pair.internal) return shortName(pair.from)+' 親内の前提 '+pair.edges.length+'件';
  const label = key => {
    if (goalSchedules.has(key)) return shortName(key);
    if (!targets.has(key)) return shortName(key)+'（'+(releaseByTask.get(key) ?? 'リリース外')+'）';
    const parent = source(key)?.parent;
    return shortName(key)+(parent?.problem ? '（所属未確認）' : parent?.value ? '' : '（目標なし）');
  };
  return label(pair.from)+' → '+label(pair.to);
}
function relationButton(key,label) {
  return '<button type="button" class="plain-action" data-relation="'+escape(key)+'">'+escape(label)+'</button>';
}
function updateRelations() {
  projected = projectDependencies(dependencyData.edges,options.groups,fold.parents);
  const shown = projected.slice(0,3);
  const links = shown.map(p => relationButton(p.key,pairName(p)));
  if (shown.length < projected.length) links.push(relationButton('dependencies','ほか'+(projected.length-shown.length)+'組'));
  if (dependencyData.gaps.length) links.push(relationButton('dependency-gaps','前提未確認 '+dependencyData.gaps.length+'件'));
  $('#relations').innerHTML = links.length ? '<span>子作業の前提 → 後続</span>'+links.join('') : '取得した範囲に依存の登録なし';
}
function dependencyDetail(pair) {
  return '<ul>'+pair.edges.map(edge => {
    const evidence=edge.registered.filter(r => r.prerequisiteKey!==edge.from || r.successorKey!==edge.to);
    const scope = key => releaseByTask.get(key) ?? (source(key)?.external ? '外部repository' : '所属リリース未確認');
    const fromScope = scope(edge.from), toScope = scope(edge.to);
    const state = source(edge.from)?.completion.value;
    const status = state === 'done' ? '前提完了' : state === 'not-done' ? '前提未完了' : '完了状態未確認';
    const unscheduled = [edge.from, edge.to].find(key => source(key)?.completion.value !== 'done' && !task(key)?.earliestStart);
    return '<li>'+taskLink(edge.from)+' → '+taskLink(edge.to)+'<p class="hint">'+status+' · '+escape(fromScope)+(fromScope===toScope ? '' : ' → '+escape(toScope))+
      (unscheduled ? ' · ' + escape(scheduleGap(unscheduled)) : '')+'</p>'+
      evidence.map(r=>'<p>登録された前提 → 後続　'+taskLink(r.prerequisiteKey)+' → '+taskLink(r.successorKey)+'</p>').join('')+'</li>';
  }).join('')+'</ul>';
}
function load() {
  const due = milestone.dueDate ? `期日 ${milestone.dueDate.replaceAll('-', '/')}` : '期日未設定';
  const releaseName = input.milestones.find(item => item.key === milestone.key).title;
  const forecast = incompleteForecast(result, milestone, sources);
  $('#release-name').textContent = releaseName;
  $('#release-details').setAttribute('aria-label', releaseName + 'の計算根拠');
  $('#summary').innerHTML = `<span>${milestone.finish ? `見込み <strong>${monthDay(parseDate(milestone.finish.date))}</strong>${milestone.dueDate ? ` <span class="warn">${dueText(milestone.dueDifference)}</span>` : ''}` : ({ incomplete:forecast?.label, empty:'作業未登録', completed:'全作業完了' })[milestone.state]}</span><span>${due}</span>`;
  if (forecast) {
    const facts = [...forecast.causes, forecast.allocation].filter(Boolean);
    const evidence = facts.length ? '<p class="forecast-evidence">' + facts.map(escape).join(' ／ ') + '</p>' : '';
    if (options.allAcceptancePending) {
      $('#summary').innerHTML = '<span>受入待ち</span><span>'+due+'</span>';
      $('#summary').insertAdjacentHTML('afterend', '<details class="forecast-details"><summary>日程の内訳</summary><p>'+escape(forecast.label)+'</p>'+evidence+'</details>');
    } else if (evidence) {
      $('#summary').insertAdjacentHTML('afterend', evidence);
    }
  }
  const diagnostics = milestone.diagnosticIds;
  const hasCycle = result.cycles.some(cycle => diagnostics.includes(cycle.diagnosticId));
  $('#alerts').innerHTML = [
    overlaps.length ? `<button class="plain-action warn" data-panel="overlaps">担当調整 ${overlaps.length}件</button>` : '',
    diagnostics.length ? `<button class="plain-action warn" data-panel="diagnostics">${hasCycle ? '循環・情報不足' : '情報不足'} ${diagnostics.length}件</button>` : '',
    unchecked.length ? `<button class="plain-action warn" data-panel="unchecked">重複未確認 ${unchecked.length}件</button>` : '',
  ].join('');
  for (const button of $('#alerts').querySelectorAll('button')) button.onclick = () => openDetails(button.dataset.panel, button);
  const taskRow = item => {
    const critical = milestone.criticalTaskKeys.includes(item.key);
    const warning = item.iterationOverflow ? '期間外' : '';
    return `<div class="row"><div class="name"><button class="plain-action task-button" data-task="${escape(item.key)}" aria-label="${escape(title(item.key))}の詳細${critical ? '、クリティカル' : ''}">${critical ? '<span class="critical-mark" aria-hidden="true">◆</span>' : ''}<span class="task-name">${escape(title(item.key))}</span><span class="duration">${item.durationDisplay ?? ''}</span>${warning ? `<span class="warn row-warning">${warning}</span>` : ''}</button></div><div class="track">${item.earliestStart ? `<span data-bar="${escape(item.key)}" class="bar${critical ? ' critical' : ''}${item.durationDays === 0 ? ' point' : ''}" role="img"></span>` : `<span class="unavailable">${item.completion.value === 'done' ? '完了' : escape(scheduleGap(item.key))}</span>`}</div></div>`;
  };
  let groupIndex = 0;
  function scheduleTrack(key, range) {
    const { earliestStart, earliestFinish, scheduled, remaining, firstUnscheduled } = range;
    if (!scheduled) {
      const label = firstUnscheduled ? scheduleGap(firstUnscheduled) : '残作業なし';
      return '<div class="track"><span class="unavailable">'+escape(label)+'</span></div>';
    }
    const point = calendarPosition(earliestStart) === calendarPosition(earliestFinish);
    const partial = scheduled < remaining;
    const first = monthDay(parseDate(earliestStart.date)), last = monthDay(parseDate(earliestFinish.date));
    const label = (partial ? '一部 '+scheduled+'/'+remaining+'件 · ' : '') + (first === last && earliestStart.date === earliestFinish.date ? first : first+'–'+last);
    return `<div class="track"><span data-goal-bar="${escape(key)}" class="bar goal-bar${point ? ' point' : ''}${partial ? ' partial' : ''}" role="img"></span><span class="goal-period">${label}</span></div>`;
  }
  function renderEntries(entries, depth, insideGoal = false) {
    return entries.map(entry => {
      if (entry.task) return taskRow(entry.task);
      const id = options.arrowId + '-group-' + groupIndex++;
      const expanded = !fold.parents.has(entry.key);
      const goal = depth === 0 && entry.key !== 'other-work';
      const range = goal || insideGoal ? goalSchedule(entry) : null;
      const counts = options.tasksByKey ? goalTaskCounts(entry, options.tasksByKey) : null;
      const metrics = range ? completionCount(range, counts) : '';
      const parentLink = goal && source(entry.key) && !source(entry.key).external
        ? '<a class="goal-issue" href="'+escape(entry.key)+'" target="_blank" rel="noopener noreferrer">子Issueの追加はGitHubで ↗</a>' : '';
      const heading = `<div class="parent-heading ${goal?'goal-heading':entry.key==='other-work'?'other-heading':''}" style="--level:${Math.min(depth,3)}"><button type="button" class="fold-button" data-parent="${escape(entry.key)}" id="${id}-toggle" aria-expanded="${expanded}" aria-controls="${id}" ${range ? `aria-describedby="${id}-metrics"` : ''}>${escape(entry.title ?? title(entry.key))}</button>${range ? `<span class="goal-metrics" id="${id}-metrics">${metrics}</span>` : ''}</div>`;
      let row = heading;
      if (range) {
        goalSchedules.set(entry.key, range);
        row = `<div class="row gantt-goal-row">${heading}${scheduleTrack(entry.key,range)}</div>`;
      }
      return `${row}<div role="group" id="${id}" aria-labelledby="${id}-toggle" style="--level:${Math.min(depth+1,4)}"${expanded ? '' : ' hidden'}>${parentLink}${renderEntries(entry.children, depth+1, goal || insideGoal)}</div>`;
    }).join('');
  }
  $('#rows').innerHTML = renderEntries(options.groups, 0);
  $('.card').insertAdjacentHTML('afterbegin','<div class="gantt-relations" data-gantt="relations"></div>');
  $('#relations').onclick = event => {
    const button = event.target.closest('[data-relation]');
    if (button) openDetails(button.dataset.relation,button);
  };
  $('#connections').onclick = event => {
    const key = event.target.closest('[data-pair]')?.dataset.pair;
    if (!key) return;
    const links = [...$('#relations').querySelectorAll('[data-relation]')];
    openDetails(key,links.find(b=>b.dataset.relation===key) ?? links.find(b=>b.dataset.relation==='dependencies'));
  };
  function updateOverview() {
    updateRelations();
    root.classList.toggle('goals-only', options.groups.every(entry => fold.parents.has(entry.key)));
  }
  updateOverview();
  for (const button of chart.querySelectorAll('[data-parent]')) button.onclick = () => {
    const key = button.dataset.parent;
    const group = document.getElementById(button.getAttribute('aria-controls'));
    group.hidden = !group.hidden;
    if (group.hidden) fold.parents.add(key);
    else fold.parents.delete(key);
    button.setAttribute('aria-expanded', String(!group.hidden));
    updateOverview();
    drawDependencies();
  };
  for (const button of chart.querySelectorAll('[data-task]')) button.onclick = () => openDetails(button.dataset.task, button);
  const empty = options.groups.length === 0;
  $('.legend').hidden = empty;
  const releaseToggle = $('#release-toggle'), schedule = $('.card');
  schedule.id = options.arrowId + '-schedule';
  releaseToggle.setAttribute('aria-controls', schedule.id);
  releaseToggle.disabled = empty;
  function displayRelease() {
    schedule.hidden = empty || fold.collapsed;
    releaseToggle.setAttribute('aria-expanded', String(!schedule.hidden));
  }
  releaseToggle.onclick = () => { fold.collapsed = !fold.collapsed; displayRelease(); drawDependencies(); };
  displayRelease();
  setScale(scale);
}
function openDetails(key, button) {
  opener = button; history = [];
  showDetails(key); dialog.showModal();
}
function showDetails(key) {
  history.push(key);
  $('#back').hidden = history.length < 2;
  let heading, body;
  if (key === 'release') {
    heading = input.milestones.find(item => item.key === milestone.key).title;
    body = `<dl class="facts">${fact('基準日', input.baseDate)}${fact('取得時点', input.fetchedAt)}${fact('完了見込み', positionText(milestone.finish))}${fact('期日差', dueText(milestone.dueDifference))}</dl><p>親の件数は、このリリースに属する末端作業のうち完了した件数と総数。取り下げ・終了理由が不明な作業は、完了に含めず別に示す。</p><p>日程は登録済みの前提が終わり次第、着手する計算。</p><p>余裕は、完了見込みを遅らせずに開始を延ばせる日数。担当の競合は日程に反映しない。</p>`;
    const summary = options.releaseSummary;
    if (summary) {
      body += '<dl class="facts">'+fact('残りの期間', summary.iterations+'期間')+fact('未完了Estimate', summary.remainingPoints+'pt')+'</dl>';
      if (summary.overflow.length) body += '<h3>割当の見直し</h3><ul>'+summary.overflow.map(row=>'<li>'+taskLink(row.task.item.url.toLowerCase())+' '+escape(row.labels.join('・'))+'</li>').join('')+'</ul>';
    }
  } else if (key === 'dependencies') {
    heading = '子作業の前提 → 後続';
    body = projected.map(p=>'<p>'+relationButton(p.key,pairName(p))+'</p>').join('');
  } else if (key === 'dependency-gaps') {
    heading = '前提を確認できない作業';
    body = '<ul>'+dependencyData.gaps.map(k=>'<li>'+taskLink(k)+'　'+escape(diagnosticReason(source(k).blockedBy.problem ?? 'incomplete-list'))+'</li>').join('')+'</ul>';
  } else if (key.startsWith('pair:')) {
    const pair = projected.find(p=>p.key===key);
    heading = pairName(pair);
    body = '<section class="relation-evidence"><p>先に必要な作業 → 後続の作業</p>'+dependencyDetail(pair)+'</section>';
  } else if (key === 'overlaps') {
    heading = '担当の重複';
    body = overlaps.map(item => `<section><h3>${escape(item.owner)}</h3><p>${positionText(item.start)} → ${positionText(item.finish)}</p><ul>${item.taskKeys.map(k => `<li>${taskLink(k)}</li>`).join('')}</ul></section>`).join('');
    body += '<p class="hint">担当の調整が必要。日程は自動で変更しない。</p>';
  } else if (key === 'diagnostics') {
    heading = '計算できない理由';
    body = diagnosticsHtml(milestone.diagnosticIds);
  } else if (key === 'unchecked') {
    heading = '重複を確認できない作業';
    const reasons = { 'source-unavailable':'出典Project未確定', 'outside-project':'対象Project外', 'owner-unknown':'担当不明', 'schedule-unknown':'日程未算出' };
    body = `<ul>${unchecked.map(item => `<li>${taskLink(item.key)}<p>${item.reasons.map(reason => reasons[reason]).join('・')}</p></li>`).join('')}</ul>`;
  } else {
    const item = task(key), original = source(key);
    heading = title(key);
    if (!item) {
      body = `<p>${original ? (original.state.value ?? '状態未取得') : 'Issue未取得'}・${original?.children.keys.length ? '集約Issue' : original?.completion.value === 'done' ? '完了済み' : '日程未算出'}</p><ul>${(original?.children.keys || []).map(k => `<li>${taskLink(k)}</li>`).join('')}</ul>`;
    } else {
      const reverse = milestone.tasks.find(t => t.key === key);
      const progress = progressDisplay(original.planning.workProgressPercent);
      const progressText = escape(progress.label) + (progress.value === 100 && item.completion.value !== 'done' ? '・未完了' : '');
      const meter = progress.value === null ? '' : `<span class="progress-track" role="progressbar" aria-label="${escape(heading)}の作業進捗率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.value}"><span style="width:${progress.value}%"></span></span>`;
      body = `<dl class="facts">${fact('期間', item.completion.value === 'done' ? '完了済み（実績日不明）' : `${positionText(item.earliestStart)} →<br>${positionText(item.earliestFinish)}`)}${fact('残り', item.durationDisplay ?? '未算出')}${fact('作業進捗率', progressText+`（見積 ${original.planning.estimatePoints.value === null ? '未入力' : `${original.planning.estimatePoints.value}pt`}）${meter}`)}${fact('担当', escape(original.planning.owner.value ?? '不明'))}${fact('余裕', item.completion.value === 'done' ? '対象外' : reverse?.slackDisplay ?? '未算出')}${fact('既存分類', escape(original.category))}</dl>`;
      if (item.iterationOverflow) body += `<p class="warn">Iteration終了 ${original.planning.iteration.value.endDate} を${item.iterationOverflow.display}超過</p>`;
      if (item.diagnosticIds.length) body += `<h3>計算できない理由</h3>${diagnosticsHtml(item.diagnosticIds)}`;
      const incoming = dependencyData.allEdges.filter(edge => edge.to === key);
      const outgoing = dependencyData.allEdges.filter(edge => edge.from === key);
      const registered = [...new Set(incoming.flatMap(edge => edge.registered.map(relation => relation.prerequisiteKey)).filter(Boolean))];
      const hasAggregate = registered.some(k => source(k)?.children.keys.length);
      if (hasAggregate) {
        body += '<h3>開始条件</h3><p>親の開閉にかかわらず、配下の作業の完了を待つ。</p>';
        body += registered.filter(k => source(k)?.children.keys.length).map(k => `<details open><summary>${escape(title(k))} · ${source(k).state.value === 'closed' ? 'Closed' : 'Open'}</summary>${hierarchyHtml(k)}</details>`).join('');
      }
      const unlisted = incoming.filter(edge => !registered.some(k => source(k)?.children.keys.length && descendants(k).includes(edge.from)));
      if (!hasAggregate || unlisted.length || !original.blockedBy.complete) body += `<h3>前提</h3>${relationsHtml(unlisted, 'from', !original.blockedBy.complete)}`;
      body += `<h3>後続</h3>${relationsHtml(outgoing, 'to')}`;
    }
    body += `<p><a href="${escape(key)}" target="_blank" rel="noopener noreferrer">GitHubで開く ↗</a></p>`;
  }
  const original = source(key);
  if (original?.projects.length && (original.external || !original.projects.some(p => p.id === input.selectedProjectId) || original.projects.length > 1)) {
    body += '<label class="gantt-source">出典Project <select data-source-project aria-label="出典Project"><option value="">未指定</option>' + original.projects.map(p => '<option value="'+escape(p.id)+'"'+(p.id===original.planning.sourceProjectId?' selected':'')+'>'+escape(p.title)+'</option>').join('')+'</select></label>';
  }
  $('#details-title').textContent = heading;
  $('#details-body').innerHTML = body;
  const sourcePicker = dialog.querySelector('[data-source-project]');
  if (sourcePicker) sourcePicker.onchange = () => options.onSourceProject?.(key, sourcePicker.value);
  $('#details-body').scrollTop = 0;
  dialog.scrollTop = 0;
  for (const button of dialog.querySelectorAll('[data-relation]')) button.onclick = () => { showDetails(button.dataset.relation); $('#details-title').focus(); };
  for (const button of dialog.querySelectorAll('[data-follow]')) button.onclick = () => { showDetails(button.dataset.follow); $('#details-title').focus(); };
}
function hierarchyHtml(key, seen = new Set()) {
  if (seen.has(key)) return '';
  seen = new Set([...seen,key]);
  const children = source(key)?.children.keys || [];
  return `<ul>${children.map(k => `<li>${milestone.criticalTaskKeys.includes(k) ? '<span class="critical-mark" aria-label="クリティカル">◆</span> ' : ''}${taskLink(k)}${source(k)?.children.keys.length ? hierarchyHtml(k, seen) : `<span class="hint"> ${task(k)?.earliestFinish ? positionText(task(k).earliestFinish) : task(k)?.completion.value === 'done' ? '完了' : '未算出'}</span>`}</li>`).join('')}</ul>`;
}
function descendants(key, seen = new Set()) { if(seen.has(key)) return []; seen = new Set([...seen,key]); return (source(key)?.children.keys || []).flatMap(k => [k, ...descendants(k,seen)]); }
function diagnosticsHtml(ids) {
  return `<ul>${ids.map(id => diagnosticsById.get(id)).filter(Boolean).map(item => `<li>${source(item.key) && item.code !== 'dependency-cycle' ? taskLink(item.key) : ''}<span>${escape(diagnosticText(item))}</span>${item.code === 'dependency-cycle' ? `<ul>${result.cycles.find(c => c.diagnosticId === item.id)?.taskKeys.map(k => `<li>${taskLink(k)}</li>`).join('') || ''}</ul>` : ''}</li>`).join('')}</ul>`;
}
function relationsHtml(edges, direction, incomplete = false) {
  return (edges.length ? `<ul>${edges.map(edge => `<li>${edge.criticalByMilestone[milestone.key] ? '<span class="critical-mark" aria-label="クリティカルな接続">◆</span> ' : ''}${taskLink(edge[direction])}<span class="hint"> ${task(edge[direction])?.durationDisplay ?? '未算出'}</span></li>`).join('')}</ul>` : (incomplete ? '' : '<p>取得した範囲に登録なし</p>')) + (incomplete ? '<p>前提の取得が不完全</p>' : '');
}
$('#back').onclick = () => { history.pop(); const previous = history.pop(); showDetails(previous); $('#details-title').focus(); };
$('#release-details').onclick = event => openDetails('release', event.currentTarget);
$('#close').onclick = () => dialog.close();
dialog.addEventListener('close', () => opener?.focus({ preventScroll: true }));
dialog.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const controls = [...dialog.querySelectorAll('button:not([hidden]), summary, a[href], select')].filter(item => item.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
});
function setScale(nextScale) {
  scale = nextScale; options.onScale?.(scale);
  const axis = axisFor(result, milestone, scale), span = axis.end - axis.start;
  const percentage = timestamp => (timestamp - axis.start.getTime()) / span * 100;
  $('#dates').innerHTML = axis.ticks.map(({start, end}) => {
    const label = scale === 'month' ? `${start.getUTCFullYear()}年${start.getUTCMonth()+1}月` : scale === 'week' ? `${monthDay(start)}–${monthDay(addDays(end,-1))}` : `${monthDay(start)}<span class="weekday">${'日月火水木金土'[start.getUTCDay()]}</span>`;
    return `<span class="${scale === 'day' && [0,6].includes(start.getUTCDay()) ? 'weekend' : ''}" style="width:${(end-start)/span*100}%">${label}</span>`;
  }).join('');
  chart.dataset.scale = scale;
  chart.style.setProperty('--axis-width', `${axis.width}px`);
  for (const bar of chart.querySelectorAll('[data-bar], [data-goal-bar]')) {
    const key = bar.dataset.goalBar ?? bar.dataset.bar;
    const range = goalSchedules.get(key);
    const item = range ?? task(key);
    const start = calendarPosition(item.earliestStart), end = calendarPosition(item.earliestFinish);
    bar.style.setProperty('--start', `${percentage(start)}%`);
    bar.style.setProperty('--span', `${(end-start)/span*100}%`);
    const detail = range ? (range.scheduled < range.remaining ? `、一部算出 ${range.scheduled}/${range.remaining}件` : '') : `、${item.durationDisplay}`;
    const description = `${title(key)}、${positionText(item.earliestStart)}から${positionText(item.earliestFinish)}${detail}`;
    bar.setAttribute('aria-label', description); bar.title = description;
  }
  for (const button of root.querySelectorAll('.scale-buttons button')) button.setAttribute('aria-pressed', String(button.dataset.scale === scale));
  $('#visible-range').textContent = `${axis.start.getUTCFullYear()}/${monthDay(axis.start)}–${axis.end.getUTCFullYear()}/${monthDay(addDays(axis.end,-1))}`;
  const due = $('#due-marker');
  due.hidden = !milestone.dueDate || !milestone.taskKeys.length;
  $('#due-legend').hidden = due.hidden;
  if (milestone.dueDate) due.style.left = `calc(var(--name-width) + var(--column-gap) + (100% - var(--name-width) - var(--column-gap)) * ${percentage(parseDate(milestone.dueDate).getTime()+86400000)/100})`;
  $('.timeline-scroll').scrollLeft = 0;
  drawDependencies();
}
function drawDependencies() {
  if ($('.card').hidden) return;
  const origin = chart.getBoundingClientRect();
  const bars = new Map([...chart.querySelectorAll('[data-bar],[data-goal-bar]')]
    .filter(bar=>!bar.closest('[hidden]')).map(bar=>[bar.dataset.bar ?? bar.dataset.goalBar,bar.getBoundingClientRect()]));
  const leafBars = new Map([...chart.querySelectorAll('[data-bar]')].map(bar=>[bar.dataset.bar,bar]));
  const axis = $('#dates').getBoundingClientRect();
  function leafX(key,finish) {
    const style = leafBars.get(key).style;
    const percent = parseFloat(style.getPropertyValue('--start')) + (finish ? parseFloat(style.getPropertyValue('--span')) : 0);
    return axis.left-origin.left + axis.width*percent/100;
  }
  $('#due-marker').style.top = `${$('#dates').getBoundingClientRect().bottom - origin.top}px`;
  const drawn = [];
  const paths = projected.filter(pair => pair.from !== pair.to && bars.has(pair.from) && bars.has(pair.to)).map(pair => {
    const edge = pair.edges.find(e => leafBars.has(e.from) && leafBars.has(e.to));
    if (!edge) return '';
    drawn.push(pairName(pair));
    const from = bars.get(pair.from), to = bars.get(pair.to);
    const x1 = edge.from === pair.from ? from.right-origin.left : leafX(edge.from,true);
    const x2 = edge.to === pair.to ? to.left-origin.left : leafX(edge.to,false);
    const y1 = from.top-origin.top+from.height/2, y2 = to.top-origin.top+to.height/2;
    const critical = edge.criticalByMilestone[milestone.key];
    const turn = x1 + Math.max(7, Math.min(14, (x2-x1)/2));
    const axisLeft = $('#dates').getBoundingClientRect().left-origin.left;
    const d = x2 < axisLeft+12
      ? `M ${x1} ${y1} H ${turn} V ${to.top-origin.top-8} H ${x2+Math.min(14,to.width/2)} V ${to.top-origin.top}`
      : x2-x1 > 16 ? `M ${x1} ${y1} H ${turn} V ${y2} H ${x2}` : `M ${x1} ${y1} H ${turn} V ${y2-22} H ${x2-10} V ${y2} H ${x2}`;
    return `<path d="${d}" data-pair="${escape(pair.key)}" class="${critical ? 'critical-edge' : ''}" marker-end="url(#${options.arrowId})"><title>${escape(pairName(pair))}</title></path>`;
  }).join('');
  $('#connections').innerHTML = `<defs><marker id="${options.arrowId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z"/></marker></defs>`+paths;
  $('#connections').setAttribute('aria-label', drawn.join('、') || 'この時間軸に描ける依存線なし');
}
const observer = new ResizeObserver(drawDependencies); observer.observe(chart);
for (const button of root.querySelectorAll('.scale-buttons button')) button.onclick = () => setScale(button.dataset.scale);
load();

return {
  redraw: drawDependencies,
  capture: () => ({
    scale, history: dialog.open ? [...history] : [], scroll: $('.timeline-scroll').scrollLeft,
    opener: opener?.dataset.relation || opener?.dataset.task || opener?.dataset.panel || (opener ? 'release' : null),
    focusedRelation: root.contains(document.activeElement) ? document.activeElement.dataset.relation : null,
    focusedFold: root.contains(document.activeElement) ? document.activeElement.dataset.parent ||
      (document.activeElement === $('#release-toggle') ? 'release' : null) : null,
  }),
  restore: saved => {
    $('.timeline-scroll').scrollLeft = saved.scroll;
    if (saved.focusedRelation) {
      const links = [...$('#relations').querySelectorAll('[data-relation]')];
      (links.find(b=>b.dataset.relation===saved.focusedRelation) ?? links[0])?.focus({preventScroll:true});
    }
    if (saved.focusedFold) {
      const button = saved.focusedFold === 'release' ? $('#release-toggle') :
        [...root.querySelectorAll('[data-parent]')].find(el => el.dataset.parent === saved.focusedFold);
      if (button && !button.closest('[hidden]')) button.focus({preventScroll:true});
    }
    if (saved.history.length) {
      const valid = saved.history.filter(key => ['release','overlaps','diagnostics','unchecked','dependencies','dependency-gaps'].includes(key) || projected.some(p=>p.key===key) || source(key));
      if (valid.length) { history = []; for(const key of valid) showDetails(key); dialog.showModal();
        opener = [...root.querySelectorAll('button')].find(b => b.dataset.task === saved.opener || b.dataset.panel === saved.opener || b.dataset.relation === saved.opener) || $('[data-gantt="release-details"]');
      }
    }
  },
  destroy: () => { observer.disconnect(); if(dialog.open) dialog.close(); }
};
}
