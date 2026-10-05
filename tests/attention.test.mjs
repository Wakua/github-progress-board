import test from 'node:test';
import assert from 'node:assert/strict';
import { reliefFor, manualEndedOn, orderAttention, attentionPanelMarkup, FALLBACK_RELIEF } from '../dist/attention.mjs';
import { githubAttentionItems } from '../dist/github-planning-view.mjs';
import { githubMyWork } from '../dist/github-work.mjs';
import { createSample, myWork } from '../dist/engine.mjs';
import { bookingSampleWorkspace } from '../scripts/make-booking-sample.mjs';

const TODAY = '2026-10-05';
const snapshot = bookingSampleWorkspace(new Date('2026-10-05T12:00:00Z')).projects[0].githubSnapshot;

test('条件ごとに、手動計画とGitHubの計画の解除操作を分けて示す', () => {
  assert.match(reliefFor('判断待ち：保存方式を決める', 'manual'), /判断を記録/);
  assert.equal(reliefFor('判断待ち：保存方式を決める', 'github'), FALLBACK_RELIEF);
  assert.match(reliefFor('仕様待ち：保存形式を決める', 'github'), /仕様のIssueの担当/);
  assert.match(reliefFor('期限超過（3日）', 'manual'), /割当のイテレーション/);
  assert.match(reliefFor('期限超過：It0（10/4終了）', 'github'), /ProjectのIteration/);
  assert.match(reliefFor('状態が未確認：Projectに未登録', 'github'), /Projectに登録/);
  // 「続ける」だけでは解除されない。条件を解消する操作を示す。
  for (const kind of ['manual', 'github']) assert.doesNotMatch(reliefFor('作業中なのに前提が未完了：#3', kind), /続ける/);
  assert.match(reliefFor('作業中なのに前提が未完了：#3', 'manual'), /未着手に戻す/);
  assert.match(reliefFor('作業中なのに前提が未完了：#3', 'github'), /Todoに戻す/);
});

test('GitHubの計画の要対応の理由は、すべて固有の解除操作を持つ', () => {
  const reasons = githubMyWork(snapshot, { all: true }, TODAY).sections.find(s => s.id === 'action').tasks.flatMap(t => t.reasons);
  assert.ok(reasons.length >= 4);
  for (const reason of reasons) assert.notEqual(reliefFor(reason, 'github'), FALLBACK_RELIEF, reason);
});

test('手動計画の要対応の理由は、すべて固有の解除操作を持つ', () => {
  const reasons = myWork(createSample(), undefined, '2026-10-05').sections.flatMap(s => s.tasks).flatMap(t => t.reasons)
    .filter(reason => /^(状態が未確認|待ち：|判断待ち：|期限超過|前提が期限超過|作業中なのに)/.test(reason));
  assert.ok(reasons.length >= 1);
  for (const reason of reasons) assert.notEqual(reliefFor(reason, 'manual'), FALLBACK_RELIEF, reason);
});

test('期限切れの古い作業を上に並べ、期限超過に当たらない作業は元の順で後ろに置く', () => {
  const items = [{ id: 'a', endedOn: null }, { id: 'b', endedOn: '2026-10-04' }, { id: 'c', endedOn: '2026-09-27' }, { id: 'd', endedOn: null }, { id: 'e', endedOn: '2026-10-04' }];
  assert.deepEqual(orderAttention(items).map(i => i.id), ['c', 'b', 'e', 'a', 'd']);
  assert.equal(manualEndedOn(['期限超過（3日）'], TODAY), '2026-10-02');
  assert.equal(manualEndedOn(['待ち：なにか'], TODAY), null);
});

test('GitHubの計画では、要対応だけを期限切れの古い順に並べ、前提待ちを含めない', () => {
  const items = githubAttentionItems(snapshot, TODAY);
  const numbers = orderAttention(items).map(i => Number(/data-id="issue:(\d+)"/.exec(i.nameHtml)[1]));
  assert.equal(numbers[0], 6, '期限超過の #6 が先頭');
  assert.deepEqual([...numbers].sort((a, b) => a - b), [5, 6, 9, 12]);
  for (const waiting of [4, 10]) assert.ok(!numbers.includes(waiting), `前提待ちの #${waiting} は含めない`);
});

test('画面の文言は、解除操作を添え、要対応が無いときと文字をエスケープする', () => {
  assert.match(attentionPanelMarkup([], 'github'), /要対応の作業はありません/);
  assert.match(attentionPanelMarkup([], 'github'), /読み取り専用/);
  assert.match(attentionPanelMarkup([], 'manual'), /ツール内で操作/);
  const html = attentionPanelMarkup([{ endedOn: null, reasons: ['待ち：<script>alert(1)</script>'], nameHtml: '<button>x</button>', metaHtml: '' }], 'manual');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /要対応 <span class="my-work-count">1件/);
  assert.match(html, /解除：理由を読み/);
});
