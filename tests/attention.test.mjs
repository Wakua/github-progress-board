import test from 'node:test';
import assert from 'node:assert/strict';
import { reliefFor, manualEndedOn, orderAttention, attentionPanelMarkup, attentionCount, FALLBACK_RELIEF } from '../dist/attention.mjs';
import { githubAttentionItems, githubMineItems } from '../dist/github-planning-view.mjs';
import { approvalQueue } from '../dist/github-snapshot.mjs';
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

test('あなたの担当は、未完了の作業を状態つきで取り出し、要対応と前提待ちを重ねて出さない', () => {
  const mine = githubMineItems(snapshot, 'Wakua', TODAY);
  const names = mine.map(item => Number(/data-id="issue:(\d+)"/.exec(item.nameHtml)[1]));
  assert.deepEqual(names.sort((a, b) => a - b), [8, 16]);
  assert.ok(!names.includes(9), '要対応の #9 は、要対応のまとまりに出す');
  assert.ok(mine.every(item => /着手可能|作業中|確認待ち/.test(item.label)));
  assert.deepEqual(githubMineItems(snapshot, 'だれもいない', TODAY), []);
});

test('承認待ちのPRは、実際のsnapshotのReadyのPRだけを並べる', () => {
  const queue = approvalQueue(snapshot);
  assert.deepEqual(queue.items.map(pr => pr.number), [31]);
});

const model = (extra = {}) => ({ approvalLimit: 2, approvals: [{ number: 31, title: '予約の自動テストを足す（PR）', url: 'https://github.com/example/booking-app/pull/31' }],
  owners: ['Claude', 'Wakua'], me: 'Wakua', mine: [{ label: '着手可能（先の期間・未割当・期間不明）', nameHtml: '<button>#8</button>', metaHtml: '' }],
  items: [{ endedOn: null, reasons: ['待ち：確認する'], nameHtml: '<button>#5</button>', metaHtml: '' }], ...extra });

test('画面は、承認待ちのPR・あなたの担当・要対応の順に並べ、件数を合計する', () => {
  const html = attentionPanelMarkup(model(), 'github');
  const order = ['approvals', 'mine', 'attention'].map(id => html.indexOf(`data-attention-section="${id}"`));
  assert.ok(order.every(n => n >= 0) && order[0] < order[1] && order[1] < order[2], order.join());
  assert.equal(attentionCount(model()), 3);
  assert.ok(!html.includes('承認：'), '承認待ちのPRの行に、見出しと同じ意味の行を添えない');
  assert.match(html, /承認待ちのPR <span class="my-work-count">1件 \/ 上限2件/);
  assert.match(html, /data-attention-me="Wakua" aria-pressed="true"/);
  assert.match(html, /data-attention-me="Claude" aria-pressed="false"/);
  assert.ok(!html.includes('着手可能'), '既定の状態（着手可能）は示さない');
  assert.match(html, /→ /);
});

test('手が要る作業が無いときと、文字のエスケープを扱う', () => {
  assert.ok(!attentionPanelMarkup(model({ me: null, mine: [] }), 'github').includes('data-attention-section="mine"'));
  const empty = attentionPanelMarkup({ approvals: [], owners: [], me: null, mine: [], items: [] }, 'manual');
  assert.match(empty, /手が要る作業はありません/);
  assert.match(attentionPanelMarkup(model({ mine: [] }), 'github'), /Wakuaの未完了の作業はありません/);
  const html = attentionPanelMarkup(model({ items: [{ endedOn: null, reasons: ['待ち：<script>alert(1)</script>'], nameHtml: '', metaHtml: '' }] }), 'manual');
  assert.ok(!html.includes('<script>'));
});

test('作業中などの既定でない状態は示し、期限超過の行には同じ意味の期限を重ねない', () => {
  assert.match(attentionPanelMarkup(model({ mine: [{ label: '作業中', nameHtml: '<button>#3</button>', metaHtml: '' }] }), 'github'), /attention-state">作業中</);
  const [overdue] = githubAttentionItems(snapshot, TODAY).filter(item => item.endedOn);
  assert.ok(overdue && !overdue.metaHtml.includes('task-deadline'), '期限超過の行に、期限を重ねて出さない');
  const [other] = githubAttentionItems(snapshot, TODAY).filter(item => !item.endedOn && /It1/.test(item.metaHtml));
  assert.ok(other, '期限超過でない行には期限を出す');
});
