// ③ 要対応：人が手を入れないと進まない作業と、条件を解消する操作を並べる。
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
  const list = reasons.map(reason => `<li><span class="attention-reason">${esc(reason)}</span><span class="attention-relief">解除：${esc(reliefFor(reason, kind))}</span></li>`).join('');
  return `<li class="my-work-row attention-row"><div class="my-work-main">${nameHtml}<ul class="attention-reasons">${list}</ul></div><div class="my-work-meta">${metaHtml}</div></li>`;
}

const NOTES = {
  manual: '手動の計画は、ツール内で操作して解除します。前提待ちは含みません。',
  github: 'GitHubの計画は読み取り専用です。GitHub上で変更し、「GitHubを再取得」で反映します。前提待ちは含みません。',
};
export function attentionPanelMarkup(items, kind) {
  const ordered = orderAttention(items);
  const heading = `<div class="attention-head"><h2>要対応 <span class="my-work-count">${ordered.length}件</span></h2><p class="footnote">${esc(NOTES[kind])}</p></div>`;
  if (!ordered.length) return `${heading}<p class="empty-message">要対応の作業はありません。</p>`;
  return `${heading}<section class="my-work-section needs-action" data-attention-list><ul class="my-work-list">${ordered.map(item => attentionRow(item, kind)).join('')}</ul></section>`;
}
