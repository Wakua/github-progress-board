// Issue本文とMilestone説明で、引用・例の外に明示された記録だけを読む。
function skipHtml(line, stack) {
  if (!stack.length && !/^\s*</.test(line) && !/<!--|<(?:pre|code|details|blockquote)\b/i.test(line)) return false;
  const tokens = line.matchAll(/<!--|-->|<(\/?)([a-z][\w-]*)(?=[\s/>])[^>]*>/gi);
  for (const token of tokens) {
    if (stack.at(-1) === '!--') { if (token[0] === '-->') stack.pop(); continue; }
    if (token[0] === '<!--') { stack.push('!--'); continue; }
    const name = token[2]?.toLowerCase();
    if (!name) continue;
    if (token[1]) { if (name === stack.at(-1)) stack.pop(); }
    else if (!/\/\s*>$/.test(token[0]) && !/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name)) stack.push(name);
  }
  return true;
}

function records(description) {
  const fields = { '受入': [], '公開版': [] };
  const html = [];
  let fence = '', inlineCode = 0, quoted = false;
  for (const line of (description ?? '').split(/\r\n?|\n/)) {
    if (fence) {
      const closing = line.match(/^ {0,3}(\x60+|~+)[ \t]*$/)?.[1];
      if (closing?.startsWith(fence)) fence = '';
      continue;
    }
    if (html.length) { skipHtml(line, html); continue; }
    const delimiter = line.match(/^ {0,3}(\x60{3,}|~{3,})/);
    if (delimiter) { fence = delimiter[1]; continue; }
    // 引用やリストの段落は、行頭記号を省略した次の行もその段落に属する。
    if (!line.trim()) quoted = false;
    if (/^ {0,3}(?:>|[-+*] |\d+[.)] )/.test(line)) quoted = true;
    if (quoted) continue;
    // Markdownのコード範囲は複数行にもまたがる。
    if (!line.trim()) inlineCode = 0;
    const wasCode = inlineCode > 0;
    let outsideCode = wasCode ? '\x60' : '', from = 0;
    for (const match of line.matchAll(/\x60+/g)) {
      const escapes = line.slice(0, match.index).match(/\\+$/)?.[0].length ?? 0;
      if (!inlineCode && escapes % 2) continue;
      if (inlineCode === match[0].length) {
        inlineCode = 0;
        from = match.index + match[0].length;
      } else if (!inlineCode) {
        outsideCode += line.slice(from, match.index) + '\x60';
        inlineCode = match[0].length;
      }
    }
    if (!inlineCode) outsideCode += line.slice(from);
    // コード内のタグをHTMLの開始として扱わない。
    if (skipHtml(outsideCode, html)) continue;
    if (wasCode || inlineCode) continue;
    const row = line.match(/^(受入|公開版):[ \t]*(.*)$/);
    if (row) fields[row[1]].push(row[2].trimEnd());
  }
  return fields;
}

export function issueAcceptancePending(body) {
  if (!body?.includes('受入:')) return false;
  const acceptance = records(body).受入;
  return acceptance.length === 1 && acceptance[0] === '確認待ち';
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
