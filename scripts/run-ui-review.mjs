import { readFileSync } from 'node:fs';
import { checkUiReview, imageReferences, readQuestions } from './check-ui-review.mjs';

// PRのtreeはAPIで読むだけにし、headのコード・設定・問いは実行も読み込みもしない。
export function createBlobReader(github, repo) {
  const commits = new Map();
  const trees = new Map();
  const cached = (cache, key, read) => {
    if (!cache.has(key)) cache.set(key, read());
    return cache.get(key);
  };
  return async (sha, path) => {
    try {
      const commit = await cached(commits, sha, () => github.rest.git.getCommit({ ...repo, commit_sha: sha }));
      let treeSha = commit.data.tree.sha;
      const parts = path.split('/');
      for (let index = 0; index < parts.length; index++) {
        const { data } = await cached(trees, treeSha, () => github.rest.git.getTree({ ...repo, tree_sha: treeSha }));
        if (data.truncated) throw new Error('画像のtree一覧が不足している');
        const entry = data.tree.find(item => item.path === parts[index]);
        if (!entry) return null;
        if (index === parts.length - 1) return entry.type === 'blob' && /^100(?:644|755)$/.test(entry.mode) ? entry.sha : null;
        if (entry.type !== 'tree') return null;
        treeSha = entry.sha;
      }
      return null;
    } catch (error) {
      if (error.status === 404 || error.status === 422) return null;
      throw error;
    }
  };
}

const sameVersion = (a, b) => a.head.sha === b.head.sha && a.base.sha === b.base.sha &&
  a.body === b.body && a.draft === b.draft && a.state === b.state;

export async function runUiReview({ github, context, pullNumber }) {
  if (!['pull_request_target', 'workflow_dispatch'].includes(context.eventName) || context.ref !== 'refs/heads/main') {
    throw new Error('mainの信頼済みworkflowからだけ実行する');
  }
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new Error('PR番号を確認できない');
  const repo = context.repo;
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: pullNumber });
  if (pr.base.ref !== 'main' || pr.state !== 'open') throw new Error('mainを対象とする未完了PRだけ検査する');
  if (context.payload.pull_request && context.payload.pull_request.head.sha !== pr.head.sha) {
    throw new Error('PRの版が変わったため、最新の実行で確認する');
  }
  const runUrl = `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  const report = (state, description) => github.rest.repos.createCommitStatus({
    ...repo, sha: pr.head.sha, context: 'UI review gate', state, description, target_url: runUrl
  });
  // 過去の成功を無効にしてから、旧チェックの移行と現在の本文の検査を始める。
  await report('pending', '提出記録を検査中');
  const externalId = `ui-review:${pullNumber}`;
  const checks = (await github.paginate(github.rest.checks.listForRef, {
    ...repo, ref: pr.head.sha, filter: 'all', per_page: 100
  })).filter(check => ['UI review gate', 'UI review gate (legacy)'].includes(check.name) && check.app?.id === 15368);
  const owned = checks.filter(check =>
    (check.external_id === externalId || (!check.external_id &&
      check.output?.summary?.includes(`対象版: ${pr.head.sha}`) && check.output.summary.includes('検査コード: '))));
  const ownedUrls = new Set(owned.map(check => `現在の判定: https://github.com/${repo.owner}/${repo.repo}/runs/${check.id}`));
  const existing = checks.filter(check => check.name === 'UI review gate' && (owned.includes(check) ||
    (!check.external_id && check.output?.title === '同じheadの検査へ統合した' && ownedUrls.has(check.output.summary))));
  // 同名のcheck runとcommit statusは両方が必須になるため、所有する旧チェックだけを退役する。
  for (const check of existing) {
    await github.rest.checks.update({ ...repo, check_run_id: check.id,
      name: 'UI review gate (legacy)', status: 'completed', conclusion: 'neutral',
      output: { title: 'commit statusへ移行した',
        summary: `現在の検査: ${runUrl}\n以前の判定: ${check.conclusion}\n\n${(check.output?.summary ?? '').slice(0, 60000)}` } });
  }
  let conclusion = 'failure';
  let problems = [];
  try {
    if (pr.draft) conclusion = 'neutral';
    else {
      const changed = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: pullNumber, per_page: 100 });
      if (changed.length !== pr.changed_files) throw new Error('変更ファイル一覧が不足している');
      const files = [...new Set(changed.flatMap(file => [file.filename, file.previous_filename].filter(Boolean)))];
      const changedImages = changed.filter(file => ['added', 'modified'].includes(file.status) && /^docs\/screens\//.test(file.filename)).map(file => file.filename);
      const repository = `${repo.owner}/${repo.repo}`;
      const refs = imageReferences(pr.body, repository);
      if (refs.length > 50) throw new Error('画像の参照が50件を超えている');
      const readBlob = createBlobReader(github, repo);
      const imageBlobs = {};
      const headImages = {};
      for (const ref of refs) {
        imageBlobs[`${ref.sha}/${ref.path}`] = await readBlob(ref.sha, ref.path);
        headImages[ref.path] = await readBlob(pr.head.sha, ref.path);
      }
      const questions = readQuestions(readFileSync(new URL('../docs/ui-review-questions.md', import.meta.url), 'utf8'));
      problems = checkUiReview({ body: pr.body, files, headSha: pr.head.sha, repository, changedImages, imageBlobs, headImages, questions });
      if (!problems.length) conclusion = 'success';
    }
    const { data: current } = await github.rest.pulls.get({ ...repo, pull_number: pullNumber });
    if (!sameVersion(pr, current)) throw new Error('検査中に本文・版・Draft状態が変わったため、最新の実行で確認する');
  } catch (error) {
    conclusion = 'failure';
    problems = [error.message];
  }
  const summary = conclusion === 'neutral' ? 'Draftは作業中のため未判定。Ready化で必須検査を行う。' :
    problems.length ? problems.join('\n') : '提出記録の形式・問い・画像の対応を確認した。画面の使いやすさと操作の実施事実は人が確認する。';
  await report(conclusion === 'neutral' ? 'pending' : conclusion,
    conclusion === 'failure' ? '提出記録に不足がある。実行記録を確認する' :
      conclusion === 'neutral' ? 'Draftは作業中・未判定。Ready化で検査する' : '提出記録を確認した');
  // 合否は必須チェックへ集約する。結果の書込みに失敗した場合だけ呼出元へ例外を返す。
  return { conclusion, problems,
    summary: `${summary}\n\n検査コード: ${context.sha}\n対象版: ${pr.head.sha}\n実行記録: ${runUrl}` };
}
