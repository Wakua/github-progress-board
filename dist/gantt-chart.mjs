import { axisFor, calendarPosition, positionText, dueText, diagnosticText, parseDate, monthDay, addDays } from './gantt-axis.mjs';
export function mountGanttChart(root, input, result, milestone, options = {}) {
const $ = selector => root.querySelector(selector.startsWith('#') ? '[data-gantt="'+selector.slice(1)+'"]' : selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const fact = (name, value) => `<div><dt>${name}</dt><dd>${value}</dd></div>`;
let scale = options.scale || 'day', opener, history = [];
const overlaps = result.overlaps.filter(item => item.taskKeys.some(key => milestone.taskKeys.includes(key)));
const unchecked = result.overlapUnchecked.filter(item => milestone.taskKeys.includes(item.key));
const dialog = $('#details'), chart = $('#chart');
const task = key => result.tasks.find(item => item.key === key);
const source = key => input.issues.find(item => item.key === key);
const title = key => source(key)?.title || key;
const taskLink = key => `<button class="plain-action" data-follow="${escape(key)}">${escape(title(key))}</button>`;
function load() {
  const due = milestone.dueDate ? `期日 ${milestone.dueDate.replaceAll('-', '/')}` : '期日未設定';
  $('#release-details').textContent = input.milestones.find(item => item.key === milestone.key).title;
  $('#release-details').setAttribute('aria-label', $('#release-details').textContent + 'の計算根拠');
  $('#summary').innerHTML = `<span>${milestone.finish ? `見込み <strong>${monthDay(parseDate(milestone.finish.date))}</strong>${milestone.dueDate ? ` <span class="warn">${dueText(milestone.dueDifference)}</span>` : ''}` : ({ incomplete:'見込み未算出・クリティカル未確定', empty:'作業未登録', completed:'全作業完了' })[milestone.state]}</span><span>${due}</span>`;
  const diagnostics = milestone.diagnosticIds;
  $('#alerts').innerHTML = [
    overlaps.length ? `<button class="plain-action warn" data-panel="overlaps">担当調整 ${overlaps.length}件</button>` : '',
    diagnostics.length ? `<button class="plain-action warn" data-panel="diagnostics">${result.cycles.length ? '循環・情報不足' : '情報不足'} ${diagnostics.length}件</button>` : '',
    unchecked.length ? `<button class="plain-action warn" data-panel="unchecked">重複未確認 ${unchecked.length}件</button>` : '',
  ].join('');
  for (const button of $('#alerts').querySelectorAll('button')) button.onclick = () => openDetails(button.dataset.panel, button);
  const ordered = input.issues.map(item => task(item.key)).filter(item => item && milestone.taskKeys.includes(item.key));
  $('#rows').innerHTML = ordered.map(item => {
    const critical = milestone.criticalTaskKeys.includes(item.key);
    const warning = item.iterationOverflow ? '期間外' : '';
    return `<div class="row"><div class="name"><button class="plain-action task-button" data-task="${escape(item.key)}" aria-label="${escape(title(item.key))}の詳細${critical ? '、クリティカル' : ''}">${critical ? '<span class="critical-mark" aria-hidden="true">◆</span>' : ''}<span class="task-name">${escape(title(item.key))}</span><span class="duration">${item.durationDisplay ?? ''}</span>${warning ? `<span class="warn row-warning">${warning}</span>` : ''}</button></div><div class="track">${item.earliestStart ? `<span data-bar="${escape(item.key)}" class="bar${critical ? ' critical' : ''}${item.durationDays === 0 ? ' point' : ''}" role="img"></span>` : `<span class="unavailable">${item.completion.value === 'done' ? '完了' : '日程未算出'}</span>`}</div></div>`;
  }).join('');
  for (const button of chart.querySelectorAll('[data-task]')) button.onclick = () => openDetails(button.dataset.task, button);
  $('.legend').hidden = !ordered.length;
  $('.card').hidden = ordered.length === 0;
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
    body = `<dl class="facts">${fact('基準日', input.baseDate)}${fact('取得時点', input.fetchedAt)}${fact('完了見込み', positionText(milestone.finish))}${fact('期日差', dueText(milestone.dueDifference))}</dl><p>日程は登録済みの前提が終わり次第、着手する計算。</p><p>余裕は、完了見込みを遅らせずに開始を延ばせる日数。担当の競合は日程に反映しない。</p>`;
    const summary = options.releaseSummary;
    if (summary) {
      body += '<dl class="facts">'+fact('残りの期間', summary.iterations+'期間')+fact('未完了Estimate', summary.remainingPoints+'pt')+'</dl>';
      if (summary.overflow.length) body += '<h3>割当の見直し</h3><ul>'+summary.overflow.map(row=>'<li>'+taskLink(row.task.item.url.toLowerCase())+' '+escape(row.labels.join('・'))+'</li>').join('')+'</ul>';
    }
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
      body = `<p>${original?.state.value === 'closed' ? 'Closed' : 'Open'}・集約Issue</p><ul>${(original?.children.keys || []).map(k => `<li>${taskLink(k)}</li>`).join('')}</ul>`;
    } else {
      const reverse = milestone.tasks.find(t => t.key === key);
      body = `<dl class="facts">${fact('期間', item.completion.value === 'done' ? '完了済み（実績日不明）' : `${positionText(item.earliestStart)} →<br>${positionText(item.earliestFinish)}`)}${fact('残り', item.durationDisplay ?? '未算出')}${fact('作業進捗率', (original.planning.workProgressPercent.value === null ? '未入力' : `${original.planning.workProgressPercent.value}%${original.planning.workProgressPercent.value === 100 && item.completion.value !== 'done' ? '・未完了' : ''}`)+`（見積 ${original.planning.estimatePoints.value === null ? '未入力' : `${original.planning.estimatePoints.value}pt`}）`)}${fact('担当', escape(original.planning.owner.value ?? '不明'))}${fact('余裕', reverse?.slackDisplay ?? '未算出')}${fact('既存分類', escape(original.category))}</dl>`;
      if (item.iterationOverflow) body += `<p class="warn">Iteration終了 ${original.planning.iteration.value.endDate} を${item.iterationOverflow.display}超過</p>`;
      if (item.diagnosticIds.length) body += `<h3>計算できない理由</h3>${diagnosticsHtml(item.diagnosticIds)}`;
      const incoming = result.edges.filter(edge => edge.to === key);
      const outgoing = result.edges.filter(edge => edge.from === key);
      const registered = [...new Set(incoming.flatMap(edge => edge.evidence.map(evidence => result.relations.find(relation => relation.id === evidence.relationId)?.prerequisiteKey)).filter(Boolean))];
      const hasAggregate = registered.some(k => source(k)?.children.keys.length);
      if (hasAggregate) {
        body += '<h3>開始条件</h3><p>親の開閉にかかわらず、配下の作業の完了を待つ。</p>';
        body += registered.filter(k => source(k)?.children.keys.length).map(k => `<details open><summary>${escape(title(k))} · ${source(k).state.value === 'closed' ? 'Closed' : 'Open'}</summary>${hierarchyHtml(k)}</details>`).join('');
      }
      const unlisted = incoming.filter(edge => !registered.some(k => source(k)?.children.keys.length && descendants(k).includes(edge.from)));
      if (!hasAggregate || unlisted.length) body += `<h3>前提</h3>${relationsHtml(unlisted, 'from')}`;
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
  return `<ul>${ids.map(id => result.diagnostics.find(item => item.id === id)).filter(Boolean).map(item => `<li>${source(item.key) && item.code !== 'dependency-cycle' ? taskLink(item.key) : ''}<span>${escape(diagnosticText(item))}</span>${item.code === 'dependency-cycle' ? `<ul>${result.cycles.find(c => c.diagnosticId === item.id)?.taskKeys.map(k => `<li>${taskLink(k)}</li>`).join('') || ''}</ul>` : ''}</li>`).join('')}</ul>`;
}
function relationsHtml(edges, direction) {
  return edges.length ? `<ul>${edges.map(edge => `<li>${edge.criticalByMilestone[milestone.key] ? '<span class="critical-mark" aria-label="クリティカルな接続">◆</span> ' : ''}${taskLink(edge[direction])}<span class="hint"> ${task(edge[direction])?.durationDisplay ?? '未算出'}</span></li>`).join('')}</ul>` : '<p>なし</p>';
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
  for (const bar of chart.querySelectorAll('[data-bar]')) {
    const item = task(bar.dataset.bar), start = calendarPosition(item.earliestStart), end = calendarPosition(item.earliestFinish);
    bar.style.setProperty('--start', `${percentage(start)}%`);
    bar.style.setProperty('--span', `${(end-start)/span*100}%`);
    const description = `${title(item.key)}、${positionText(item.earliestStart)}から${positionText(item.earliestFinish)}、${item.durationDisplay}`;
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
  const origin = chart.getBoundingClientRect(), bars = new Map([...chart.querySelectorAll('[data-bar]')].map(bar => [bar.dataset.bar, bar.getBoundingClientRect()]));
  $('#due-marker').style.top = `${$('#dates').getBoundingClientRect().bottom - origin.top}px`;
  const paths = result.edges.filter(edge => bars.has(edge.from) && bars.has(edge.to)).map(edge => {
    const from = bars.get(edge.from), to = bars.get(edge.to);
    const x1 = from.right-origin.left, y1 = from.top-origin.top+from.height/2, x2 = to.left-origin.left, y2 = to.top-origin.top+to.height/2;
    const critical = edge.criticalByMilestone[milestone.key];
    const turn = x1 + Math.max(7, Math.min(14, (x2-x1)/2));
    const axisLeft = $('#dates').getBoundingClientRect().left-origin.left;
    const d = x2 < axisLeft+12
      ? `M ${x1} ${y1} H ${turn} V ${to.top-origin.top-8} H ${x2+Math.min(14,to.width/2)} V ${to.top-origin.top}`
      : x2-x1 > 16 ? `M ${x1} ${y1} H ${turn} V ${y2} H ${x2}` : `M ${x1} ${y1} H ${turn} V ${y2-22} H ${x2-10} V ${y2} H ${x2}`;
    return `<path d="${d}" class="${critical ? 'critical-edge' : ''}" marker-end="url(#${options.arrowId})"/>`;
  }).join('');
  $('#connections').innerHTML = `<defs><marker id="${options.arrowId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z"/></marker></defs>`+paths;
  $('#connections').setAttribute('aria-label', result.edges.filter(e => milestone.taskKeys.includes(e.to)).map(e => `${title(e.from)} → ${title(e.to)}${e.criticalByMilestone[milestone.key] ? '（クリティカル）' : ''}`).join('、') || '依存なし');
}
const observer = new ResizeObserver(drawDependencies); observer.observe(chart);
for (const button of root.querySelectorAll('.scale-buttons button')) button.onclick = () => setScale(button.dataset.scale);
load();

return {
  redraw: drawDependencies,
  capture: () => ({ scale, history: dialog.open ? [...history] : [], scroll: $('.timeline-scroll').scrollLeft, opener: opener?.dataset.task || opener?.dataset.panel || (opener ? 'release' : null) }),
  restore: saved => {
    $('.timeline-scroll').scrollLeft = saved.scroll;
    if (saved.history.length) {
      const valid = saved.history.filter(key => ['release','overlaps','diagnostics','unchecked'].includes(key) || source(key));
      if (valid.length) { history = []; for(const key of valid) showDetails(key); dialog.showModal();
        opener = [...root.querySelectorAll('button')].find(b => b.dataset.task === saved.opener || b.dataset.panel === saved.opener) || $('[data-gantt="release-details"]');
      }
    }
  },
  destroy: () => { observer.disconnect(); if(dialog.open) dialog.close(); }
};
}
