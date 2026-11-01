import { diagnosticReason, diagnosticText, monthDay, parseDate } from './gantt-axis.mjs';
import { dateDay } from './milestone-schedule-math.mjs';

function issueRef(key, milestoneKey) {
  const issue = /^https:\/\/github\.com\/(.+)\/issues\/(\d+)$/.exec(key);
  if (!issue) return '';
  return (milestoneKey.startsWith('https://github.com/' + issue[1] + '/milestone/') ? '' : issue[1]) + '#' + issue[2];
}

const missingField = { estimatePoints:'見積', iteration:'割当期間', workProgressPercent:'作業進捗率' };

function causeExamples(result, milestone) {
  const ids = new Set(milestone.diagnosticIds);
  const groups = new Map();
  for (const cause of result.diagnostics) {
    if (!ids.has(cause.id)) continue;
    if (!groups.has(cause.key)) groups.set(cause.key, []);
    groups.get(cause.key).push(cause);
  }
  const examples = [];
  for (const [key, causes] of groups) {
    const missing = Object.keys(missingField).filter(field => causes.some(c => c.field === field && c.code === 'missing-value'));
    const reasons = missing.length ? [missing.map(field => missingField[field]).join('・') + 'が未入力'] : [];
    for (const cause of causes) {
      if (missing.includes(cause.field) && cause.code === 'missing-value') continue;
      if (cause.code === 'dependency-cycle') {
        const members = cause.details.taskKeys.map(key => issueRef(key, milestone.key));
        reasons.push(members.slice(0, 2).join('・') + (members.length > 2 ? 'など' : '') + ' の前提が循環');
      } else if (key === milestone.key && cause.field === 'tasks') {
        reasons.push('リリースの作業一覧：' + diagnosticReason(cause.code));
      } else {
        reasons.push(diagnosticText(cause));
      }
    }
    const label = causes.every(c => c.code === 'dependency-cycle') ? '' : issueRef(key, milestone.key);
    examples.push([label, reasons.join('、')].filter(Boolean).join(' '));
    if (examples.length === 2) break;
  }
  return examples;
}

function overdueAllocation(milestone, sources) {
  const due = milestone.dueDate;
  if (dateDay(due) === null) return null;
  const dateLabel = date => date.slice(0,4) === due.slice(0,4) ? monthDay(parseDate(date)) : date.replaceAll('-', '/');
  let crossing = null;
  for (const key of milestone.targetTaskKeys) {
    const issue = sources.get(key);
    if (issue?.completion.value !== 'not-done') continue;
    const plan = issue.planning;
    if (plan.sourceProblem || !plan.sourceProjectId || plan.iteration.problem || !plan.iteration.value) continue;
    const { startDate, endDate } = plan.iteration.value;
    if (dateDay(startDate) === null || dateDay(endDate) === null || endDate < startDate) continue;
    const ref = issueRef(key, milestone.key);
    if (startDate > due) return ref + ' の割当開始は' + dateLabel(startDate) + '（期日後）';
    if (endDate > due && !crossing) crossing = ref + ' の割当期間は' + dateLabel(endDate) + 'まで（期日をまたぐ）';
  }
  return crossing;
}

// The calendar, causes and membership come from this release's calculation. Allocation is a plan, not a forecast.
export function incompleteForecast(result, milestone, sources) {
  if (milestone.state !== 'incomplete') return null;
  return {
    label: dateDay(milestone.dueDate) !== null ? '期日内に終わるか判断できません' : '完了見込みを判断できません',
    causes: causeExamples(result, milestone),
    allocation: overdueAllocation(milestone, sources),
  };
}
