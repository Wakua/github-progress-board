import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// 空白と改行を取り除いて照合する。CSSを整形しても、規則があれば、成功する。
const css = readFileSync(new URL('../dist/bugs/style.css', import.meta.url), 'utf8').replace(/\s+/g, '');
test('一覧と詳細の切替を共通にし、詳細全体を固定して別のスクロール領域にしない', () => {
  assert.match(css, /\.layout:has\(\.mobile-open\)>\.list\{display:none\}/);
  assert.match(css, /\.detail:not\(\.mobile-open\)\{display:none\}/);
  assert.doesNotMatch(css, /\.detail\{[^}]*position:sticky/);
  assert.doesNotMatch(css, /\.detail\{[^}]*max-height:/);
});
