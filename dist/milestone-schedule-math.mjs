// Finite decimal arithmetic: all scheduling decisions use scaled BigInt values.
function decimalParts(value) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  return { coefficient: BigInt(whole + fraction), places: fraction.length - Number(exponent) };
}

export function decimalMath(values) {
  const places = Math.max(2, ...values.filter(Number.isFinite).map(value => decimalParts(value).places + 2));
  const unit = 10n ** BigInt(places);
  const exact = value => {
    const parts = decimalParts(value);
    return parts.coefficient * 10n ** BigInt(places - parts.places);
  };
  const number = value => {
    const sign = value < 0n ? '-' : '';
    const digits = (value < 0n ? -value : value).toString().padStart(places + 1, '0');
    return Number(`${sign}${digits.slice(0, -places)}.${digits.slice(-places)}`);
  };
  const display = value => {
    const magnitude = value < 0n ? -value : value;
    const hundredths = (magnitude * 100n + unit / 2n) / unit;
    if (magnitude !== 0n && hundredths === 0n) return '0.01日未満';
    return `${hundredths / 100n}${hundredths % 100n ? '.' + String(hundredths % 100n).padStart(2, '0').replace(/0$/, '') : ''}日`;
  };
  return { unit, exact, number, display };
}

const DAY = 86400000;
export function dateDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time / DAY : null;
}
const weekday = day => ((day + 3) % 7 + 7) % 7; // Monday = 0
export const nextWeekday = day => day + (weekday(day) >= 5 ? 7 - weekday(day) : 0);
const previousWeekday = day => day - (weekday(day) >= 5 ? weekday(day) - 4 : 0);
const ordinal = day => Math.floor((day + 3) / 7) * 5 + Math.min(weekday(day), 5);
export const startCoordinate = (origin, day) => ordinal(nextWeekday(day)) - ordinal(origin);
export const endCoordinate = (origin, day) => ordinal(previousWeekday(day)) + 1 - ordinal(origin);
export function dayString(day) {
  const date = new Date(day * DAY);
  if (!Number.isFinite(date.getTime())) return null;
  const value = date.toISOString().split('T')[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
function addWeekdays(origin, count) {
  const weeks = Math.floor(count / 5);
  const rest = count - weeks * 5;
  return origin + weeks * 7 + rest + (weekday(origin) + rest >= 5 ? 2 : 0);
}
export function position(origin, value, math, finish = false, duration = 0n) {
  let dayOffset = value / math.unit;
  let fraction = value % math.unit;
  let boundary = fraction === 0n ? 'start' : 'within';
  if (finish && duration > 0n && fraction === 0n) {
    dayOffset -= 1n;
    fraction = math.unit;
    boundary = 'end';
  }
  return { coordinate: math.number(value), date: dayString(addWeekdays(origin, Number(dayOffset))), fraction: math.number(fraction), boundary };
}
