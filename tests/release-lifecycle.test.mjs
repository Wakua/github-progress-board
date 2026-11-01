import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseLifecycle } from '../dist/release-lifecycle.mjs';

const scope = 'https://github.com/example/board';
const page = scope + '/releases/tag/v0.2.0';
const status = (description, extra = {}) => releaseLifecycle({url: scope + '/milestone/2', description, ...extra});
const unknown = {accepted:false, label:'受入未記録', published:null};

test('同じOpenでも明示された受入確認中と受入済みを区別し、公開版を別の事実として読む', () => {
  assert.deepEqual(status('受入: 確認中', {state:'open'}), {...unknown, label:'受入確認中'});
  assert.deepEqual(status('期日までの作業\n\n受入: 済\r\n公開版: ' + page, {state:'open'}),
    {accepted:true, label:'受入済み', published:{tag:'v0.2.0', url:page}});
  assert.deepEqual(status('公開版: ' + page), {...unknown, published:{tag:'v0.2.0', url:page}});
  assert.deepEqual(status('受入: 済'), {accepted:true, label:'受入済み', published:null});
});

test('記録がなければClosed・期日・全作業終了から受入を決めず、古い説明も読める', () => {
  for (const description of [undefined, null, '', 'R3を受入済みとしv0.2.0を公開した。', '未確定の案。受入: 済', '受入: 済の予定']) {
    assert.deepEqual(status(description, {state:'closed', dueOn:'2026-02-01', closedAt:'2026-02-02', tasks:[]}), unknown);
  }
});

test('引用、コード例、コメントは記録から除く', () => {
  const tick = String.fromCharCode(96);
  const description = ['> 引用', '受入: 済', '', '> 受入: 済', '', '- 公開版: ' + page, '',
    tick.repeat(4) + 'md', tick.repeat(3), '受入: 済', tick.repeat(4), '~~~', '公開版: ' + page, '~~~',
    '    受入: 済', '<!-- 例', '受入: 済', '-->', '<pre>', '公開版: ' + page, '</pre>'].join('\n');
  assert.deepEqual(status(description), unknown);
  assert.deepEqual(status(description + '\n\n受入: 確認中'), {...unknown, label:'受入確認中'});
});

test('重複や矛盾した項目は採用せず、もう一方の単独の事実は保持する', () => {
  assert.deepEqual(status('受入: 確認中\n受入: 済\n公開版: ' + page), {...unknown, published:{tag:'v0.2.0', url:page}});
  assert.deepEqual(status('受入: 済\n受入: 済'), unknown);
  assert.deepEqual(status('受入: 済\n公開版: ' + page + '\n公開版: ' + page + '-rc'), {...unknown, accepted:true, label:'受入済み'});
});

test('同一repositoryの正しいタグページだけを公開版として表示する', () => {
  const candidates = ['https://github.com/other/board/releases/tag/v1', 'https://github.com@example.org/example/board/releases/tag/v1',
    'https://github.com.example.org/example/board/releases/tag/v1', page.replace('https:', 'http:'), scope + '/releases/latest',
    page + '?x=1', page + '#notes', scope + '/releases/tag/', scope + '/releases/tag/%ZZ', scope + '/releases/tag/%2e%2e/tag',
    scope + '/releases/tag/v1%0a', scope + '/releases/tag/v%2A1', scope + '/releases/tag/a%5cb', scope + '/releases/tag/v1.lock'];
  for (const url of candidates) assert.equal(status('公開版: ' + url).published, null, url);
  const url = 'https://github.com/EXAMPLE/Board/releases/tag/release%2F1.2';
  assert.deepEqual(status('公開版: ' + url).published, {tag:'release/1.2', url});
});
