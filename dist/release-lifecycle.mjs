// Milestoneの説明で明示された受入と公開版だけを読む。
function records(description) {
  const fields = { '受入': [], '公開版': [] };
  let fence = '', htmlEnd = '', quoted = false;
  for (const line of (description ?? '').split(/\r\n?|\n/)) {
    if (fence) {
      const closing = line.match(/^ {0,3}(\x60+|~+)[ \t]*$/)?.[1];
      if (closing?.startsWith(fence)) fence = '';
      continue;
    }
    if (htmlEnd) {
      if (line.toLowerCase().includes(htmlEnd)) htmlEnd = '';
      continue;
    }
    const delimiter = line.match(/^ {0,3}(\x60{3,}|~{3,})/);
    if (delimiter) { fence = delimiter[1]; continue; }
    const html = line.match(/<!--|<(pre|code|details|blockquote)\b/i);
    if (html) {
      const end = html[1] ? '</' + html[1].toLowerCase() + '>' : '-->';
      if (!line.toLowerCase().slice(html.index + html[0].length).includes(end)) htmlEnd = end;
      continue;
    }
    // 引用やリストの段落は、行頭記号を省略した次の行もその段落に属する。
    if (!line.trim()) quoted = false;
    if (/^ {0,3}(?:>|[-+*] |\d+[.)] )/.test(line)) quoted = true;
    if (quoted) continue;
    const row = line.match(/^(受入|公開版):[ \t]*(.*)$/);
    if (row) fields[row[1]].push(row[2].trimEnd());
  }
  return fields;
}

function sameRepositoryRelease(value, milestoneUrl) {
  if (!value) return null;
  const repository = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/milestone\/[1-9]\d*$/i.exec(milestoneUrl)?.[1];
  const release = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/tag\/([^\s?#\\<>"\x60]+)$/.exec(value);
  if (!repository || !release || release[1].toLowerCase() !== repository.toLowerCase()) return null;
  let tag;
  try { tag = decodeURIComponent(release[2]); } catch { return null; }
  // タグはスラッシュを含められる。ドット区間やGitで使えない参照名はリンクにしない。
  if (tag.endsWith('.') || tag.includes('..') || tag.includes('@{') || /[\x00-\x20\x7f~^:?*\[\\]/.test(tag) ||
      tag.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) return null;
  return { tag, url: value };
}

export function releaseLifecycle(milestone) {
  const { 受入: acceptance, 公開版: releases } = records(milestone.description);
  const record = acceptance.length === 1 ? acceptance[0] : null;
  const accepted = record === '済';
  return { accepted, label: accepted ? '受入済み' : record === '確認中' ? '受入確認中' : '受入未記録',
    published: releases.length === 1 ? sameRepositoryRelease(releases[0], milestone.url) : null };
}
