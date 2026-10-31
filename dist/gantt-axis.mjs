const dayMs = 86400000;
export const parseDate = date => new Date(`${date}T00:00:00Z`);
export const addDays = (date, count) => new Date(date.getTime() + count * dayMs);
export const monthDay = date => `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
export const isoDate = date => date.toISOString().slice(0, 10);
export function positionText(position) {
  if (!position) return '未算出';
  const boundary = { start: '開始', end: '終了', within: `日内${Number((position.fraction * 100).toFixed(8))}%` }[position.boundary];
  return `${position.date.replaceAll('-', '/')} ${boundary}`;
}
// Fractions are positions in a workday, not clock times. Weekends retain calendar width.
export const calendarPosition = position => parseDate(position.date).getTime() + position.fraction * dayMs;
export function axisFor(result, milestone, scale) {
  const tasks = result.tasks.filter(task => milestone.taskKeys.includes(task.key));
  const values = [parseDate(result.calculationStartDate).getTime(), ...tasks.flatMap(task => [task.earliestStart, task.earliestFinish].filter(Boolean).map(calendarPosition))];
  if (milestone.dueDate) values.push(parseDate(milestone.dueDate).getTime() + dayMs);
  const first = new Date(Math.min(...values)), last = Math.max(...values);
  let start = addDays(first, -((first.getUTCDay() + 6) % 7));
  let end = addDays(start, scale === 'day' ? 7 : 28);
  if (scale === 'month') {
    start = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
    end = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 3, 1));
    while (end.getTime() <= last) end = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 1));
  } else {
    while (end.getTime() <= last) end = addDays(end, 7);
  }
  const ticks = [];
  for (let tick = start; tick < end;) {
    const next = scale === 'month' ? new Date(Date.UTC(tick.getUTCFullYear(), tick.getUTCMonth() + 1, 1)) : addDays(tick, scale === 'week' ? 7 : 1);
    ticks.push({ start: tick, end: next }); tick = next;
  }
  return { start, end, ticks, width: scale === 'day' ? ticks.length * 56 : Math.max(504, ticks.length * (scale === 'week' ? 126 : 168)) };
}
export const dueText = difference => !difference ? '期日差 未算出' : difference.relation === 'on-time' ? '期日どおり' : `${difference.display}${difference.relation === 'late' ? '超過' : '余裕'}`;
const fields = { workProgressPercent: '作業進捗率', estimatePoints: '見積', iteration: 'Iteration', sourceProjectId: '出典Project', source: '出典Project', completion: '完了判定', owner: '担当', children: '子Issue', blockedBy: '前提', schedule: '日程', dueDate: '期日', dependencies: '依存関係', parent: '親Issue' };
const codes = { 'missing-value': '未入力', 'not-fetched': '未取得', forbidden: '取得権限なし', failed: '取得失敗', 'invalid-value': '不正な値', 'invalid-date': '不正な日付', 'dependency-cycle': '循環', 'out-of-range': '表示可能な範囲外', unselected: '未指定', unavailable: '取得不能', 'not-member': '所属なし', 'incomplete-list': '取得不足', 'unknown-completion': '未確定', 'missing-reference': '参照先未取得' };
export const diagnosticText = diagnostic => `${fields[diagnostic.field] || diagnostic.field}：${codes[diagnostic.code] || diagnostic.code}`;
