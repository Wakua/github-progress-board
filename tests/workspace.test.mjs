import test from 'node:test';
import assert from 'node:assert/strict';
import { createSample, setEstimate, setOwner, setIteration, setWait, setCriterion, transition, goalProgress, overdueTasks } from '../dist/engine.mjs';
import { SCHEMA_VERSION, STORAGE_KEY, BACKUP_KEY, RECOVERY_KEY, emptyWorkspace, validateWorkspace, createWorkspaceStore,
  registerProject, selectProject, updateProject, addGoal, addTask, setTaskCriteria, normalizeRepositoryUrl, issueIdentity, projectSummary, addDecision } from '../dist/workspace.mjs';
import { myWork, resolveDecision } from '../dist/engine.mjs';

class Storage {
  values = new Map(); writes = []; failKey = null;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (key === this.failKey) throw new Error('QuotaExceededError');
    this.values.set(key, value); this.writes.push(key);
  }
}
const fixed = value => () => value;
function twoProjects(storage = new Storage()) {
  const store = createWorkspaceStore(storage);
  store.transact(workspace => {
    for (const [projectId, name] of [['alpha', 'Alpha'], ['beta', 'Beta']]) {
      const project = registerProject(workspace, { name, repositoryUrl: `https://github.com/qa-fixture/${name}` }, fixed(projectId));
      addGoal(project.data, projectId, { title: `${name}の目標`, issueNumber: 1 }, fixed('goal'));
      addTask(project.data, projectId, { title: `${name}の作業`, goalId: 'goal', issueNumber: 7, status: 'todo', criteria: ['確認する'] }, fixed('task'));
    }
  });
  return { store, storage };
}
function sampleProject(projectId) {
  const data = createSample();
  for (const key of ['goals', 'parentIssues', 'tasks', 'iterations', 'decisions', 'history']) data[key].forEach(entity => { entity.projectId = projectId; });
  return { id: projectId, name: data.project, repositoryUrl: null, data };
}

test('初回は空のプロジェクト一覧。架空データや自動保存は入らない', () => {
  const storage = new Storage(), store = createWorkspaceStore(storage);
  assert.deepEqual(store.snapshot(), emptyWorkspace());
  assert.equal(store.status().readOnly, false);
  assert.deepEqual(storage.writes, []);
});

test('Alpha・Beta・本ツールを空のまま登録し、IDとrepository URLを再読込で復元する', () => {
  const storage = new Storage(), store = createWorkspaceStore(storage);
  store.transact(workspace => {
    for (const name of ['Alpha', 'Beta', 'progress-tool']) registerProject(workspace, { name });
  });
  const workspace = createWorkspaceStore(storage).snapshot();
  assert.deepEqual(workspace.projects.map(project => project.name), ['Alpha', 'Beta', 'progress-tool']);
  assert.equal(new Set(workspace.projects.map(project => project.id)).size, 3);
  for (const project of workspace.projects) {
    assert.equal(project.repositoryUrl, null);
    for (const key of ['goals', 'tasks', 'iterations', 'decisions', 'history']) assert.deepEqual(project.data[key], []);
    assert.equal(projectSummary(project).next, null);
  }
  assert.equal(workspace.selectedProjectId, workspace.projects[2].id);
});

test('repository URLは正規化するが、credential・Issue URL・外部URLを保存しない', () => {
  assert.equal(normalizeRepositoryUrl(' https://github.com/Wakua/github-progress-board.git/ '), 'https://github.com/Wakua/github-progress-board');
  assert.equal(normalizeRepositoryUrl(''), null);
  for (const url of ['http://github.com/a/b', 'https://github.com/a/b/issues/1', 'https://user:secret@github.com/a/b',
    'https://github.com/a/b?token=secret', 'https://github.com/a/b#main', 'javascript:alert(1)', 'https://example.com/a/b', 'https://github.com/a/b%20c']) {
    assert.throws(() => normalizeRepositoryUrl(url), /repository URL/);
  }
});

test('見積・期限・Issue・状態が不明な値を保持し、完了率や超過を捏造しない', () => {
  const store = createWorkspaceStore(new Storage());
  store.transact(workspace => {
    const project = registerProject(workspace, { name: 'Beta' }, fixed('beta'));
    addGoal(project.data, project.id, { title: '目標' }, fixed('goal'));
    addTask(project.data, project.id, { title: '未確認の作業', goalId: 'goal' }, fixed('task'));
  });
  const project = store.snapshot().projects[0], task = project.data.tasks[0];
  assert.equal(task.status, 'unknown');
  for (const key of ['estimatePoints', 'iterationId', 'issueNumber', 'owner']) assert.equal(task[key], null);
  assert.equal(goalProgress(project.data, 'goal').percent, null);
  assert.deepEqual(overdueTasks(project.data), []);
  assert.equal(projectSummary(project).next, null);
  assert.deepEqual(projectSummary(project).action.map(item => item.reasons), [['状態が未確認']]);
});

test('同じIssue番号・同じ内部IDでも別プロジェクトを混同せず、繰り返し切替・保存できる', () => {
  const { store, storage } = twoProjects();
  const other = structuredClone(store.snapshot().projects[1]);
  for (let index = 0; index < 20; index++) {
    store.transact(workspace => { selectProject(workspace, index % 2 ? 'beta' : 'alpha'); });
    store.transact(workspace => updateProject(workspace, 'alpha', data => {
      setEstimate(data, 'task', index + 0.5); data.tasks[0].evidence = `Alphaの証拠${index}`;
    }));
  }
  const restored = createWorkspaceStore(storage).snapshot();
  assert.deepEqual(restored.projects[1], other);
  assert.equal(restored.projects[0].data.tasks[0].estimatePoints, 19.5);
  assert.equal(restored.projects[0].data.tasks[0].evidence, 'Alphaの証拠19');
  assert.equal(restored.selectedProjectId, 'beta');
  assert.notDeepEqual(issueIdentity(restored.projects[0], restored.projects[0].data.tasks[0]), issueIdentity(other, other.data.tasks[0]));
  assert.equal(issueIdentity(other, other.data.tasks[0]).repositoryUrl, 'https://github.com/qa-fixture/Beta');
  assert.ok(restored.projects[0].data.history.every(entry => entry.projectId === 'alpha'));
});

test('状態・条件・担当・割当・待ち・証拠・依存・判断・親子Issueの全データを保存する', () => {
  const storage = new Storage(), store = createWorkspaceStore(storage);
  store.transact(workspace => { workspace.projects = [sampleProject('sample')]; selectProject(workspace, 'sample'); });
  store.transact(workspace => updateProject(workspace, 'sample', data => {
    setOwner(data, 'move', '担当'); setEstimate(data, 'move', null); setIteration(data, 'move', null);
    setCriterion(data, 'move', 1, true); transition(data, 'move', 'review'); setWait(data, 'multi', '仕様確認');
    data.tasks.find(task => task.id === 'move').evidence = '確認した成果物';
  }));
  assert.deepEqual(createWorkspaceStore(storage).snapshot(), store.snapshot());
  const data = store.snapshot().projects[0].data;
  assert.equal(data.tasks.find(task => task.id === 'move').status, 'review');
  assert.ok(data.history.every(entry => entry.projectId === 'sample'));
});

test('別プロジェクトの目標・親・前提・割当・記録を保存しない', () => {
  const { store, storage } = twoProjects();
  const before = storage.getItem(STORAGE_KEY);
  const changes = [
    data => { data.tasks[0].projectId = 'beta'; },
    data => { data.tasks[0].goalId = 'other-project-goal'; },
    data => { data.tasks[0].parentId = 'other-project-goal'; },
    data => { data.tasks[0].deps = ['other-project-task']; },
    data => { data.tasks[0].iterationId = 'other-project-iteration'; },
    data => { data.history.push({ projectId: 'beta', goalId: 'goal', text: '混入', at: new Date().toISOString() }); }
  ];
  for (const change of changes) {
    assert.throws(() => store.transact(workspace => updateProject(workspace, 'alpha', change)));
    assert.equal(storage.getItem(STORAGE_KEY), before);
  }
  assert.equal(store.snapshot().projects[0].data.tasks[0].projectId, 'alpha');
});

test('重複ID・Issue番号・順序の欠落・循環を保存せず、直前の状態を維持する', () => {
  const { store, storage } = twoProjects();
  const before = storage.getItem(STORAGE_KEY);
  const changes = [
    data => { data.tasks[0].id = 'goal'; },
    data => { data.tasks[0].issueNumber = 1; },
    data => { data.order = []; },
    data => { data.tasks[0].deps = ['task']; },
    data => {
      addTask(data, 'alpha', { title: '後続', goalId: 'goal' }, fixed('next'));
      data.tasks[0].deps = ['next']; data.tasks[1].deps = ['task'];
    },
    data => { data.goals.push({ ...data.goals[0] }); },
    data => { data.tasks[0].estimatePoints = 0; },
    data => { data.tasks[0].criteria[0].checked = 'true'; },
    data => { data.tasks[0].status = 'done'; }
  ];
  for (const change of changes) {
    assert.throws(() => store.transact(workspace => updateProject(workspace, 'alpha', change)));
    assert.equal(storage.getItem(STORAGE_KEY), before);
  }
});

test('保存失敗・途中例外ではメモリと保存済みデータを巻き戻す', () => {
  for (const failKey of [BACKUP_KEY, STORAGE_KEY]) {
    const { store, storage } = twoProjects(), before = store.snapshot(), raw = storage.getItem(STORAGE_KEY);
    storage.failKey = failKey;
    assert.throws(() => store.transact(workspace => updateProject(workspace, 'alpha', data => setEstimate(data, 'task', 8))), /保存できません/);
    assert.deepEqual(store.snapshot(), before);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    storage.failKey = null;
    store.transact(workspace => updateProject(workspace, 'alpha', data => setEstimate(data, 'task', 3)));
    assert.equal(store.status().problem, '');
  }
  const { store } = twoProjects(), before = store.snapshot();
  assert.throws(() => store.transact(workspace => { workspace.projects.pop(); throw new Error('中断'); }));
  assert.deepEqual(store.snapshot(), before);
  const detached = store.snapshot(); detached.projects[0].name = '変更';
  assert.deepEqual(store.snapshot(), before);
});

test('破損JSON・不正構造・未対応バージョンを上書きせず編集を停止する', () => {
  const broken = ['{', 'null', '[]', '{}', JSON.stringify({ ...emptyWorkspace(), schemaVersion: SCHEMA_VERSION + 1 }),
    JSON.stringify({ ...emptyWorkspace(), selectedProjectId: 'missing' }), JSON.stringify({ ...emptyWorkspace(), projects: [null] })];
  for (const raw of broken) {
    const storage = new Storage(); storage.values.set(STORAGE_KEY, raw);
    const store = createWorkspaceStore(storage);
    assert.equal(store.status().readOnly, true);
    assert.deepEqual(store.snapshot(), emptyWorkspace());
    assert.throws(() => store.transact(workspace => registerProject(workspace, { name: '上書き' })));
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.deepEqual(storage.writes, []);
  }
});

test('破損した主データは有効なバックアップを閲覧し、明示復旧時に破損原本を退避する', () => {
  const { store, storage } = twoProjects();
  const before = store.snapshot(); store.transact(workspace => selectProject(workspace, null));
  storage.values.set(STORAGE_KEY, 'broken');
  const restored = createWorkspaceStore(storage);
  assert.equal(restored.status().readOnly, true);
  assert.equal(restored.status().hasBackup, true);
  assert.deepEqual(restored.snapshot(), before);
  assert.throws(() => restored.transact(workspace => selectProject(workspace, 'alpha')));
  restored.recover();
  assert.equal(storage.getItem(RECOVERY_KEY), 'broken');
  assert.equal(restored.status().readOnly, false);
  assert.deepEqual(createWorkspaceStore(storage).snapshot(), before);
});

test('主データが欠けてもバックアップを自動上書きせず、無効なバックアップは信用しない', () => {
  const storage = new Storage(); storage.values.set(BACKUP_KEY, JSON.stringify(emptyWorkspace()));
  const missing = createWorkspaceStore(storage);
  assert.equal(missing.status().readOnly, true); missing.recover();
  assert.deepEqual(missing.snapshot(), emptyWorkspace());
  storage.values.set(STORAGE_KEY, 'broken'); storage.values.set(BACKUP_KEY, '{}');
  const invalid = createWorkspaceStore(storage);
  assert.equal(invalid.status().readOnly, true); assert.equal(invalid.status().hasBackup, false);
  assert.throws(() => invalid.recover());
  assert.equal(storage.getItem(STORAGE_KEY), 'broken');
});

test('復旧JSONを検証し、退避や復旧書込の失敗で破損原本を失わない', () => {
  for (const failKey of [RECOVERY_KEY, STORAGE_KEY]) {
    const storage = new Storage(); storage.values.set(STORAGE_KEY, 'broken'); storage.failKey = failKey;
    const store = createWorkspaceStore(storage);
    assert.throws(() => store.recover({}), /バージョン/);
    assert.throws(() => store.recover(emptyWorkspace()), /復旧できません/);
    assert.equal(storage.getItem(STORAGE_KEY), 'broken'); assert.equal(store.status().readOnly, true);
  }
  const storage = new Storage(); storage.values.set(STORAGE_KEY, 'broken'); storage.values.set(RECOVERY_KEY, 'previous-broken');
  const store = createWorkspaceStore(storage); assert.throws(() => store.recover(emptyWorkspace()), /以前の破損データ/);
  assert.equal(storage.getItem(RECOVERY_KEY), 'previous-broken');
});

test('別タブの保存後は古いデータで上書きしない。再読み込み後は編集できる', () => {
  const { storage } = twoProjects();
  const first = createWorkspaceStore(storage), stale = createWorkspaceStore(storage);
  first.transact(workspace => updateProject(workspace, 'alpha', data => setEstimate(data, 'task', 2)));
  const currentRaw = storage.getItem(STORAGE_KEY);
  assert.throws(() => stale.transact(workspace => selectProject(workspace, 'alpha')), /別のタブ/);
  assert.equal(storage.getItem(STORAGE_KEY), currentRaw); assert.equal(stale.status().readOnly, true);
  const reloaded = createWorkspaceStore(storage);
  reloaded.transact(workspace => selectProject(workspace, 'alpha'));
  assert.equal(reloaded.snapshot().projects[0].data.tasks[0].estimatePoints, 2);
});

test('保存領域の利用禁止で初期表示が落ちず、未保存の編集を受け付けない', () => {
  const store = createWorkspaceStore({ getItem() { throw new Error('SecurityError'); } });
  assert.deepEqual(store.snapshot(), emptyWorkspace()); assert.equal(store.status().readOnly, true);
  assert.throws(() => store.transact(workspace => registerProject(workspace, { name: 'Alpha' })), /SecurityError/);
});

test('全体一覧は進められる作業・要対応・確認待ちを分け、止まった作業中を次に選ばない', () => {
  const project = sampleProject('sample');
  project.data.tasks.find(task => task.id === 'move').waitReason = '表示の判断待ち';
  const summary = projectSummary(project, '2026-10-01');
  assert.equal(summary.next.id, 'notice-format');
  assert.deepEqual(summary.action.map(item => item.task.id), ['move', 'delete', 'format', 'check']);
  assert.deepEqual(summary.action.find(item => item.task.id === 'check').reasons, ['前提が期限超過：案内文の見え方の調整']);
  assert.deepEqual(summary.action.find(item => item.task.id === 'delete').reasons, ['期限超過（4日）']);
  assert.deepEqual(summary.review.map(task => task.id), []);
  assert.equal(summary.total, 17);
});

test('全体一覧の要対応は前提待ちを数えない', () => {
  const project = sampleProject('sample');
  const summary = projectSummary(project, '2026-09-20');
  const ids = summary.action.map(item => item.task.id);
  assert.ok(!ids.includes('multi'), '前提が作業中で期間内なら前提待ちに入る');
  assert.ok(ids.includes('format'), '判断待ちは要対応に入る');
  assert.deepEqual(summary.review.map(task => task.id), ['delete']);
});

test('入れ子の破損は読み込み時にも検出する', () => {
  const { store } = twoProjects();
  const invalid = store.snapshot(); invalid.projects[0].data.tasks[0].deps = ['not-here'];
  assert.throws(() => validateWorkspace(invalid), /前提作業/);
  const storage = new Storage(); storage.values.set(STORAGE_KEY, JSON.stringify(invalid));
  const restored = createWorkspaceStore(storage);
  assert.equal(restored.status().readOnly, true); assert.equal(storage.writes.length, 0);
});

test('完了条件が不明でも登録でき、後から追加して確認状態を保存できる', () => {
  const { store, storage } = twoProjects();
  store.transact(workspace => updateProject(workspace, 'alpha', data => {
    setCriterion(data, 'task', 0, true);
    setTaskCriteria(data, 'task', ['確認する', '追加した条件']);
  }));
  const criteria = createWorkspaceStore(storage).snapshot().projects[0].data.tasks[0].criteria;
  assert.deepEqual(criteria, [{ text: '確認する', checked: true }, { text: '追加した条件', checked: false }]);
  store.transact(workspace => updateProject(workspace, 'alpha', data => setTaskCriteria(data, 'task', [])));
  assert.equal(goalProgress(store.snapshot().projects[0].data, 'goal').percent, null);
  assert.throws(() => store.transact(workspace => updateProject(workspace, 'alpha', data => { data.tasks[0].status = 'done'; })), /完了の根拠/);
});

test('過度に深いJSONを保存せず、既存の保存と通常のmetadataを保持する', () => {
  const { store, storage } = twoProjects(), before = storage.getItem(STORAGE_KEY);
  const tooDeep = {}; let current = tooDeep;
  for (let index = 0; index < 80; index++) { current.next = {}; current = current.next; }
  assert.throws(() => store.transact(workspace => { workspace.extraMetadata = tooDeep; }), /深すぎ/);
  assert.equal(storage.getItem(STORAGE_KEY), before);
  store.transact(workspace => { workspace.extraMetadata = { note: '無害な追加情報', numericList: [1, 2, 3] }; });
  assert.deepEqual(createWorkspaceStore(storage).snapshot().extraMetadata, { note: '無害な追加情報', numericList: [1, 2, 3] });
});

test('判断待ちの登録は判断作業を前提に置き、判断する人の要対応・担当者の前提待ちに分ける', () => {
  const { store } = twoProjects();
  store.transact(workspace => updateProject(workspace, 'alpha', data => {
    data.tasks[0].owner = 'Claude';
    let next = 0; const ids = ['decision-task', 'decision'];
    addDecision(data, 'alpha', 'task', { title: '保存方式を決める', options: [' ブラウザに保存 ', 'サーバーに保存'], evidence: '容量と共有を比べる', decider: ' Wakua ', estimatePoints: 0.5 }, () => ids[next++]);
  }));
  const project = store.snapshot().projects.find(project => project.id === 'alpha');
  validateWorkspace(store.snapshot());
  const data = project.data;
  const decisionTask = data.tasks.find(task => task.id === 'decision-task');
  assert.deepEqual([decisionTask.owner, decisionTask.status, decisionTask.goalId, decisionTask.decisionId, decisionTask.estimatePoints], ['Wakua', 'todo', 'goal', 'decision', 0.5]);
  assert.deepEqual(data.decisions.find(d => d.id === 'decision').options, ['ブラウザに保存', 'サーバーに保存']);
  assert.deepEqual(data.tasks.find(task => task.id === 'task').deps, ['decision-task']);
  assert.deepEqual(data.order, ['decision-task', 'task']);
  assert.match(data.history[0].text, /判断待ち「保存方式を決める」を登録（判断する人：Wakua）/);
  const sections = owner => Object.fromEntries(myWork(data, owner, '2026-10-04').sections.map(s => [s.id, s.tasks.map(item => [item.task.id, item.reasons])]));
  assert.deepEqual(sections('Wakua'), { action: [['decision-task', ['判断待ち：保存方式を決める']]] });
  assert.deepEqual(sections('Claude'), { waiting: [['task', ['前提：保存方式を決める（未着手）']]] });
  resolveDecision(data, 'decision', 'ブラウザに保存', '共有はまだ不要なため');
  assert.equal(decisionTask.status, 'done');
  assert.deepEqual(sections('Claude'), { 'ready-later': [['task', []]] });
  assert.deepEqual(sections('Wakua'), {});
  const resolved = data.decisions.find(d => d.id === 'decision');
  assert.deepEqual([resolved.resolved, resolved.choice, resolved.reason], [true, 'ブラウザに保存', '共有はまだ不要なため']);
});

test('判断待ちを登録すると作業中・確認待ちの元の作業は未着手に戻り前提待ちに入る', () => {
  for (const [status, label] of [['active', '作業中'], ['review', '確認待ち']]) {
    const { store } = twoProjects();
    store.transact(workspace => updateProject(workspace, 'alpha', data => {
      Object.assign(data.tasks[0], { owner: 'Claude', status });
      let next = 0; const ids = ['decision-task', 'decision'];
      addDecision(data, 'alpha', 'task', { title: '決める', options: ['A', 'B'], decider: 'Wakua' }, () => ids[next++]);
    }));
    const data = store.snapshot().projects.find(project => project.id === 'alpha').data;
    assert.equal(data.tasks.find(task => task.id === 'task').status, 'todo');
    assert.match(data.history[0].text, new RegExp(`${label}から未着手に戻した`));
    const sections = Object.fromEntries(myWork(data, 'Claude', '2026-10-04').sections.map(s => [s.id, s.tasks.map(item => [item.task.id, item.reasons])]));
    assert.deepEqual(sections, { waiting: [['task', ['前提：決める（未着手）']]] }, status);
  }
});

test('判断待ちの登録は名前・2件以上の重複しない選択肢・判断する人・Estimateを検証する', () => {
  const { store } = twoProjects();
  const add = input => store.transact(workspace => updateProject(workspace, 'alpha', data => addDecision(data, 'alpha', 'task', { title: '決める', options: ['A', 'B'], ...input })));
  assert.throws(() => add({ title: ' ' }), /判断の名前/);
  assert.throws(() => add({ options: ['A'] }), /2件以上/);
  assert.throws(() => add({ options: ['A', ' A '] }), /重複/);
  assert.throws(() => add({ decider: 'x'.repeat(61) }), /判断する人/);
  assert.throws(() => add({ estimatePoints: 0 }), /Estimate/);
  assert.equal(store.snapshot().projects[0].data.tasks.length, 1, '失敗した登録は保存しない');
  add({ decider: null });
  assert.equal(store.snapshot().projects[0].data.tasks.find(task => task.decisionId).owner, null);
});
