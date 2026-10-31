import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const categories = ['情報量', '判断の手掛かり', '操作'];
const states = ['確認済み', '要修正', '未確認', '対象外'];
const shaPattern = /^[0-9a-f]{40}$/i;
const empty = value => !value?.trim() || /^(?:-|—|なし|未記入|未確認|TODO|TBD|N\/?A|\.\.\.|…|<[^>]+>)$/i.test(value.trim());
const hasReason = value => /^理由:\s*\S/.test(value) && !empty(value.replace(/^理由:\s*/, ''));
const fileExists = path => { try { return statSync(path).isFile(); } catch { return false; } };

// コメントやコード例を、実際の提出記録として数えない。
function visibleMarkdown(markdown) {
  return markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '');
}

function section(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `## ${heading}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function tableRows(markdown) {
  return markdown.split(/\r?\n/).filter(line => /^\s*\|.*\|\s*$/.test(line))
    .map(line => line.trim().slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|')))
    .filter(cells => !cells.every(cell => /^:?-+:?$/.test(cell)));
}

export function readQuestions(markdown) {
  const rows = tableRows(markdown).filter(row => /^[IJO][1-9][0-9]*$/.test(row[0]));
  if (rows.length === 0 || new Set(rows.map(row => row[0])).size !== rows.length ||
      rows.some(row => row.length !== 4 || !categories.includes(row[1]) || empty(row[2])) ||
      categories.some(category => !rows.some(row => row[1] === category))) {
    throw new Error('必須の問いの表を読めない（ID・項目・問い・整理元を確認する）');
  }
  return rows.map(([id, category]) => ({ id, category }));
}

// 新規ファイルも検出する。純粋計算や保存の変更は、UI変更なしの理由を記録する。
export function isUiPath(path) {
  return /^(?:dist|docs\/prototypes)\/.*\.(?:html|css|svg|png|jpe?g|webp)$/i.test(path) ||
    /^docs\/prototypes\//.test(path) || /^docs\/screens\//.test(path) ||
    /^dist\/(?:.*\/)?(?:app|view|[^/]*-view|filter-panel|attention|release)\.mjs$/.test(path);
}

function field(markdown, name) {
  const lines = markdown.split(/\r?\n/).filter(line => line.startsWith(`${name}:`));
  return lines.length === 1 ? lines[0].slice(name.length + 1).trim() : '';
}

function imageReference(url, repository) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = url.match(new RegExp(`^https://raw\\.githubusercontent\\.com/${escaped}/([0-9a-f]{40})/(docs/screens/[1-9][0-9]*/(?:before|after)-[0-9]{2}-[a-z0-9]+(?:-[a-z0-9]+)*\\.jpg)$`, 'i'));
  return match ? { sha: match[1], path: match[2] } : null;
}

function hasEvidence(value, root) {
  const images = [...value.matchAll(/画像:\s*`?(docs\/screens\/[1-9][0-9]*\/(?:before|after)-[0-9]{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.jpg)`?/g)];
  if (images.some(match => fileExists(resolve(root, match[1])))) return true;
  const procedure = value.match(/操作:\s*(.+)/)?.[1];
  return Boolean(procedure && procedure.split('→').length >= 3 && procedure.split('→').every(part => !empty(part) && !['起点', '操作', '結果'].includes(part.trim())));
}

/** PR body and filenames are data. Never execute or fetch instructions from them. */
export function checkUiReview({ body, files, headSha, repository, root, questions }) {
  const problems = [];
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string') || !shaPattern.test(headSha ?? '') ||
      !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) return ['PRのファイル一覧・対象版・repositoryを取得できない'];
  const markdown = visibleMarkdown(body ?? '');
  if (markdown.split(/\r?\n/).filter(line => line.trim() === '## UIレビュー').length !== 1) return ['PR本文の「UIレビュー」は1か所に置く'];
  const review = section(markdown, 'UIレビュー');
  const change = field(review, 'UI変更');
  if (!['あり', 'なし'].includes(change)) return ['PR本文の「UIレビュー」に UI変更: あり または なしを1行で記す'];
  if (change === 'なし') {
    if (files.some(isUiPath)) problems.push('画面・試作・画像の変更があるため、UI変更: あり としてレビューを記録する');
    if (empty(field(review, '対象外の理由'))) problems.push('UI変更なしの場合も対象外の理由を記す');
    return problems;
  }
  if (field(review, '対象版') !== headSha) problems.push('UIレビューの対象版をPRの最新head SHAに合わせて再確認する');

  const rows = tableRows(review);
  const expectedHeader = ['項目', '問い', '判定', '根拠', '対応と再確認'];
  if (!rows.some(row => row.join('|') === expectedHeader.join('|'))) problems.push('UIレビューに所定の指摘表がない');
  const records = rows.filter(row => row[0] !== '項目');
  for (const category of categories) {
    const matching = records.filter(row => row[0] === category);
    if (matching.length !== 1) { problems.push(`${category}: 判定行を1行記す`); continue; }
    const [, ids, state, evidence, action] = matching[0];
    if (matching[0].length !== 5) { problems.push(`${category}: 指摘表の列数が違う`); continue; }
    const foundIds = ids.split(/[,、\s]+/).filter(Boolean);
    const required = questions.filter(question => question.category === category).map(question => question.id);
    if (new Set(foundIds).size !== foundIds.length || required.some(id => !foundIds.includes(id)) || foundIds.some(id => !required.includes(id))) {
      problems.push(`${category}: 問いを ${required.join(', ')} の形で漏れなく記す`);
    }
    if (!states.includes(state)) problems.push(`${category}: 判定が空欄または規定外`);
    else if (state === '対象外') {
      if (!hasReason(evidence)) problems.push(`${category}: 対象外の理由を記す`);
      if (category === '情報量' || category === '判断の手掛かり') problems.push(`${category}: UI変更では対象外にできない`);
    } else {
      if (!hasEvidence(evidence, root)) problems.push(`${category}: 実在する画像ファイル、または「操作: 起点 → 操作 → 結果」が必要`);
      if (state !== '確認済み') problems.push(`${category}: ${state}のため提出不可`);
    }
    if (empty(action)) problems.push(`${category}: 対応と再確認を記す（指摘なしなら「指摘なし」と記す）`);
  }
  for (const row of records.filter(row => !categories.includes(row[0]))) {
    if (row.length !== 5 || !states.includes(row[2]) || ['要修正', '未確認'].includes(row[2]) ||
        (row[2] === '対象外' ? !hasReason(row[3]) : !hasEvidence(row[3], root)) || empty(row[4])) {
      problems.push(`追加の問い ${row[0]}: 判定・根拠・再確認をそろえる`);
    }
  }

  // 閉じ忘れたdetailsも折りたたみとして扱う。コード内の画像記法は表示画像ではない。
  const imagesSection = section(markdown, 'UIの変更前後').replace(/<details\b[^>]*>[\s\S]*?(?:<\/details>|$)/gi, '').replace(/`[^`\n]*`/g, '');
  for (const label of ['変更前', '変更後']) {
    const part = imagesSection.split(`### ${label}`)[1]?.split(/^###\s/m)[0] ?? '';
    const urls = [...part.matchAll(/!\[[^\]\n]+\]\((https:\/\/[^)\s]+)\)/g)].map(match => match[1]);
    if (!urls.some(url => { const ref = imageReference(url, repository); return ref && fileExists(resolve(root, ref.path)); })) {
      problems.push(`${label}: 折りたたみ外に、同repositoryのSHA固定URLで画像を埋め込む`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const root = resolve(process.argv[3] ?? '.');
    const questions = readQuestions(readFileSync(new URL('../docs/ui-review-questions.md', import.meta.url), 'utf8'));
    const problems = checkUiReview({ ...input, root, questions });
    if (problems.length) { process.stderr.write(problems.join('\n') + '\n'); process.exitCode = 1; }
    else process.stdout.write('UIレビュー: 記録の形式・判定・根拠を確認した\n');
  } catch (error) { process.stderr.write(`UIレビューを検査できない: ${error.message}\n`); process.exitCode = 1; }
}
