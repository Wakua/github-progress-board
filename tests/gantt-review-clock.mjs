// Loaded only by the fictional QA server's /qa-clock page, before the product modules.
// Change Date in this page only. Native timer delays and product callbacks stay intact.
const NativeDate = window.Date;
const nativeInterval = window.setInterval.bind(window);
let now = NativeDate.parse('2026-11-02T23:59:59+09:00');
const timers = [];
window.Date = new Proxy(NativeDate, {
  apply: () => new NativeDate(now).toString(),
  construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now], newTarget),
  get: (target, key) => key === 'now' ? () => now : Reflect.get(target, key),
});
window.setInterval = (callback, delay, ...args) => {
  if (typeof callback !== 'function') return nativeInterval(callback, delay, ...args);
  const record = { name: callback.name || '(anonymous)', delay, ticks: 0, lastRealTime: null };
  timers.push(record);
  return nativeInterval((...values) => {
    record.ticks++;
    record.lastRealTime = new NativeDate().toISOString();
    return callback(...values);
  }, delay, ...args);
};
document.addEventListener('DOMContentLoaded', () => {
  const panel = document.createElement('aside');
  panel.id = 'qa-clock';
  panel.style.cssText = 'padding:12px;border:1px solid #777';
  panel.innerHTML = '<strong>検証用の模擬時計</strong> <label>日時 <input id="qa-clock-input" value="2026-11-02T23:59:59+09:00" size="30"></label> <button id="qa-clock-apply">時計だけを変更</button> <button id="qa-clock-visible">表示復帰イベントを送る</button><pre id="qa-clock-state"></pre>';
  document.body.prepend(panel);
  const output = panel.querySelector('#qa-clock-state');
  const show = () => { output.textContent = JSON.stringify({ simulatedNow: new NativeDate(now).toISOString(), realNow: new NativeDate().toISOString(), timers }, null, 2); };
  panel.querySelector('#qa-clock-apply').onclick = () => {
    const next = NativeDate.parse(panel.querySelector('#qa-clock-input').value);
    if (Number.isFinite(next)) now = next;
    show();
  };
  // Synthetic event, not a claim that the OS/browser actually suspended the page.
  panel.querySelector('#qa-clock-visible').onclick = () => document.dispatchEvent(new Event('visibilitychange'));
  nativeInterval(show, 250);
  show();
});
