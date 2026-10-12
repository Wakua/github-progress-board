import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const css = readFileSync(new URL('../dist/bugs/style.css', import.meta.url), 'utf8');
// 指定した幅の条件のブロックの中身を、すべて取り出す。
function blocks(query) {
  const found = [];
  for (let at = css.indexOf(query); at >= 0; at = css.indexOf(query, at + 1)) {
    let depth = 0, start = css.indexOf('{', at);
    for (let index = start; index < css.length; index++) {
      if (css[index] === '{') depth++;
      if (css[index] === '}' && --depth === 0) {found.push(css.slice(start + 1, index)); break;}
    }
  }
  return found.join('');
}

test('幅761px以上では、詳細が画面の上に残り、画面より長いときは詳細の中だけをスクロールする', () => {
  const wide = blocks('@media(min-width:761px)');
  assert.match(wide, /\.detail\{[^}]*position:sticky/);
  assert.match(wide, /\.detail\{[^}]*max-height:calc\(100vh/);
  assert.match(wide, /\.detail\{[^}]*overflow:auto/);
});
test('幅760px以下では、詳細を追従させず、一覧と詳細を切り替える規則のままにする', () => {
  const narrow = blocks('@media(max-width:760px)');
  assert.doesNotMatch(narrow, /position:sticky/);
  assert.match(narrow, /\.detail:not\(\.mobile-open\)\{display:none\}/);
});
