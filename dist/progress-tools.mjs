import { findProject, projectSummary } from './workspace.mjs';

export function registerProgressTools(context, store) {
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const tool = {
    name: 'read_progress', title: '保存を確認した進捗を読む',
    description: '現在の画面が確認したプロジェクトごとの次の作業・要対応・確認待ちを読む。GitHub snapshotから作業状態を推測しない。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute(input) {
      if (!input || Array.isArray(input) || Object.keys(input).some(key => key !== 'projectId') || (input.projectId !== undefined && typeof input.projectId !== 'string')) throw new Error('projectIdを確認してください。');
      const status = store.status(), workspace = store.snapshot();
      const projects = input.projectId === undefined ? workspace.projects : [findProject(workspace, input.projectId)];
      return { storage: status.mode === 'cloud' ? 'cloud' : 'browser', loaded: status.loaded ?? true, readOnly: status.readOnly, problem: status.problem, updatedAt: status.updatedAt || null,
        projects: projects.map(project => { const summary = projectSummary(project); return { id: project.id, name: project.name, repositoryUrl: project.repositoryUrl, next: summary.next ? { id: summary.next.id, title: summary.next.title, status: summary.next.status } : null,
          action: summary.action.map(({ task, reasons }) => ({ id: task.id, title: task.title, reasons })), review: summary.review.map(task => ({ id: task.id, title: task.title })) }; }) };
    }
  };
  try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* optional browser capability never gates the app */ }
  return () => lifecycle.abort();
}
