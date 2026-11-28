// 一覧の作業に人が付ける「次にすること」の区分。プロジェクトの保存データに持ち、GitHubへは書き込まない。
// project.nextActions は { Issue番号: 区分のid } で、区分を外した作業は持たない。
export const NEXT_ACTIONS = [
  { id: 'done', label: '終わっている', next: 'Issueを閉じる' },
  { id: 'branch', label: '別のブランチで作業中', next: '待つ（何もしない）' },
  { id: 'verify', label: 'やったはず', next: '終わっているか確かめる' },
  { id: 'accept', label: '受入確認する', next: '動作を確認し、受け入れるかを判断する' },
  { id: 'spec', label: '仕様を決める', next: '仕様を決める' },
  { id: 'ai', label: 'AIに渡す', next: 'AIに渡す' },
  { id: 'person', label: '他の人に渡す', next: '他の人に渡す' },
  { id: 'schedule', label: '決める時期を決める', next: '仕様を決める時期を決める' },
  { id: 'later', label: '後回しでよい', next: '今は見ない' },
];
export const MAX_NEXT_ACTIONS = 5000;
const byId = new Map(NEXT_ACTIONS.map(action => [action.id, action]));
export const nextActionOf = id => byId.get(id) ?? null;
export const isNextActionId = id => typeof id === 'string' && byId.has(id);
export const isIssueNumber = value => /^[1-9]\d{0,8}$/.test(String(value));
export function isNextActions(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length <= MAX_NEXT_ACTIONS && keys.every(key => isIssueNumber(key) && isNextActionId(value[key]));
}

// AIへ渡す文。区分の「次にすること」を先頭に置き、作業ごとに番号・題名・状態・根拠を1行で示す。
// repository：「owner/repo」。items：[{ number, title, status, basis }]。
export function nextActionCopyText(repository, action, items) {
  const lines = [`次にすること：${action.next}（区分：${action.label}、${items.length}件）`];
  if (repository) lines.push(`repository：${repository}`);
  for (const item of items) lines.push(`- #${item.number} ${item.title}｜${item.status}｜根拠：${item.basis}`);
  return lines.join('\n');
}
