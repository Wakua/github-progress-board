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

export async function runUiReview({ github, context, core, pullNumber }) {
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
  const { data: check } = await github.rest.checks.create({
    ...repo, name: 'UI review gate', head_sha: pr.head.sha, status: 'in_progress',
    details_url: `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`,
    output: { title: '提出記録を検査中', summary: `検査コード: ${context.sha}\n対象版: ${pr.head.sha}` }
  });
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
  await github.rest.checks.update({
    ...repo, check_run_id: check.id, status: 'completed', conclusion,
    output: { title: conclusion === 'failure' ? '提出記録に不足がある' : conclusion === 'neutral' ? '作業中・未判定' : '提出記録を確認した',
      summary: `${summary}\n\n検査コード: ${context.sha}\n対象版: ${pr.head.sha}` }
  });
  if (conclusion === 'failure') core.setFailed(summary);
  return { conclusion, problems };
}
