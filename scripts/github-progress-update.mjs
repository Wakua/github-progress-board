import { createHash } from 'node:crypto';

export const PROGRESS_FIELD = '作業進捗率';
const fail = message => { throw new Error(message); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const number = value => typeof value === 'number' && Number.isFinite(value);

export function numberField(fields, name, required = true) {
  const matches = fields.filter(field => field.name === name);
  if (!matches.length && !required) return null;
  if (matches.length !== 1 || matches[0].dataType !== 'NUMBER' || !matches[0].id) {
    fail(`${name}: 数値フィールドを一意に識別できません。`);
  }
  return matches[0];
}

export async function setupProgress(client, { apply = false } = {}) {
  const project = await client.project();
  const field = numberField(project.fields, PROGRESS_FIELD, false);
  if (field) return { mode: 'unchanged', project: project.url, field };
  if (!apply) return { mode: 'preview', project: project.url, create: { name: PROGRESS_FIELD, dataType: 'NUMBER' } };
  await client.createField(project.id, PROGRESS_FIELD);
  const verified = await client.project();
  if (verified.id !== project.id) fail('Projectが変更されました。');
  return { mode: 'created', project: project.url, field: numberField(verified.fields, PROGRESS_FIELD) };
}

export function validateRequest(request) {
  if (!Number.isSafeInteger(request.issue) || request.issue < 1) fail('Issue番号が必要です。');
  if (typeof request.actor !== 'string' || !request.actor.trim()) fail('担当を指定してください。');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(request.operation ?? '')) fail('一意な操作名が必要です。');
  if (!Number.isInteger(request.progress) || request.progress < 0 || request.progress > 100) fail('進捗率は0〜100の整数です。');
  // Invalid historical values can be repaired, but their exact current values must be supplied.
  if (request.expectedProgress !== null && !number(request.expectedProgress)) fail('変更前の進捗率を指定してください。');
  if (request.expectedEstimate !== null && !number(request.expectedEstimate)) fail('変更前のEstimateを指定してください。');
  if (request.estimate !== undefined && (!number(request.estimate) || request.estimate <= 0)) fail('Estimateは正の数です。');
  if (!number(request.estimate ?? request.expectedEstimate) || (request.estimate ?? request.expectedEstimate) <= 0) fail('現在のEstimateを確認してください。');
  if (typeof request.reason !== 'string' || !request.reason.trim() || !/https:\/\/\S+/.test(request.reason)) fail('完了した内容・残る内容・変更理由と成果URLを根拠に記載してください。');
  if (request.expectedProgress === null && request.progress === 0 && request.confirmUnstarted !== true) fail('0の初期入力には未着手の確認が必要です。');
}

function planFor(project, item, request) {
  const progress = numberField(project.fields, PROGRESS_FIELD);
  const estimate = numberField(project.fields, 'Estimate');
  if (!item.id || !item.issueId || item.number !== request.issue || item.state !== 'OPEN' || item.children !== 0 || item.archived) fail('更新対象はProject内の開いた作業Issueです。');
  if (item.actor !== request.actor) fail('指定した担当とProjectの担当が一致しません。');
  const changes = [
    { name: PROGRESS_FIELD, fieldId: progress.id, before: request.expectedProgress, after: request.progress },
    { name: 'Estimate', fieldId: estimate.id, before: request.expectedEstimate, after: request.estimate ?? request.expectedEstimate },
  ];
  return { projectId: project.id, project: project.url, itemId: item.id, issueId: item.issueId, issue: item.url, actor: item.actor, changes };
}

function verifyValues(item, plan, allowed) {
  for (const change of plan.changes) {
    const current = item.values[change.fieldId] ?? null;
    if (!allowed(change, current)) fail(`${change.name}: 現在値が想定と異なります（${current ?? '未入力'}）。再取得して差分を確認してください。`);
  }
}

// Only this explicit entry point writes. The snapshot fetcher and web app never import it.
export async function updateProgress(client, request, { apply = false } = {}) {
  validateRequest(request);
  const project = await client.project();
  let item = await client.item(request.issue);
  const plan = planFor(project, item, request);
  const fingerprint = hash({ plan, reason: request.reason, confirmUnstarted: request.confirmUnstarted === true });
  const marker = `<!-- github-progress:${request.operation}:`;
  const intent = `${marker}${fingerprint}:intent -->`;
  const done = `${marker}${fingerprint}:done -->`;
  const comments = await client.comments(request.issue);
  const own = comments.filter(comment => comment.body.startsWith(marker));
  if (own.some(comment => ![intent, done].some(value => comment.body.startsWith(value)))) fail('同じ操作名が別の変更に使われています。');
  const started = own.some(comment => comment.body.startsWith(intent));
  const finished = own.some(comment => comment.body.startsWith(done));
  verifyValues(item, plan, (change, current) => finished ? current === change.after :
    current === change.before || (started && current === change.after));
  const pending = plan.changes.filter(change => (item.values[change.fieldId] ?? null) !== change.after);
  if (!apply || finished) return { mode: finished ? 'unchanged' : 'preview', ...plan, pending, operation: request.operation };

  let phase = '根拠コメント';
  try {
    if (!started) {
      const rows = plan.changes.map(change => `| ${change.name} | ${change.before ?? '未入力'} | ${change.after} |`).join('\n');
      await client.comment(plan.issueId, `${intent}\n## 作業進捗率の更新予定\n\nProject: ${plan.project}\n担当: ${plan.actor}\n\n| 項目 | 変更前 | 変更後 |\n| --- | --- | --- |\n${rows}\n\n${request.reason.trim()}\n\n適用結果は同じ操作名の完了コメントで確認する。\n操作名: ${request.operation}`);
    }
    const expected = new Map(plan.changes.map(change => [change.fieldId, item.values[change.fieldId] ?? null]));
    const reread = async () => {
      const currentProject = await client.project();
      const currentItem = await client.item(request.issue);
      if (hash(planFor(currentProject, currentItem, request)) !== hash(plan)) fail('対象またはフィールドが変更されました。');
      verifyValues(currentItem, plan, (change, current) => current === expected.get(change.fieldId));
      return currentItem;
    };
    for (const change of pending) {
      phase = change.name;
      await reread();
      await client.setNumber(plan.projectId, plan.itemId, change.fieldId, change.after);
      expected.set(change.fieldId, change.after);
      await reread();
    }
    phase = '適用結果の確認';
    item = await reread();
    phase = '完了コメント';
    await client.comment(plan.issueId, `${done}\n作業進捗率の更新を再取得で確認した。\n操作名: ${request.operation}\n作業進捗率: ${request.progress}%\nEstimate: ${request.estimate ?? request.expectedEstimate}\n\n日程への反映は、snapshotの再取得後に確認する。`);
    return { mode: 'applied', ...plan, operation: request.operation, values: item.values };
  } catch (error) {
    throw new Error(`${phase}で停止しました。適用済みの値は戻しません。同じ引数でプレビューし、差分を確認して再実行してください。原因: ${error.message}`, { cause: error });
  }
}
