// ③ 要対応：人が手を入れるものを、一つの一覧に並べる。各行は、作業名と短い理由だけ。
// 要対応かどうかの判定は engine.mjs と github-work.mjs が行う。ここは表示の文言と並びだけを持つ。
const DAY = 86400000;
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 要対応の理由を、専門用語を使わない短い言葉にする。何をするかは書かない（理由が分かれば、人が決められる）。
const LABELS = [
  [/^判断待ち：/, '判断待ち'],
  [/^待ち：/, '待ち'],
  [/^状態が未確認：Projectに未登録/, 'Project未登録'],
  [/^状態が未確認/, '状態が不明'],
  [/^仕様待ち：/, '仕様待ち'],
  [/^期限超過/, '期限切れ'],
  [/^前提(が|の)期限超過：/, '前提が期限切れ'],
  [/^作業中なのに担当者がいない/, '担当なし'],
  [/^作業中なのに前提が未完了/, '前提が未完了'],
];
export const FALLBACK_LABEL = '要確認';
// 「あなたの担当」に入れる作業のまとまり。要対応と前提待ち、完了は入れない（要対応は別のまとまりに出す）。
export const MINE_GROUPS = ['active', 'review', 'ready-now', 'ready-later'];

export function labelFor(reason) {
  return LABELS.find(([test]) => test.test(reason))?.[1] ?? FALLBACK_LABEL;
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

const row = (nameHtml, label) => `<li class="my-work-row attention-row"><div class="my-work-main">${nameHtml}${label ? `<span class="attention-label">${esc(label)}</span>` : ''}</div></li>`;
const prLink = pr => `<a class="issue-name" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">#${pr.number} ${esc(pr.title)}</a>`;

// model：{ approvals: [{number, title, url}] | null, owners: [名前], me: 名前 | null, mine: [{nameHtml}], items: [{nameHtml, reasons, endedOn}] }
export function attentionCount(model) {
  return (model.approvals?.length ?? 0) + model.mine.length + model.items.length;
}
// 順は、承認待ちのPR → 要対応（期限切れの古い順）→「あなた」の担当。
export function attentionPanelMarkup(model) {
  const chips = model.owners.length ? `<div class="owner-filter attention-me" role="group" aria-label="あなたの担当者名"><span class="attention-me-label">あなた：</span>${model.owners.map(owner => `<button type="button" class="owner-choice" data-attention-me="${esc(owner)}" aria-pressed="${owner === model.me}">${esc(owner)}</button>`).join('')}</div>` : '';
  const rows = [
    ...(model.approvals ?? []).map(pr => row(prLink(pr), '承認待ち')),
    ...orderAttention(model.items).map(item => row(item.nameHtml, [...new Set(item.reasons.map(labelFor))].join('・'))),
    ...model.mine.map(item => row(item.nameHtml, '')),
  ];
  return chips + (rows.length ? `<section class="my-work-section needs-action"><ul class="my-work-list">${rows.join('')}</ul></section>` : '<p class="empty-message">手が要る作業はありません。</p>');
}
