import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { canExportPlan, exportPlan } from '../dist/testing/plan-export.mjs';

const plan = {
  id: 'TP-1', name: '予約 / 確認', state: 'Draft', version: '1.4', build: 'demo-04',
  conditions: [{ os: 'Windows', version: '11', model: 'Model A' }, { os: 'iOS', version: '18', model: 'iPhone' }],
  caseIds: ['TC-2', 'TC-1'],
  results: Array.from({ length: 4 }, () => ({ status: 'Not Run', recordedAt: null })),
};
const cases = [
  { id: 'TC-1', title: '検索', steps: '検索する', expected: '表示する', preconditions: ' ', cleanup: '' },
  { id: 'TC-2', title: '予約を保存', preconditions: '予約画面', steps: '1. 入力する\n2. 保存する', expected: '=1+1\n確認 & <完了>', cleanup: '後片付け' },
];

test('only complete sets of unrecorded units in open plans can be exported', () => {
  assert.equal(canExportPlan(plan), true);
  assert.equal(canExportPlan({ ...plan, state: 'In Progress' }), true);
  for (const variant of [
    { ...plan, results: [] }, { ...plan, state: 'Completed' }, { ...plan, state: 'Archived' },
    { ...plan, results: [{ status: 'Not Run', recordedAt: '2026-11-29' }, ...plan.results.slice(1)] },
    { ...plan, results: [{ status: 'Failed', recordedAt: null }, ...plan.results.slice(1)] },
  ]) {
    assert.equal(canExportPlan(variant), false);
    assert.throws(() => exportPlan(variant, cases, 'md'), /結果を記録していない/);
  }
  assert.throws(() => exportPlan(plan, cases.slice(0, 1), 'xlsx'), /TC-2 が見つかりません/);
});

test('Markdown keeps the saved condition and case order, excludes blank optional fields and quotes markup', async () => {
  const output = exportPlan(plan, cases, 'md');
  assert.equal(output.name, 'TP-1-予約 - 確認.md');
  const text = await output.blob.text();
  assert.match(text, /Windows 11 ／ Model A<br>iOS 18 ／ iPhone/);
  assert.match(text, /1\. 入力する {2}\n2\. 保存する/);
  assert.match(text, /予約を保存[^]*事前条件[^]*手順[^]*期待結果[^]*事後処理[^]*検索/);
  assert.match(text, /確認 &amp; &lt;完了&gt;/);
  assert.equal((text.match(/\*\*事前条件\*\*/g) ?? []).length, 1);
  assert.doesNotMatch(await exportPlan({ ...plan, build: '' }, cases, 'md').blob.text(), /対象ビルド/);
});

test('Excel stores multiline Japanese text in the same order and does not turn case text into formulas', async () => {
  const output = exportPlan(plan, cases, 'xlsx');
  assert.equal(output.name, 'TP-1-予約 - 確認.xlsx');
  const zip = Buffer.from(await output.blob.arrayBuffer());
  const parts = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const nameSize = zip.readUInt16LE(offset + 26);
    const dataSize = zip.readUInt32LE(offset + 18);
    const name = zip.toString('utf8', offset + 30, offset + 30 + nameSize);
    const start = offset + 30 + nameSize;
    const bytes = zip.subarray(start, start + dataSize);
    assert.equal(crc32(bytes), zip.readUInt32LE(offset + 14));
    parts.set(name, bytes.toString('utf8'));
    offset = start + dataSize;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.equal(parts.size, 6);
  const sheet = parts.get('xl/worksheets/sheet1.xml');
  assert.match(sheet, /Windows 11 ／ Model A\niOS 18 ／ iPhone/);
  assert.match(sheet, /予約を保存[^]*事前条件[^]*手順[^]*期待結果[^]*事後処理[^]*検索/);
  assert.match(sheet, /t="inlineStr"><is><t xml:space="preserve">=1\+1\n確認 &amp; &lt;完了&gt;/);
  assert.doesNotMatch(sheet, /<f[ >]/);
});
