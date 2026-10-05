// ③ 要対応：人が手を入れる場所を並べる。「承認待ちのPR」「あなたの担当」「要対応」の3つのまとまりに分ける。
// 要対応かどうかの判定は engine.mjs と github-work.mjs が行う。ここは表示の文言と並びだけを持つ。
// 解除に必要な対応は docs/attention-release-behavior.md の表に従う。
const DAY = 86400000;
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// manual：手動計画（ツール内で操作）、github：GitHubの計画（GitHub上で操作し、再取得で反映）。null は該当しない。
const RELIEF = [
  { test: /^判断待ち：/, manual: '判断する人が判断を記録する', github: null },
  { test: /^待ち：/, manual: '理由を読み、待ちを解除するか、計画を見直す', github: null },
  { test: /^状態が未確認$/, manual: '状態を確かめて、未着手などに更新する', github: null },
  { test: /^状態が未確認：Projectに未登録/, manual: null, github: 'IssueをProjectに登録し、Statusを設定する' },
  { test: /^状態が未確認：ProjectごとにStatusが異なる/, manual: null, github: 'ProjectごとのStatusを揃える' },
  { test: /^状態が未確認：Status/, manual: null, github: 'StatusをTodo・In Progress・Doneのいずれかにする' },
  { test: /^仕様待ち：/, manual: null, github: '仕様のIssueの担当が仕様を決め、仕様書に書いてIssueを閉じる' },
  { test: /^期限超過/, manual: '割当のイテレーションを変えるか、完了にする', github: 'ProjectのIterationを変えるか、Issueを閉じてStatusをDoneにする' },
  { test: /^前提(が|の)期限超過：/, manual: '前提を完了するか、前提の割当を変える', github: '前提のIterationを変えるか、前提を閉じる' },
  { test: /^作業中なのに担当者がいない/, manual: '担当者を設定する', github: 'Projectの「担当」を設定する' },
  { test: /^作業中なのに前提が未完了/, manual: '作業を未着手に戻す、前提を完了する、または依存関係を修正する', github: 'StatusをTodoに戻す、前提を閉じる、またはblocked byを修正する' },
];
export const FALLBACK_RELIEF = '当たった条件を解消する';
// 「あなたの担当」に入れる作業のまとまり。要対応と前提待ち、完了は入れない（要対応は別のまとまりに出す）。
export const MINE_GROUPS = ['active', 'review', 'ready-now', 'ready-later'];

// kind は 'manual' か 'github'。条件が残る限り要対応のままなので、条件を解消する操作だけを示す。
export function reliefFor(reason, kind) {
  const entry = RELIEF.find(item => item.test.test(reason));
  return entry?.[kind] ?? FALLBACK_RELIEF;
}

// 手動計画の「期限超過（N日）」から、期間が終わった日を求める。
export function manualEndedOn(reasons, today) {
  for (const reason of reasons) {
    const match = /^期限超過（(\d+)日）/.exec(reason);
    if (match) return new Date(Date.parse(today + 'T00:00:00Z') - Number(match[1]) * DAY).toISOString().slice(0, 10);
  }
  return null;
}

// 期限切れの古い作業を上に置く。期限超過に当たらない作業は、その後ろに元の順で置く（暫定）。
export function orderAttention(items) {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const x = a.item.endedOn, y = b.item.endedOn;
      if (x && y) return x.localeCompare(y) || a.index - b.index;
      if (x) return -1;
      if (y) return 1;
      return a.index - b.index;
    }).map(({ item }) => item);
}

export function attentionRow({ nameHtml, metaHtml, reasons }, kind) {
  const list = reasons.map(reason => `<li><span class="attention-reason">${esc(reason)}</span><span class="attention-relief">→ ${esc(reliefFor(reason, kind))}</span></li>`).join('');
  return `<li class="my-work-row attention-row"><div class="my-work-main">${nameHtml}<ul class="attention-reasons">${list}</ul></div><div class="my-work-meta">${metaHtml}</div></li>`;
}
const approvalRow = pr => `<li class="my-work-row attention-row"><div class="my-work-main"><a class="issue-name" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">#${pr.number} ${esc(pr.title)}</a></div></li>`;
const state = label => { const text = label.replace(/（.*）/, ''); return text === '着手可能' ? '' : `<ul class="attention-reasons"><li><span class="attention-state">${esc(text)}</span></li></ul>`; };
const mineRow = ({ nameHtml, metaHtml, label }) => `<li class="my-work-row attention-row"><div class="my-work-main">${nameHtml}${state(label)}</div><div class="my-work-meta">${metaHtml}</div></li>`;

const section = (id, title, count, body, extra = '', suffix = '') => `<section class="my-work-section ${extra}" data-attention-section="${id}"><h3>${esc(title)} <span class="my-work-count">${count}件${suffix}</span></h3><ul class="my-work-list">${body}</ul></section>`;

// model：{ approvals: [{number, title, url}] | null, approvalLimit: 数 | undefined, owners: [名前], me: 名前 | null, mine: [{nameHtml, metaHtml, label}], items: [要対応の行] }
export function attentionCount(model) {
  return (model.approvals?.length ?? 0) + model.mine.length + model.items.length;
}
export function attentionPanelMarkup(model, kind) {
  const items = orderAttention(model.items), approvals = model.approvals ?? [];
  const chips = model.owners.length ? `<div class="owner-filter attention-me" role="group" aria-label="あなたの担当者名"><span class="attention-me-label">あなた：</span>${model.owners.map(owner => `<button type="button" class="owner-choice" data-attention-me="${esc(owner)}" aria-pressed="${owner === model.me}">${esc(owner)}</button>`).join('')}</div>` : '';
  const head = chips;
  const parts = [];
  if (approvals.length) parts.push(section('approvals', '承認待ちのPR', approvals.length, approvals.map(approvalRow).join(''), 'needs-action', model.approvalLimit ? ` / 上限${model.approvalLimit}件` : ''));
  if (model.me) parts.push(model.mine.length ? section('mine', `${model.me}の担当`, model.mine.length, model.mine.map(mineRow).join('')) : `<p class="empty-message">${esc(model.me)}の未完了の作業はありません。</p>`);
  if (items.length) parts.push(section('attention', '要対応', items.length, items.map(item => attentionRow(item, kind)).join(''), 'needs-action'));
  if (!approvals.length && !items.length && !model.mine.length) parts.push('<p class="empty-message">手が要る作業はありません。</p>');
  return head + parts.join('');
}
