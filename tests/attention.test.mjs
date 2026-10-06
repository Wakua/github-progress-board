import test from 'node:test';
import assert from 'node:assert/strict';
import { labelFor, manualEndedOn, orderAttention, attentionPanelMarkup, attentionCount, FALLBACK_LABEL } from '../dist/attention.mjs';
import { githubAttentionItems, githubMineItems } from '../dist/github-planning-view.mjs';
import { approvalQueue } from '../dist/github-snapshot.mjs';
import { githubMyWork } from '../dist/github-work.mjs';
import { createSample, myWork } from '../dist/engine.mjs';
import { bookingSampleWorkspace } from '../scripts/make-booking-sample.mjs';

const TODAY = '2026-10-05';
const snapshot = bookingSampleWorkspace(new Date('2026-10-05T12:00:00Z')).projects[0].githubSnapshot;

test('理由は、専門用語を使わない短い言葉にする', () => {
  const expected = { '判断待ち：保存方式を決める': '判断待ち', '待ち：回答待ち': '待ち', '状態が未確認': '状態が不明', '状態が未確認：Status未設定': '状態が不明',
    '状態が未確認：Projectに未登録': 'Project未登録', '仕様待ち：保存形式を決める': '仕様待ち', '期限超過（3日）': '期限切れ', '期限超過：It0（10/4終了）': '期限切れ',
    '前提が期限超過：a': '前提が期限切れ', '前提の期限超過：#3（It0）': '前提が期限切れ', '作業中なのに担当者がいない': '担当なし', '作業中なのに前提が未完了：#3': '前提が未完了' };
  for (const [reason, label] of Object.entries(expected)) assert.equal(labelFor(reason), label, reason);
  assert.equal(labelFor('知らない理由'), FALLBACK_LABEL);
});

test('GitHubの計画と手動計画の要対応の理由は、すべて固有の短い言葉を持つ', () => {
  const github = githubMyWork(snapshot, { all: true }, TODAY).sections.find(s => s.id === 'action').tasks.flatMap(t => t.reasons);
  const manual = myWork(createSample(), undefined, TODAY).sections.find(s => s.id === 'action')?.tasks.flatMap(t => t.reasons) ?? [];
  assert.ok(github.length >= 4);
  for (const reason of [...github, ...manual]) assert.notEqual(labelFor(reason), FALLBACK_LABEL, reason);
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
  const html = attentionPanelMarkup(model());
  assert.equal((html.match(/<li class="my-work-row/g) || []).length, 3);
  const order = ['#31', '#5', '#8'].map(label => html.indexOf(label));
  assert.ok(order.every(n => n >= 0) && order[0] < order[1] && order[1] < order[2], order.join());
  assert.match(html, /承認待ち<\/span>/);
  assert.match(html, /待ち<\/span>/);
  assert.ok(html.includes(">担当</span>"));
  assert.equal((html.match(/attention-label/g) || []).length, 3);
  assert.ok(!html.includes('→'), '操作の文は出さない');
  for (const heading of ['<h3', '<h2', 'attention-reason', '承認待ちのPR']) assert.ok(!html.includes(heading), `見出しや理由の行は出さない：${heading}`);
  assert.equal(attentionCount(model()), 3);
  assert.match(html, /data-attention-me="Wakua" aria-pressed="true"/);
  assert.match(html, /data-attention-me="Claude" aria-pressed="false"/);
});

test('同じ理由は一度だけ示し、手が要る作業が無いときと文字のエスケープを扱う', () => {
  const twice = attentionPanelMarkup(model({ approvals: [], mine: [], items: [{ endedOn: null, reasons: ['期限超過（3日）', '前提が期限超過：a', '前提が期限超過：b'], nameHtml: '<button>#6</button>' }] }));
  assert.equal((twice.match(/前提が期限切れ/g) || []).length, 1);
  assert.match(twice, /期限切れ・前提が期限切れ/);
  assert.match(attentionPanelMarkup({ approvals: [], owners: [], me: null, mine: [], items: [] }), /手が要る作業はありません/);
  assert.ok(!attentionPanelMarkup(model({ items: [{ endedOn: null, reasons: ['待ち：<script>alert(1)</script>'], nameHtml: '' }] })).includes('<script>'));
});
