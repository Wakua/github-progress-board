import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkUiReview, isUiPath, readQuestions } from '../scripts/check-ui-review.mjs';

const questions = readQuestions(readFileSync(new URL('../docs/ui-review-questions.md', import.meta.url), 'utf8'));
const sha = 'a'.repeat(40);
const before = 'docs/screens/127/before-01-list.jpg';
const after = 'docs/screens/127/after-01-list.jpg';
const image = file => `https://raw.githubusercontent.com/Wakua/github-progress-board/${sha}/${file}`;
const body = `## UIレビュー

UI変更: あり
対象版: ${sha}

| 項目 | 問い | 判定 | 根拠 | 対応と再確認 |
| --- | --- | --- | --- | --- |
| 情報量 | I1, I2 | 確認済み | 画像: ${after}。重複を削り、担当と期限は残した | 指摘なし |
| 判断の手掛かり | J1, J2 | 確認済み | 画像: ${after}。状態名が320pxでも読める | 指摘なし |
| 操作 | O1, O2 | 確認済み | 操作: 一覧でTab → Enterで詳細を開きEscape → 元の行にフォーカスが戻る | 指摘なし |

## UIの変更前後

### 変更前

![前の一覧](${image(before)})

### 変更後

![後の一覧](${image(after)})
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ui-review-gate-'));
  mkdirSync(join(root, 'docs/screens/127'), { recursive: true });
  for (const file of [before, after]) writeFileSync(join(root, file), 'existence fixture; JPEG contents are checked separately');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return (overrides = {}) => checkUiReview({ body, files: ['dist/app.mjs'], headSha: sha, repository: 'Wakua/github-progress-board', root, questions, ...overrides });
}

test('3項目・固定の問い・実在画像と具体的操作・前後画像がそろえば通る', t => {
  assert.deepEqual(fixture(t)(), []);
});

test('UI以外の変更も対象外の理由を残す', t => {
  const check = fixture(t);
  assert.deepEqual(check({ files: ['dist/gantt-calculation.mjs'], body: '## UIレビュー\nUI変更: なし\n対象外の理由: DOMを使わない純粋計算のみ' }), []);
  assert.match(check({ files: ['docs/ui-ux-review.md'], body: '## UIレビュー\nUI変更: なし' }).join('\n'), /対象外の理由/);
});

test('画面や試作、画像を変更したPRは対象外にできない', t => {
  const check = fixture(t);
  for (const file of ['dist/app.mjs', 'dist/new-view.mjs', 'dist/bugs/filter-panel.mjs', 'dist/style.css', 'docs/prototypes/new.html', after]) {
    assert.equal(isUiPath(file), true);
    assert.match(check({ files: [file], body: '## UIレビュー\nUI変更: なし\n対象外の理由: 文書のみ' }).join('\n'), /UI変更: あり/);
  }
});

test('自己申告の確認済みだけでは通らず、3項目の表を要求する', t => {
  const check = fixture(t);
  assert.match(check({ body: `## UIレビュー\nUI変更: あり\n対象版: ${sha}\nすべて確認済み` }).join('\n'), /指摘表がない/);
  for (const category of ['情報量', '判断の手掛かり', '操作']) {
    const missing = body.split('\n').filter(line => !line.startsWith(`| ${category} |`)).join('\n');
    assert.match(check({ body: missing }).join('\n'), new RegExp(`${category}: 判定行`));
  }
});

test('空欄・未知の判定・未修正・未確認を拒否する', t => {
  const check = fixture(t);
  for (const state of ['', 'OK', '未確認', '要修正']) {
    assert.notEqual(check({ body: body.replace('| I1, I2 | 確認済み |', `| I1, I2 | ${state} |`) }).length, 0, state);
  }
});

test('必須の問いの省略・重複・別項目への混入を拒否する', t => {
  const check = fixture(t);
  for (const ids of ['I1', 'I1, I1, I2', 'I1, I2, O1', '全文を読んだ']) {
    assert.match(check({ body: body.replace('I1, I2', ids) }).join('\n'), /問いを I1, I2/);
  }
});

test('画像ファイル名か起点・操作・結果を伴う操作手順を要求する', t => {
  const check = fixture(t);
  for (const evidence of ['確認済み', '画像: screenshot.jpg', '画像: docs/screens/127/after-02-missing.jpg', '操作: 詳細を確認した', '操作: 一覧 → → 成功', '操作: 起点 → 操作 → 結果']) {
    assert.match(check({ body: body.replace(`画像: ${after}。重複を削り、担当と期限は残した`, evidence) }).join('\n'), /情報量: 実在する画像/);
  }
});

test('操作の対象外には理由が必要で、情報量・判断の手掛かりは省略できない', t => {
  const check = fixture(t);
  const valid = body.replace('| 操作 | O1, O2 | 確認済み | 操作: 一覧でTab → Enterで詳細を開きEscape → 元の行にフォーカスが戻る |', '| 操作 | O1, O2 | 対象外 | 理由: 静的な配色見本で操作部を持たない |');
  assert.deepEqual(check({ body: valid }), []);
  assert.match(check({ body: valid.replace('理由: 静的な配色見本で操作部を持たない', '理由: なし') }).join('\n'), /対象外の理由/);
  assert.match(check({ body: body.replace('| I1, I2 | 確認済み |', '| I1, I2 | 対象外 |') }).join('\n'), /対象外にできない/);
});

test('記録の重複と空の再確認欄を拒否する', t => {
  const check = fixture(t);
  assert.match(check({ body: body.replace('| 情報量 | I1, I2', '| 情報量 | I1, I2 | 確認済み | 操作: a → b → c | 指摘なし |\n| 情報量 | I1, I2') }).join('\n'), /判定行を1行/);
  assert.match(check({ body: body.replace('| 指摘なし |', '|  |') }).join('\n'), /対応と再確認/);
});

test('古い対象版や重複した宣言を拒否する', t => {
  const check = fixture(t);
  assert.match(check({ body: body.replace(`対象版: ${sha}`, `対象版: ${'b'.repeat(40)}`) }).join('\n'), /最新head SHA/);
  assert.match(check({ body: body.replace('UI変更: あり', 'UI変更: あり\nUI変更: なし') }).join('\n'), /1行で記す/);
  assert.match(check({ body: body + '\n## UIレビュー\nUI変更: なし\n対象外の理由: 文書のみ' }).join('\n'), /1か所/);
});

test('コメントとコード例の表は提出記録に数えない', t => {
  const check = fixture(t);
  for (const hidden of [`<!--\n${body}\n-->`, `\x60\x60\x60markdown\n${body}\n\x60\x60\x60`, `~~~markdown\n${body}\n~~~`]) {
    assert.notEqual(check({ body: hidden }).length, 0);
  }
});

test('リンクだけ、片方の画像だけ、折りたたみ内だけでは通らない', t => {
  const check = fixture(t);
  for (const replacement of [`[前の一覧](${image(before)})`, '', `<details>![前の一覧](${image(before)})</details>`, `<details>![前の一覧](${image(before)})`, `\x60![前の一覧](${image(before)})\x60`]) {
    assert.match(check({ body: body.replace(`![前の一覧](${image(before)})`, replacement) }).join('\n'), /変更前: 折りたたみ外/);
  }
});

test('画像URLは同repositoryの全長SHAで固定し、ファイルの存在を確認する', t => {
  const check = fixture(t);
  for (const bad of [image(before).replace(sha, 'main'), image(before).replace('Wakua/', 'other/'), image(before).replace('before-01-list', 'before-02-missing'), 'file:///C:/temp/test.jpg']) {
    assert.match(check({ body: body.replace(image(before), bad) }).join('\n'), /変更前: 折りたたみ外/);
  }
});

test('追加の問いにも未確認や根拠のない確認済みを残せない', t => {
  const check = fixture(t);
  assert.match(check({ body: body.replace('## UIの変更前後', '| 数値表示 | 分母 | 確認済み | 確認済み | 指摘なし |\n\n## UIの変更前後') }).join('\n'), /追加の問い/);
});

test('入力の不足を成功にせず、問いの正本が壊れた場合も検出する', t => {
  const check = fixture(t);
  assert.notEqual(check({ files: undefined }).length, 0);
  assert.notEqual(check({ headSha: '' }).length, 0);
  assert.throws(() => readQuestions('| I1 | 情報量 | 問い | 出典 |'), /必須の問い/);
});
