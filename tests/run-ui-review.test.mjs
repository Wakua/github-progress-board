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
  const calls = { statuses: [], updated: [], commits: [], trees: [], listed: 0, order: [] };
  const checks = structuredClone(overrides.checks ?? []);
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
        listForRef: () => {},
        update: async value => {
          calls.order.push('retire check');
          calls.updated.push(value);
          const check = checks.find(check => check.id === value.check_run_id);
          if (!check) throw new Error('unknown check');
          Object.assign(check, value);
          return { data: check };
        }
      },
      repos: { createCommitStatus: async value => {
        calls.order.push(value.state);
        calls.statuses.push(value);
        return { data: value };
      } },
      git: {
        getCommit: async ({ commit_sha }) => {
          calls.commits.push(commit_sha);
          if (commit_sha !== head) throw Object.assign(new Error('missing commit'), { status: 404 });
          return { data: { tree: { sha: 'root' } } };
        },
        getTree: async ({ tree_sha }) => { calls.trees.push(tree_sha); return { data: { tree: tree[tree_sha], truncated: false } }; }
      }
    },
    paginate: async method => {
      if (method === github.rest.checks.listForRef) return checks;
      calls.listed++;
      return changed;
    }
  };
  const context = { repo: { owner: 'Wakua', repo: 'github-progress-board' }, eventName: 'pull_request_target',
    ref: 'refs/heads/main', sha: base, runId: 42, payload: { pull_request: { head: { sha: head } } }, ...overrides.context };
  return { github, context, calls, tree, pr, checks, run: () => runUiReview({ github, context, pullNumber: 131 }) };
}

test('mainの検査結果をPRのhead SHAに記録する', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.conclusion, 'success');
  assert.deepEqual(f.calls.statuses.map(status => status.sha), [head, head]);
  assert.deepEqual(f.calls.statuses.map(status => status.state), ['pending', 'success']);
  assert.ok(f.calls.statuses.every(status => status.context === 'UI review gate'));
  assert.match(f.calls.statuses[1].target_url, /actions\/runs\/42$/);
  assert.match(result.summary, new RegExp(`検査コード: ${base}`));
  assert.match(result.summary, new RegExp(`対象版: ${head}`));
});

test('headが検査コード・問い・workflowを変更していても、欠落した記録は通らない', async () => {
  const f = fixture({ pr: { body: '確認済み' }, changed: [
    { filename: 'scripts/check-ui-review.mjs', status: 'modified' },
    { filename: 'docs/ui-review-questions.md', status: 'modified' },
    { filename: '.github/workflows/ui-review.yml', status: 'modified' }
  ] });
  const result = await f.run();
  assert.equal(result.conclusion, 'failure');
  assert.match(result.problems.join('\n'), /UIレビュー/);
  assert.deepEqual(f.calls.commits, []);
});

test('Draftは未判定とし、Ready化すると同じ欠落を失敗にする', async () => {
  const draft = fixture({ pr: { draft: true, body: '' } });
  assert.equal((await draft.run()).conclusion, 'neutral');
  assert.equal(draft.calls.statuses.at(-1).state, 'pending');
  assert.equal(draft.calls.listed, 0);
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
  down.github.paginate = async method => {
    if (method === down.github.rest.checks.listForRef) return [];
    throw new Error('API unavailable');
  };
  assert.equal((await down.run()).conclusion, 'failure');
  const checksDown = fixture();
  checksDown.github.paginate = async () => { throw new Error('checks unavailable'); };
  await assert.rejects(checksDown.run, /checks unavailable/);
});

test('検査中の本文・head・base・Draft・完了状態の変化を成功にしない', async () => {
  for (const current of [{ body: '' }, { head: { sha: base } }, { base: { ref: 'main', sha: head } }, { draft: true }, { state: 'closed' }]) {
    const f = fixture({ current });
    const result = await f.run();
    assert.equal(result.conclusion, 'failure');
    assert.match(result.problems.join('\n'), /検査中/);
  }
});

test('古いイベントやmain以外からの起動は合格記録を作らない', async () => {
  for (const context of [{ eventName: 'pull_request' }, { ref: 'refs/heads/codex/change' }, { payload: { pull_request: { head: { sha: base } } } }]) {
    const f = fixture({ context });
    await assert.rejects(f.run);
    assert.deepEqual(f.calls.statuses, []);
  }
});

test('mainからの手動再実行にも同じ検査を適用する', async () => {
  const f = fixture({ context: { eventName: 'workflow_dispatch', payload: {} } });
  assert.equal((await f.run()).conclusion, 'success');
});

test('同じheadの本文編集をpendingを挟んでfailureからsuccessへ記録する', async () => {
  const f = fixture({ pr: { body: '' } });
  assert.equal((await f.run()).conclusion, 'failure');
  f.pr.body = noUi;
  assert.equal((await f.run()).conclusion, 'success');
  assert.deepEqual(f.calls.statuses.map(status => status.state), ['pending', 'failure', 'pending', 'success']);
  assert.ok(f.calls.statuses.every(status => status.sha === head && status.context === 'UI review gate'));
  assert.equal(f.checks.length, 0);
});

test('先にpendingを記録し、旧版の重複を改名して必須判定から外す', async () => {
  const legacy = id => ({ id, name: 'UI review gate', app: { id: 15368 }, conclusion: 'failure',
    output: { summary: `検査コード: ${base}\n対象版: ${head}` } });
  const f = fixture({ checks: [legacy(1), legacy(2)] });
  assert.equal((await f.run()).conclusion, 'success');
  assert.deepEqual(f.calls.order, ['pending', 'retire check', 'retire check', 'success']);
  assert.deepEqual(f.checks.map(check => check.conclusion), ['neutral', 'neutral']);
  assert.ok(f.checks.every(check => check.name === 'UI review gate (legacy)'));
  assert.match(f.checks[0].output.summary, /以前の判定: failure/);
  f.pr.body = '';
  assert.equal((await f.run()).conclusion, 'failure');
  assert.equal(f.calls.statuses.at(-1).state, 'failure');
  assert.equal(f.calls.updated.length, 2);
});

test('別アプリ・別PR・由来不明のチェックを書き換えない', async () => {
  const checks = [
    { id: 1, name: 'UI review gate', app: { id: 1 }, external_id: 'ui-review:131', conclusion: 'failure' },
    { id: 2, name: 'UI review gate', app: { id: 15368 }, external_id: 'ui-review:132', conclusion: 'failure' },
    { id: 3, name: 'UI review gate', app: { id: 15368 }, conclusion: 'failure' }
  ];
  const f = fixture({ checks });
  assert.equal((await f.run()).conclusion, 'success');
  assert.deepEqual(f.checks.slice(0, 3), checks);
  assert.equal(f.calls.updated.length, 0);
});

test('旧版で統合済みの重複も、移行済み正本への参照から再試行できる', async () => {
  const f = fixture({ checks: [
    { id: 1, name: 'UI review gate (legacy)', app: { id: 15368 }, external_id: 'ui-review:131', conclusion: 'neutral' },
    { id: 2, name: 'UI review gate', app: { id: 15368 }, conclusion: 'neutral', output: {
      title: '同じheadの検査へ統合した', summary: '現在の判定: https://github.com/Wakua/github-progress-board/runs/1' } },
    { id: 3, name: 'UI review gate', app: { id: 15368 }, conclusion: 'neutral', output: {
      title: '同じheadの検査へ統合した', summary: '現在の判定: https://github.com/Wakua/github-progress-board/runs/999' } }
  ] });
  assert.equal((await f.run()).conclusion, 'success');
  assert.deepEqual(f.calls.updated.map(check => check.check_run_id), [2]);
  assert.equal(f.checks[2].name, 'UI review gate');
});

test('保留と最終判定の書込み障害を成功にしない', async () => {
  for (const failAt of [1, 2]) {
    const f = fixture();
    let writes = 0;
    f.github.rest.repos.createCommitStatus = async () => {
      if (++writes === failAt) throw new Error('status write unavailable');
    };
    await assert.rejects(f.run, /status write unavailable/);
    assert.equal(writes, failAt);
    if (failAt === 1) assert.equal(f.calls.listed, 0);
  }
});

test('旧チェックの移行失敗ではpendingを残し、成功へ進めない', async () => {
  const f = fixture({ checks: [{ id: 1, name: 'UI review gate', app: { id: 15368 }, external_id: 'ui-review:131' }] });
  f.github.rest.checks.update = async () => { throw new Error('checks write unavailable'); };
  await assert.rejects(f.run, /checks write unavailable/);
  assert.deepEqual(f.calls.statuses.map(status => status.state), ['pending']);
});

test('取得障害でも過去の成功を残さないよう先にpendingを記録する', async () => {
  const f = fixture();
  f.github.paginate = async () => { throw new Error('checks read unavailable'); };
  await assert.rejects(f.run, /checks read unavailable/);
  assert.deepEqual(f.calls.statuses.map(status => status.state), ['pending']);
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
  assert.match(trusted, /statuses: write/);
  assert.doesNotMatch(trusted, /ref:.*head|npm |node --test|pull_request:\s/);
  const candidate = readFileSync(new URL('../.github/workflows/ui-review-tests.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(candidate, /checks: write|statuses: write|pull_request_target:|name: UI review gate/);
});
