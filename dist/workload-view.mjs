// 担当別の負荷の表示部品。手動計画（app.mjs）とGitHubの計画（github-planning-view.mjs）で共有する。
import { POINTS_PER_WORKDAY } from './capacity.mjs';
export const points = value => `${Number(value.toPrecision(12))}pt`;
const atLeast = load => load.atLeast ? '以上' : '';
// 上限の根拠。進行中の期間は残りの稼働日、予定の期間は期間全体の稼働日を数える。
export const loadBasis = load => `${load.phase === 'active' ? '残りの稼働日' : '稼働日'}${load.days}日 × ${POINTS_PER_WORKDAY}pt`;
export const workloadChipClass = row => `workload-chip${row.load?.status === 'over' ? ' is-over' : ''}`;
export const workloadChipTitle = row => row.load ? `上限${points(row.load.limit)}（${loadBasis(row.load)}）` : '';
export function workloadChipLabel(row) {
  const load = row.load;
  return `${row.owner || '未担当'}の未完了作業${load ? `。上限${points(load.limit)}${load.status === 'over' ? `、超過${points(load.excess)}${atLeast(load)}` : ''}` : ''}`;
}
// 担当者名のあとに並べる値：未完了の合計、上限、超過量。上限を当てない行は合計だけを示す。
export function workloadFigures(row) {
  const value = row.points === null ? `<span class="workload-unknown">未入力<small>${row.missingEstimates}件</small></span>` : points(row.points);
  const load = row.load;
  if (!load) return `<strong>${value}</strong>`;
  return `<strong>${value}</strong><span class="workload-limit">/ ${points(load.limit)}</span>${load.status === 'over' ? `<span class="workload-over">超過${points(load.excess)}${atLeast(load)}</span>` : ''}`;
}
// 詳細パネルの上限の欄。
export function workloadLimitMarkup(load) {
  if (!load) return '';
  const result = load.status === 'over' ? `<dt>超過</dt><dd class="workload-over">${points(load.excess)}${atLeast(load)}</dd>`
    : `<dt>余裕</dt><dd>${load.status === 'within' ? points(load.margin) : '未入力のため未確認'}</dd>`;
  return `<dl class="snapshot-facts workload-detail-limit"><dt>上限</dt><dd>${points(load.limit)}<small>${loadBasis(load)}</small></dd>${result}</dl>`;
}
