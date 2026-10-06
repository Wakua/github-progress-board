import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkScreenshots, jpegWidth, isComplete, LIMITS } from '../scripts/check-screenshots.mjs';

// SOI + SOF0（幅だけを持つ最小のJPEG）。画像として表示できるかは検査しない。
function jpeg(width, padding = 0) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(padding), Buffer.from([0xff, 0xd9])]);
}
async function workspace(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'screens-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

test('JPEGの幅を読み、JPEGでないデータはnullにする', () => {
  assert.equal(jpegWidth(jpeg(800)), 800);
  assert.equal(jpegWidth(jpeg(1280)), 1280);
  assert.equal(jpegWidth(Buffer.from('not a jpeg')), null);
  assert.equal(jpegWidth(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
});

test('規則に合う画像と、存在しないフォルダーは問題なし', async t => {
  const root = await workspace(t, { '5/before-01-attention.jpg': jpeg(800, 1000), '5/after-02-attention-detail.jpg': jpeg(390) });
  assert.deepEqual(await checkScreenshots(root), []);
  assert.deepEqual(await checkScreenshots(path.join(root, 'missing')), []);
});

test('幅・容量・名前・形式・フォルダー名の違反をそれぞれ検出する', async t => {
  const root = await workspace(t, {
    '5/before-01-wide.jpg': jpeg(LIMITS.width + 1),
    '5/before-02-heavy.jpg': jpeg(800, LIMITS.fileBytes),
    '5/after-01-画面.jpg': jpeg(800),
    '5/after-02-name.png': Buffer.from('x'),
    '5/after-03-broken.jpg': Buffer.from('not a jpeg'),
    'notes/before-01-name.jpg': jpeg(800),
    'stray.jpg': jpeg(800),
  });
  const problems = (await checkScreenshots(root)).join('\n');
  for (const expected of ['before-01-wide.jpg: 幅801px', 'before-02-heavy.jpg', '1枚150KiB', 'after-01-画面.jpg: 名前は', 'after-02-name.png: 名前は', 'after-03-broken.jpg: JPEGとして読めない', 'docs/screens/notes: フォルダー名', 'docs/screens/stray.jpg: 作業ごとのフォルダー以外'])
    assert.ok(problems.includes(expected), expected);
});

test('1作業の合計容量が上限を超えたら検出する', async t => {
  const files = {};
  for (let i = 1; i <= 8; i++) files[`7/after-0${i}-page.jpg`] = jpeg(800, 140 * 1024);
  const root = await workspace(t, files);
  const problems = await checkScreenshots(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docs\/screens\/7: 合計.*1作業1024KiBを超えている/);
});

test('途中で切れたJPEGは、幅が読めても拒否する', async t => {
  const whole = jpeg(800, 100);
  assert.ok(isComplete(whole));
  const cut = whole.subarray(0, whole.length - 20);
  assert.equal(jpegWidth(cut), 800);
  assert.ok(!isComplete(cut));
  const root = await workspace(t, { '5/after-01-cut.jpg': cut });
  assert.match((await checkScreenshots(root)).join('\n'), /after-01-cut\.jpg: 途中で切れている/);
});

test('存在しない場合だけ問題なしにし、フォルダーでないものは検査を失敗させる', async t => {
  const root = await workspace(t, { 'file.txt': 'x' });
  assert.deepEqual(await checkScreenshots(path.join(root, 'missing')), []);
  const problems = await checkScreenshots(path.join(root, 'file.txt'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docs\/screens: 読み取れない/);
});
