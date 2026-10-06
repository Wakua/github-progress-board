// ③ 要対応：人が手を入れる場所を並べる。「承認待ちのPR」「あなたの担当」「要対応」の3つのまとまりに分ける。
// 要対応かどうかの判定は engine.mjs と github-work.mjs が行う。ここは表示の文言と並びだけを持つ。
// 解除に必要な対応は docs/attention-release-behavior.md の表に従う。
const DAY = 86400000;
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// manual：手動計画（ツール内で操作）、github：GitHubの計画（GitHub上で操作し、再取得で反映）。null は該当しない。
const RELIEF = [
  { test: /^判断待ち：/, manual: '判断を記録する', github: null },
  { test: /^待ち：/, manual: '待ちを解除する', github: null },
  { test: /^状態が未確認$/, manual: '状態を更新する', github: null },
  { test: /^状態が未確認：Projectに未登録/, manual: null, github: 'Projectに登録する' },
  { test: /^状態が未確認：ProjectごとにStatusが異なる/, manual: null, github: 'Statusを揃える' },
  { test: /^状態が未確認：Status/, manual: null, github: 'Statusを設定する' },
  { test: /^仕様待ち：/, manual: null, github: '仕様を決める' },
  { test: /^期限超過/, manual: '割当を変えるか完了にする', github: 'Iterationを変えるか閉じる' },
  { test: /^前提(が|の)期限超過：/, manual: '前提を進める', github: '前提を進める' },
  { test: /^作業中なのに担当者がいない/, manual: '担当を決める', github: '担当を決める' },
  { test: /^作業中なのに前提が未完了/, manual: '未着手に戻すか前提を完了する', github: 'Todoに戻すか前提を閉じる' },
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

const row = (nameHtml, action) => `<li class="my-work-row attention-row"><div class="my-work-main">${nameHtml}${action ? `<span class="attention-relief">→ ${esc(action)}</span>` : ''}</div></li>`;
const prLink = pr => `<a class="issue-name" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">#${pr.number} ${esc(pr.title)}</a>`;

// model：{ approvals: [{number, title, url}] | null, owners: [名前], me: 名前 | null, mine: [{nameHtml}], items: [{nameHtml, reasons, endedOn}] }
export function attentionCount(model) {
  return (model.approvals?.length ?? 0) + model.mine.length + model.items.length;
}
// 順は、承認待ちのPR → 要対応（期限切れの古い順）→「あなた」の担当。
export function attentionPanelMarkup(model, kind) {
  const chips = model.owners.length ? `<div class="owner-filter attention-me" role="group" aria-label="あなたの担当者名"><span class="attention-me-label">あなた：</span>${model.owners.map(owner => `<button type="button" class="owner-choice" data-attention-me="${esc(owner)}" aria-pressed="${owner === model.me}">${esc(owner)}</button>`).join('')}</div>` : '';
  const rows = [
    ...(model.approvals ?? []).map(pr => row(prLink(pr), '承認')),
    ...orderAttention(model.items).map(item => row(item.nameHtml, [...new Set(item.reasons.map(reason => reliefFor(reason, kind)))].join('・'))),
    ...model.mine.map(item => row(item.nameHtml, '')),
  ];
  return chips + (rows.length ? `<section class="my-work-section needs-action"><ul class="my-work-list">${rows.join('')}</ul></section>` : '<p class="empty-message">手が要る作業はありません。</p>');
}
