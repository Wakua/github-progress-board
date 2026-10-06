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

test('条件ごとに、手動計画とGitHubの計画の解除操作を分けて短く示す', () => {
  assert.equal(reliefFor('判断待ち：保存方式を決める', 'manual'), '判断を記録する');
  assert.equal(reliefFor('判断待ち：保存方式を決める', 'github'), FALLBACK_RELIEF);
  assert.equal(reliefFor('仕様待ち：保存形式を決める', 'github'), '仕様を決める');
  assert.equal(reliefFor('期限超過（3日）', 'manual'), '割当を変えるか完了にする');
  assert.equal(reliefFor('期限超過：It0（10/4終了）', 'github'), 'Iterationを変えるか閉じる');
  assert.equal(reliefFor('状態が未確認：Projectに未登録', 'github'), 'Projectに登録する');
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

test('あなたの担当は、未完了の作業を取り出し、要対応と前提待ちを重ねて出さない', () => {
  const names = githubMineItems(snapshot, 'Wakua', TODAY).map(item => Number(/data-id="issue:(\d+)"/.exec(item.nameHtml)[1]));
  assert.deepEqual(names.sort((x, y) => x - y), [8, 16]);
  assert.ok(!names.includes(9), '要対応の #9 は、要対応に出す');
  assert.deepEqual(githubMineItems(snapshot, 'だれもいない', TODAY), []);
});

test('承認待ちのPRは、実際のsnapshotのReadyのPRだけを並べる', () => {
  assert.deepEqual(approvalQueue(snapshot).items.map(pr => pr.number), [31]);
});

const model = (extra = {}) => ({ approvals: [{ number: 31, title: '予約の自動テストを足す（PR）', url: 'https://github.com/example/booking-app/pull/31' }],
  owners: ['Claude', 'Wakua'], me: 'Wakua', mine: [{ nameHtml: '<button>#8</button>' }],
  items: [{ endedOn: null, reasons: ['待ち：確認する'], nameHtml: '<button>#5</button>' }], ...extra });

test('画面は一つの一覧で、承認待ちのPR・要対応・あなたの担当の順に、何をするかだけを示す', () => {
  const html = attentionPanelMarkup(model(), 'manual');
  assert.equal((html.match(/<li class="my-work-row/g) || []).length, 3);
  const order = ['#31', '#5', '#8'].map(label => html.indexOf(label));
  assert.ok(order.every(n => n >= 0) && order[0] < order[1] && order[1] < order[2], order.join());
  assert.match(html, /→ 承認/);
  assert.match(html, /→ 待ちを解除する/);
  assert.equal((html.match(/→ /g) || []).length, 2, '「あなたの担当」の行には、何もつけない');
  for (const heading of ['<h3', '<h2', 'attention-reason', '承認待ちのPR']) assert.ok(!html.includes(heading), `見出しや理由の行は出さない：${heading}`);
  assert.equal(attentionCount(model()), 3);
  assert.match(html, /data-attention-me="Wakua" aria-pressed="true"/);
  assert.match(html, /data-attention-me="Claude" aria-pressed="false"/);
});

test('同じ操作は一度だけ示し、手が要る作業が無いときと文字のエスケープを扱う', () => {
  const twice = attentionPanelMarkup(model({ approvals: [], mine: [], items: [{ endedOn: null, reasons: ['期限超過（3日）', '前提が期限超過：a', '前提が期限超過：b'], nameHtml: '<button>#6</button>' }] }), 'manual');
  assert.equal((twice.match(/前提を進める/g) || []).length, 1);
  assert.match(twice, /割当を変えるか完了にする・前提を進める/);
  assert.match(attentionPanelMarkup({ approvals: [], owners: [], me: null, mine: [], items: [] }, 'manual'), /手が要る作業はありません/);
  assert.ok(!attentionPanelMarkup(model({ items: [{ endedOn: null, reasons: ['待ち：<script>alert(1)</script>'], nameHtml: '' }] }), 'manual').includes('<script>'));
});
