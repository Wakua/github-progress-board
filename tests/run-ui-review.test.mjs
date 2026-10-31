import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runUiReview, createBlobReader } from '../scripts/run-ui-review.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const blob = 'c'.repeat(40);
const imagePath = 'docs/screens/127/after-01-list.jpg';
const noUi = '## UIレビュー\nUI変更: なし\n対象外の理由: 開発手順だけを変更する';
const uiBody = `## UIレビュー
UI変更: あり
対象版: ${head}
| 項目 | 問い | 判定 | 根拠 | 対応と再確認 |
| --- | --- | --- | --- | --- |
| 情報量 | I1, I2 | 確認済み | 画像: ${imagePath}。担当と期限を残した | 指摘なし |
| 判断の手掛かり | J1, J2 | 確認済み | 画像: ${imagePath}。状態を文字でも示した | 指摘なし |
| 操作 | O1, O2 | 対象外 | 理由: 操作のない配色見本 | 指摘なし |
## UIの変更前後
### 変更前
変更前なし: 理由: 新設の見本で対応する既存画面がない
### 変更後
![状態の見本](https://raw.githubusercontent.com/Wakua/github-progress-board/${head}/${imagePath})`;

function fixture(overrides = {}) {
  const changed = overrides.changed ?? [{ filename: 'docs/development.md', status: 'modified' }];
  const pr = { body: noUi, head: { sha: head }, base: { ref: 'main', sha: base }, draft: false, state: 'open', changed_files: changed.length, ...overrides.pr };
  const calls = { created: [], updated: [], failures: [], commits: [], trees: [], listed: 0 };
  let reads = 0;
  const tree = {
    root: [{ path: 'docs', type: 'tree', sha: 'docs' }],
    docs: [{ path: 'screens', type: 'tree', sha: 'screens' }],
    screens: [{ path: '127', type: 'tree', sha: '127' }],
    127: [{ path: 'after-01-list.jpg', type: 'blob', mode: '100644', sha: blob }]
  };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: ++reads > 1 && overrides.current ? { ...pr, ...overrides.current } : pr }), listFiles: () => {} },
      checks: {
        create: async value => { calls.created.push(value); return { data: { id: 1 } }; },
        update: async value => { calls.updated.push(value); }
      },
      git: {
        getCommit: async ({ commit_sha }) => {
          calls.commits.push(commit_sha);
          if (commit_sha !== head) throw Object.assign(new Error('missing commit'), { status: 404 });
          return { data: { tree: { sha: 'root' } } };
        },
        getTree: async ({ tree_sha }) => { calls.trees.push(tree_sha); return { data: { tree: tree[tree_sha], truncated: false } }; }
      }
    },
    paginate: async () => { calls.listed++; return changed; }
  };
  const context = { repo: { owner: 'Wakua', repo: 'github-progress-board' }, eventName: 'pull_request_target',
    ref: 'refs/heads/main', sha: base, runId: 42, payload: { pull_request: { head: { sha: head } } }, ...overrides.context };
  const core = { setFailed: value => calls.failures.push(value) };
  return { github, context, calls, tree, run: () => runUiReview({ github, context, core, pullNumber: 131 }) };
}

test('mainの検査結果をPRのhead SHAに記録する', async () => {
  const f = fixture();
  assert.equal((await f.run()).conclusion, 'success');
  assert.equal(f.calls.created[0].head_sha, head);
  assert.equal(f.calls.created[0].status, 'in_progress');
  assert.match(f.calls.updated[0].output.summary, new RegExp(`検査コード: ${base}`));
});

test('headが検査コード・問い・workflowを変更していても、欠落した記録は通らない', async () => {
  const f = fixture({ pr: { body: '確認済み' }, changed: [
    { filename: 'scripts/check-ui-review.mjs', status: 'modified' },
    { filename: 'docs/ui-review-questions.md', status: 'modified' },
    { filename: '.github/workflows/ui-review.yml', status: 'modified' }
  ] });
  assert.equal((await f.run()).conclusion, 'failure');
  assert.match(f.calls.failures[0], /UIレビュー/);
  assert.deepEqual(f.calls.commits, []);
});

test('Draftは未判定とし、Ready化すると同じ欠落を失敗にする', async () => {
  const draft = fixture({ pr: { draft: true, body: '' } });
  assert.equal((await draft.run()).conclusion, 'neutral');
  assert.equal(draft.calls.listed, 0);
  assert.deepEqual(draft.calls.failures, []);
  const ready = fixture({ pr: { draft: false, body: '' } });
  assert.equal((await ready.run()).conclusion, 'failure');
});

test('今回追加した画像をURLとheadのtreeで照合する', async () => {
  const f = fixture({ pr: { body: uiBody }, changed: [{ filename: imagePath, status: 'added' }] });
  assert.equal((await f.run()).conclusion, 'success');
  assert.deepEqual(f.calls.commits, [head]);
  assert.deepEqual(f.calls.trees, ['root', 'docs', 'screens', '127']);
});

test('古い画像・コピー・名前だけ変えた画像は今回の証拠として認めない', async () => {
  for (const status of ['unchanged', 'copied', 'renamed', 'removed']) {
    const f = fixture({ pr: { body: uiBody }, changed: [{ filename: imagePath, previous_filename: 'docs/screens/5/after-01-list.jpg', status }] });
    assert.equal((await f.run()).conclusion, 'failure', status);
  }
});

test('画像URLの架空SHAとsymlinkを拒否する', async () => {
  const missing = fixture({ pr: { body: uiBody.replace(`/${head}/`, `/${'f'.repeat(40)}/`) }, changed: [{ filename: imagePath, status: 'added' }] });
  assert.equal((await missing.run()).conclusion, 'failure');
  const link = fixture({ pr: { body: uiBody }, changed: [{ filename: imagePath, status: 'added' }] });
  link.tree[127][0].mode = '120000';
  assert.equal((await link.run()).conclusion, 'failure');
});

test('画像URLとheadのblobが異なる場合をAPI経由でも拒否する', async () => {
  const f = fixture({ pr: { body: uiBody.replace(`/${head}/`, `/${base}/`) }, changed: [{ filename: imagePath, status: 'added' }] });
  f.github.rest.git.getCommit = async ({ commit_sha }) => ({ data: { tree: { sha: commit_sha } } });
  f.github.rest.git.getTree = async ({ tree_sha }) => ({ data: { tree: tree_sha === head || tree_sha === base ?
    [{ path: 'docs', type: 'tree', sha: `${tree_sha}/docs` }] : tree_sha.endsWith('/docs') ?
      [{ path: 'screens', type: 'tree', sha: `${tree_sha}/screens` }] : tree_sha.endsWith('/screens') ?
        [{ path: '127', type: 'tree', sha: `${tree_sha}/127` }] :
        [{ path: 'after-01-list.jpg', type: 'blob', mode: '100644', sha: tree_sha.startsWith(head) ? blob : 'd'.repeat(40) }] } });
  assert.equal((await f.run()).conclusion, 'failure');
});

test('変更ファイルの取得漏れとAPI障害を成功にしない', async () => {
  const short = fixture({ pr: { changed_files: 2 } });
  assert.equal((await short.run()).conclusion, 'failure');
  const down = fixture();
  down.github.paginate = async () => { throw new Error('API unavailable'); };
  assert.equal((await down.run()).conclusion, 'failure');
});

test('検査中の本文・head・base・Draft・完了状態の変化を成功にしない', async () => {
  for (const current of [{ body: '' }, { head: { sha: base } }, { base: { ref: 'main', sha: head } }, { draft: true }, { state: 'closed' }]) {
    const f = fixture({ current });
    assert.equal((await f.run()).conclusion, 'failure');
    assert.match(f.calls.failures[0], /検査中/);
  }
});

test('古いイベントやmain以外からの起動は合格記録を作らない', async () => {
  for (const context of [{ eventName: 'pull_request' }, { ref: 'refs/heads/codex/change' }, { payload: { pull_request: { head: { sha: base } } } }]) {
    const f = fixture({ context });
    await assert.rejects(f.run);
    assert.deepEqual(f.calls.created, []);
  }
});

test('mainからの手動再実行にも同じ検査を適用する', async () => {
  const f = fixture({ context: { eventName: 'workflow_dispatch', payload: {} } });
  assert.equal((await f.run()).conclusion, 'success');
});

test('画像treeの取得漏れと権限不足は呼出元に返す', async () => {
  const f = fixture();
  f.github.rest.git.getTree = async () => ({ data: { truncated: true, tree: [] } });
  await assert.rejects(createBlobReader(f.github, f.context.repo)(head, imagePath), /tree一覧/);
  f.github.rest.git.getCommit = async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); };
  await assert.rejects(createBlobReader(f.github, f.context.repo)(head, imagePath), /forbidden/);
});

test('信頼済みworkflowと候補コードのテストで実行権限を分ける', () => {
  const trusted = readFileSync(new URL('../.github/workflows/ui-review.yml', import.meta.url), 'utf8');
  assert.match(trusted, /pull_request_target:/);
  assert.match(trusted, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(trusted, /ref:.*head|npm |node --test|pull_request:\s/);
  const candidate = readFileSync(new URL('../.github/workflows/ui-review-tests.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(candidate, /checks: write|pull_request_target:|name: UI review gate/);
});
