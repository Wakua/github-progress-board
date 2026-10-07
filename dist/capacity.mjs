// 担当者ごとの作業量の上限。定義は docs/specification.md の「担当別の負荷」に従う。
export const POINTS_PER_WORKDAY = 1;
const DAY = 86400000;
const round = value => Number(value.toPrecision(12));
const dayIndex = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value ? milliseconds / DAY : null;
};
// 1970-01-05（月曜日）を起点に、起点から数えた index 未満の平日の数。負の index も数える。
const weekdaysBefore = index => {
  const weeks = Math.floor((index - 4) / 7), rest = index - 4 - weeks * 7;
  return weeks * 5 + Math.min(rest, 5);
};
const weekdaysBetween = (first, last) => weekdaysBefore(last + 1) - weekdaysBefore(first);

// 期間の上限。予定の期間は全期間の平日、進行中の期間は今日を含む残りの平日、終了した期間と日付不明は比べない。
export function capacityLimit({ startDate, durationDays }, today) {
  const none = phase => ({ phase, days: null, points: null });
  const start = dayIndex(startDate), current = dayIndex(today);
  if (start === null || current === null || !Number.isSafeInteger(durationDays) || durationDays <= 0) return none('unknown');
  const end = start + durationDays - 1;
  if (!Number.isFinite(new Date(end * DAY).getTime())) return none('unknown');
  if (current > end) return none('past');
  const upcoming = current < start;
  const days = weekdaysBetween(upcoming ? start : current, end);
  return { phase: upcoming ? 'upcoming' : 'active', days, points: days * POINTS_PER_WORKDAY };
}

// 見積のない作業（null）は合計に含めず、件数を数える。points は、すべてに見積があるときだけ合計になる。
export function sumEstimates(values) {
  const known = values.filter(value => value !== null);
  const knownPoints = round(known.reduce((sum, value) => sum + value, 0));
  const missingEstimates = values.length - known.length;
  return { missingEstimates, knownPoints, points: missingEstimates ? null : knownPoints };
}

// 確認できた合計が上限を超えれば超過。超えていなければ、見積のない作業があるうちは収まるとは判定しない。
export function assessLoad({ knownPoints, missingEstimates }, limit) {
  if (!limit || limit.points === null) return null;
  const base = { limit: limit.points, days: limit.days, phase: limit.phase };
  if (knownPoints > limit.points) return { ...base, status: 'over', excess: round(knownPoints - limit.points), atLeast: missingEstimates > 0 };
  if (missingEstimates) return { ...base, status: 'unknown' };
  return { ...base, status: 'within', margin: round(limit.points - knownPoints) };
}
