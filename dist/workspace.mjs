import { orderedTasks, issuePath, iterationTiming, myWork, todayInTokyo } from './engine.mjs';
import { validateSnapshot, attachSnapshot, repositoryKey, isApprovalLimit, APPROVAL_LIMIT_MAX } from './github-snapshot.mjs';

export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'progress-tool.workspace.v1';
export const BACKUP_KEY = `${STORAGE_KEY}.backup`;
export const RECOVERY_KEY = `${STORAGE_KEY}.recovery`;
export const emptyWorkspace = () => ({ schemaVersion: SCHEMA_VERSION, selectedProjectId: null, projects: [] });
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, required = false, max = 10000) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label}を確認してください。`);
};
const id = value => { text(value, 'ID', true, 120); if (!/^[a-zA-Z0-9_-]+$/.test(value)) fail('IDの形式を確認してください。'); };
const nullableId = value => { if (value !== null) id(value); };
const issueNumber = value => { if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) fail('Issue番号を確認してください。'); };
const unique = (values, label) => { if (new Set(values).size !== values.length) fail(`${label}が重複しています。`); };
const array = (value, label) => { if (!Array.isArray(value)) fail(`${label}を確認してください。`); };

function validateObjectKeys(value) {
  const seen = new WeakSet(), pending = [{ value, depth: 0 }];
  while (pending.length) {
    const { value: item, depth } = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (depth > 64) fail('保存データの構造が深すぎます。原本を保持して内容を確認してください。');
    if (seen.has(item)) continue;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) if (child && typeof child === 'object') pending.push({ value: child, depth: depth + 1 });
      continue;
    }
    for (const key of Object.keys(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('保存データに未対応のキーがあります。原本を保持して内容を確認してください。');
      if (item[key] && typeof item[key] === 'object') pending.push({ value: item[key], depth: depth + 1 });
    }
  }
}

export function normalizeRepositoryUrl(value) {
  if (value === null || value === '') return null;
  text(value, 'repository URL', true, 500);
  let url;
  try { url = new URL(value.trim()); } catch { fail('repository URLは https://github.com/owner/repository の形式で入力してください。'); }
  const parts = url.pathname.replace(/\/$/, '').replace(/\.git$/, '').split('/').slice(1);
  if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.search || url.hash ||
      parts.length !== 2 || parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || /^\.+$/.test(part))) {
    fail('repository URLは https://github.com/owner/repository の形式で入力してください。');
  }
  return `https://github.com/${parts.join('/')}`;
}

export function findProject(workspace, projectId) {
  const project = workspace.projects.find(project => project.id === projectId);
  if (!project) fail('プロジェクトが見つかりません。');
  return project;
}

// Issue numbers are display/source attributes, never local identifiers.
export function issueIdentity(project, issue) {
  return { projectId: project.id, repositoryUrl: project.repositoryUrl, entityId: issue.id, issueNumber: issue.issueNumber };
}

function validateProject(project) {
  if (!object(project)) fail('プロジェクトを確認してください。');
  id(project.id); text(project.name, 'プロジェクト名', true, 100);
  if (normalizeRepositoryUrl(project.repositoryUrl) !== project.repositoryUrl) fail('repository URLを確認してください。');
  if (project.githubSnapshot !== undefined) validateSnapshot(project.githubSnapshot, { projectId: project.id, repositoryUrl: project.repositoryUrl });
  if (project.approvalLimit !== undefined && !isApprovalLimit(project.approvalLimit)) fail('承認待ちの上限を確認してください。');
  const data = project.data;
  if (!object(data) || data.project !== project.name) fail('プロジェクトのデータを確認してください。');
  for (const key of ['goals', 'parentIssues', 'tasks', 'iterations', 'decisions', 'history', 'order']) array(data[key], key);
  const issues = [...data.goals, ...data.parentIssues, ...data.tasks];
  const entities = [...issues, ...data.iterations, ...data.decisions];
  for (const entity of entities) {
    if (!object(entity) || entity.projectId !== project.id) fail('別プロジェクトのデータが混入しています。');
    id(entity.id); text(entity.title, '名前', true);
  }
  unique(entities.map(entity => entity.id), 'プロジェクト内のID');
  for (const issue of issues) issueNumber(issue.issueNumber);
  unique(issues.filter(issue => issue.issueNumber !== null).map(issue => issue.issueNumber), 'プロジェクト内のIssue番号');
  for (const parent of [...data.goals, ...data.parentIssues]) {
    if (!['open', 'closed', 'unknown'].includes(parent.issueState)) fail('Issueの状態を確認してください。');
    if (parent.shortTitle !== undefined) text(parent.shortTitle, '短い目標名');
  }
  for (const entity of [...data.parentIssues, ...data.tasks]) {
    id(entity.goalId); id(entity.parentId);
    if (issuePath(data, entity.id)[0]?.id !== entity.goalId) fail('目標・親子関係を確認してください。');
  }
  for (const period of data.iterations) {
    if (period.startDate !== null && iterationTiming({ ...period, durationDays: 1 }).phase === 'unknown') fail('開始日を確認してください。');
    if (period.durationDays !== null && (!Number.isSafeInteger(period.durationDays) || period.durationDays <= 0)) fail('期間を確認してください。');
    if (period.startDate !== null && period.durationDays !== null && iterationTiming(period).phase === 'unknown') fail('期間を確認してください。');
  }
  const taskIds = new Set(data.tasks.map(task => task.id));
  for (const task of data.tasks) {
    if (!['unknown', 'todo', 'active', 'review', 'done'].includes(task.status)) fail('作業の状態を確認してください。');
    for (const key of ['group', 'waitReason', 'evidence']) text(task[key], key);
    if (task.owner !== null) text(task.owner, '担当者', false, 60);
    if (task.estimatePoints !== null && (!Number.isFinite(task.estimatePoints) || task.estimatePoints <= 0)) fail('Estimateを確認してください。');
    if (task.estimateProvenance?.source === 'prepared-estimates-2026-10-04-v1') {
      const p = task.estimateProvenance;
      if (!object(p) || p.source !== 'prepared-estimates-2026-10-04-v1' || p.kind !== 'provisional' || p.points !== task.estimatePoints || !Number.isFinite(p.points) || p.points <= 0 || typeof p.retrospective !== 'boolean' || !Array.isArray(p.range) || p.range.length !== 2 || p.range.some(n => !Number.isFinite(n) || n <= 0) || p.range[0] > p.points || p.range[1] < p.points || !Number.isFinite(Date.parse(p.scopeAt)) || !Number.isFinite(Date.parse(p.recordedAt))) fail('仮見積の注記を確認してください。');
      text(p.rationale, '仮見積の根拠', true, 2000);
    }
    nullableId(task.iterationId);
    if (task.iterationId !== null && !data.iterations.some(period => period.id === task.iterationId)) fail('別プロジェクトまたは未登録のイテレーションです。');
    array(task.deps, '依存関係'); unique(task.deps, '前提作業');
    if (task.deps.some(dep => !taskIds.has(dep) || dep === task.id)) fail('別プロジェクトまたは未登録の前提作業です。');
    array(task.criteria, '完了条件');
    for (const criterion of task.criteria) {
      if (!object(criterion) || typeof criterion.checked !== 'boolean') fail('完了条件を確認してください。');
      text(criterion.text, '完了条件', true);
    }
    if (task.status === 'done' && (!task.criteria.length || task.criteria.some(criterion => !criterion.checked))) fail('完了の根拠となる条件を確認してください。');
    if (task.decisionId !== undefined && !data.decisions.some(decision => decision.id === task.decisionId && decision.taskId === task.id)) fail('判断待ちを確認してください。');
  }
  const visiting = new Set(), visited = new Set();
  const visit = taskId => {
    if (visiting.has(taskId)) fail('依存関係が循環しています。');
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dep of data.tasks.find(task => task.id === taskId).deps) visit(dep);
    visiting.delete(taskId); visited.add(taskId);
  };
  for (const taskId of taskIds) visit(taskId);
  data.order.forEach(id); unique(data.order, '優先順');
  if (data.order.length !== taskIds.size || data.order.some(taskId => !taskIds.has(taskId))) fail('優先順と作業が一致しません。');
  for (const decision of data.decisions) {
    if (!taskIds.has(decision.taskId) || typeof decision.resolved !== 'boolean') fail('判断待ちの作業を確認してください。');
    for (const key of ['choice', 'reason', 'evidence']) text(decision[key], key);
    array(decision.options, '判断の選択肢'); decision.options.forEach(option => text(option, '選択肢', true));
    if (!data.tasks.some(task => task.id === decision.taskId && task.decisionId === decision.id)) fail('判断待ちの対応を確認してください。');
  }
  for (const entry of data.history) {
    if (!object(entry) || entry.projectId !== project.id || !data.goals.some(goal => goal.id === entry.goalId)) fail('変更記録のプロジェクト・目標を確認してください。');
    text(entry.text, '変更記録', true); text(entry.at, '記録日時', true);
    if (!Number.isFinite(Date.parse(entry.at))) fail('記録日時を確認してください。');
  }
}

export function validateWorkspace(workspace) {
  // Imported JSON must remain data when later copied into a mutable draft.
  validateObjectKeys(workspace);
  if (!object(workspace) || workspace.schemaVersion !== SCHEMA_VERSION) fail('保存データのバージョンが未対応です。元データを保持しました。');
  array(workspace.projects, 'プロジェクト一覧'); nullableId(workspace.selectedProjectId);
  workspace.projects.forEach(validateProject); unique(workspace.projects.map(project => project.id), 'プロジェクトID');
  if (workspace.selectedProjectId !== null) findProject(workspace, workspace.selectedProjectId);
  return workspace;
}

export function registerProject(workspace, { name, repositoryUrl = null }, makeId = () => crypto.randomUUID()) {
  text(name, 'プロジェクト名', true, 100);
  const project = { id: makeId(), name: name.trim(), repositoryUrl: normalizeRepositoryUrl(repositoryUrl),
    data: { project: name.trim(), goals: [], parentIssues: [], tasks: [], iterations: [], decisions: [], order: [], history: [] } };
  workspace.projects.push(project); workspace.selectedProjectId = project.id;
  return project;
}

export function selectProject(workspace, projectId) {
  if (projectId !== null) findProject(workspace, projectId);
  workspace.selectedProjectId = projectId;
}

// 承認待ちのPRの上限はプロジェクトごとの設定で、未設定のプロジェクトは既定の件数を使う。
export function setApprovalLimit(workspace, projectId, limit) {
  if (!isApprovalLimit(limit)) fail(`承認待ちの上限は1〜${APPROVAL_LIMIT_MAX}の整数で入力してください。`);
  findProject(workspace, projectId).approvalLimit = limit;
}

// Targets are chosen in the preview. The store validates/saves the entire batch atomically.
export function importSnapshots(workspace, snapshots, targets, makeId = () => crypto.randomUUID()) {
  if (!Array.isArray(snapshots) || !snapshots.length || !Array.isArray(targets) || targets.length !== snapshots.length) fail('snapshotの取込先を確認してください。');
  const originalSelection = workspace.selectedProjectId;
  const used = new Set(), repositories = new Set();
  snapshots.forEach((snapshot, index) => {
    const key = repositoryKey(snapshot.repositoryUrl);
    if (repositories.has(key)) fail('同じrepositoryのsnapshotが重複しています。');
    repositories.add(key);
    const target = targets[index];
    if (!object(target)) fail('snapshotの取込先を確認してください。');
    const project = target.projectId === null ? registerProject(workspace, { name: target.name, repositoryUrl: snapshot.repositoryUrl }, makeId) : findProject(workspace, target.projectId);
    if (used.has(project.id)) fail('同じプロジェクトへの重複取込はできません。');
    used.add(project.id);
    attachSnapshot(project, snapshot);
  });
  workspace.selectedProjectId = originalSelection;
}

export function updateProject(workspace, projectId, action) {
  const project = findProject(workspace, projectId);
  action(project.data);
  // Existing engine writes local history; stamp it at the workspace boundary.
  for (const entry of project.data.history) if (entry.projectId === undefined) entry.projectId = projectId;
}

export function addGoal(data, projectId, { title, issueNumber: number = null }, makeId = () => crypto.randomUUID()) {
  text(title, '目標名', true); issueNumber(number);
  const goal = { id: makeId(), projectId, title: title.trim(), issueNumber: number, issueState: 'unknown' };
  data.goals.push(goal); return goal;
}

export function addTask(data, projectId, { title, goalId, issueNumber: number = null, status = 'unknown', criteria = [] }, makeId = () => crypto.randomUUID()) {
  text(title, '作業名', true); issueNumber(number);
  if (!data.goals.some(goal => goal.id === goalId)) fail('このプロジェクトの目標を選んでください。');
  if (!['unknown', 'todo'].includes(status)) fail('登録時の状態を確認してください。');
  const task = { id: makeId(), projectId, title: title.trim(), goalId, parentId: goalId, issueNumber: number, status,
    group: '', deps: [], criteria: criteria.map(value => ({ text: value.trim(), checked: false })),
    evidence: '', waitReason: '', owner: null, estimatePoints: null, iterationId: null };
  data.tasks.push(task); data.order.push(task.id); return task;
}

export function setTaskCriteria(data, taskId, lines) {
  const task = data.tasks.find(task => task.id === taskId);
  if (!task || task.status === 'done') fail('未完了の作業を選んでください。');
  array(lines, '完了条件'); lines.forEach(line => text(line, '完了条件', true));
  const previous = task.criteria;
  task.criteria = lines.map(line => ({ text: line.trim(), checked: previous.some(criterion => criterion.text === line.trim() && criterion.checked) }));
  data.history.unshift({ text: `${task.title}：完了条件を更新`, goalId: task.goalId, at: new Date().toISOString() });
}

// 仕様が決まらず進められない作業の前に、判断作業を置く。判断作業の担当者が判断する人で、判断を記録すると完了し、元の作業の前提が解ける。
export function addDecision(data, projectId, taskId, { title, options, evidence = '', decider = null, estimatePoints = null }, makeId = () => crypto.randomUUID()) {
  const task = data.tasks.find(task => task.id === taskId);
  if (!task || task.status === 'done') fail('未完了の作業を選んでください。');
  text(title, '判断の名前', true, 200); text(evidence, '判断材料');
  array(options, '判断の選択肢');
  const choices = options.map(option => { text(option, '選択肢', true, 200); return option.trim(); });
  if (choices.length < 2) fail('選択肢を2件以上入力してください。');
  unique(choices, '選択肢');
  if (decider !== null) text(decider, '判断する人', false, 60);
  if (estimatePoints !== null && (!Number.isFinite(estimatePoints) || estimatePoints <= 0)) fail('Estimateは0より大きい数値で入力してください。');
  const decisionTask = { id: makeId(), projectId, title: title.trim(), goalId: task.goalId, parentId: task.parentId, issueNumber: null, status: 'todo',
    group: task.group, deps: [], criteria: [{ text: '採用する内容と理由を記録する', checked: false }], evidence: '', waitReason: '',
    owner: decider?.trim() || null, estimatePoints, iterationId: task.iterationId };
  const decision = { id: makeId(), projectId, title: title.trim(), taskId: decisionTask.id, resolved: false, choice: '', reason: '', evidence: evidence.trim(), options: choices };
  decisionTask.decisionId = decision.id;
  data.tasks.push(decisionTask); data.decisions.push(decision);
  data.order.splice(Math.max(0, data.order.indexOf(task.id)), 0, decisionTask.id);
  task.deps.push(decisionTask.id);
  // 判断が済むまで元の作業は進められないため、作業中・確認待ちは未着手に戻し、前提待ちに入れる。
  const paused = { active: '作業中', review: '確認待ち' }[task.status];
  if (paused) task.status = 'todo';
  data.history.unshift({ text: `${task.title}：判断待ち「${decisionTask.title}」を登録（判断する人：${decisionTask.owner || '未担当'}）${paused ? `。${paused}から未着手に戻した` : ''}`, goalId: task.goalId, at: new Date().toISOString() });
  return decisionTask;
}

export function projectSummary(project, today = todayInTokyo()) {
  const data = project.data, work = myWork(data, undefined, today);
  const section = id => work.sections.find(s => s.id === id)?.tasks || [];
  const next = [...section('active'), ...section('ready-now'), ...section('ready-later')][0]?.task || null;
  return { next, action: section('action'), review: section('review').map(item => item.task), total: orderedTasks(data).length };
}

// A single validated JSON document keeps project selection and all entities atomic.
// Browser Web Locks serialize callers; compare-before-write also rejects stale tabs.
export function createWorkspaceStore(storage) {
  let workspace = emptyWorkspace(), lastRaw = null, backup = null, readOnly = false, problem = '';
  try {
    lastRaw = storage.getItem(STORAGE_KEY);
    const backupRaw = storage.getItem(BACKUP_KEY);
    if (backupRaw !== null) { try { backup = validateWorkspace(JSON.parse(backupRaw)); } catch { /* never trust an invalid backup */ } }
    if (lastRaw !== null) workspace = validateWorkspace(JSON.parse(lastRaw));
    else if (backupRaw !== null) fail('保存データが見つかりません。バックアップを確認してください。');
  } catch (error) {
    readOnly = true;
    workspace = backup ? structuredClone(backup) : emptyWorkspace();
    problem = `保存データを読み込めません。${error.message} 自動で上書きせず、${backup ? 'バックアップを表示' : '編集を停止'}しています。`;
  }
  function assertCurrent() {
    if (storage.getItem(STORAGE_KEY) !== lastRaw) {
      readOnly = true; problem = '別のタブで保存データが変更されました。再読み込みしてから編集してください。'; fail(problem);
    }
  }
  return {
    snapshot: () => structuredClone(workspace),
    status: () => ({ readOnly, problem, hasBackup: backup !== null }),
    raw: () => ({ primary: storage.getItem(STORAGE_KEY), backup: storage.getItem(BACKUP_KEY), recovery: storage.getItem(RECOVERY_KEY) }),
    markStale() { readOnly = true; problem = '別のタブで保存データが変更されました。再読み込みしてから編集してください。'; },
    transact(action) {
      if (readOnly) fail(problem);
      try {
        assertCurrent();
        const draft = structuredClone(workspace);
        action(draft); validateWorkspace(draft);
        const serialized = JSON.stringify(draft);
        if (lastRaw !== null) { storage.setItem(BACKUP_KEY, lastRaw); backup = structuredClone(workspace); }
        storage.setItem(STORAGE_KEY, serialized);
        workspace = draft; lastRaw = serialized; problem = '';
      } catch (error) {
        problem = `保存できませんでした。変更は反映していません。${error.message}`; fail(problem);
      }
    },
    recover(replacement = backup) {
      if (!readOnly || !replacement) fail('復旧用のデータを確認してください。');
      const draft = structuredClone(validateWorkspace(replacement));
      try {
        assertCurrent();
        const archived = storage.getItem(RECOVERY_KEY);
        if (lastRaw !== null) {
          if (archived !== null && archived !== lastRaw) fail('以前の破損データが残っています。保存データを退避してから復旧してください。');
          storage.setItem(RECOVERY_KEY, lastRaw);
        }
        const serialized = JSON.stringify(draft);
        storage.setItem(STORAGE_KEY, serialized);
        workspace = draft; lastRaw = serialized; readOnly = false; problem = '';
      } catch (error) { problem = `復旧できませんでした。元データを保持しています。${error.message}`; fail(problem); }
    }
  };
}
