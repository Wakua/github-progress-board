// Fictional inputs for the existing prototype. No snapshot or GitHub writes.
const read = value => ({ value, problem: null });
const links = keys => ({ keys, totalCount: keys.length, complete: true, problem: null });
export const issueKey = n => `https://github.com/example/gantt-sample/issues/${n}`;
const milestoneKey = n => `https://github.com/example/gantt-sample/milestone/${n}`;
function task(n, title, estimate, options = {}) {
  return {
    key: issueKey(n), title, category: options.category || (options.done ? '完了' : options.after?.length ? '前提待ち' : '着手可能'),
    state: read(options.closed ? 'closed' : 'open'),
    completion: { value: options.done ? 'done' : 'not-done', reasons: [] },
    parent: read(options.parent ? issueKey(options.parent) : null),
    children: links((options.children || []).map(issueKey)), blockedBy: links((options.after || []).map(issueKey)),
    planning: { sourceProjectId: options.project || 'sample-project', sourceProblem: null,
      status: read(options.done ? 'Done' : 'Todo'), owner: read(options.owner === undefined ? title : options.owner),
      estimatePoints: read(estimate), workProgressPercent: read(options.progress ?? 0),
      iteration: read({ startDate: options.start || '2026-11-02', endDate: options.end || '2026-11-15' }) },
  };
}
function sample(label, issues, targets, options = {}) {
  return { label, input: { baseDate: options.base || '2026-11-02', selectedProjectId: 'sample-project',
    fetchedAt: `${options.base || '2026-11-02'}T09:00:00+09:00`, issues,
    milestones: [
      { key: milestoneKey(1), title: 'リリースA', state: 'open', dueDate: options.due === undefined ? '2026-11-04' : options.due, tasks: links(targets.map(issueKey)) },
      { key: milestoneKey(2), title: '終了したリリース', state: 'closed', dueDate: '2026-10-30', tasks: links([]) },
    ] } };
}
const basicTasks = () => [
  task(200, '機能A', null, { children: [201, 202], closed: true }),
  task(202, '実装B', 3, { parent: 200 }), task(201, '実装A', 2, { parent: 200 }),
  task(210, '結合確認', 1, { after: [200], category: '着手可能' }),
];
const missing = basicTasks();
missing.find(t => t.key === issueKey(202)).planning.workProgressPercent = read(null);
export const samples = {
  basic: sample('前提の展開', basicTasks(), [201, 202, 210]),
  overlap: sample('担当の重複', [task(201, '実装A', 2, { owner: '担当A' }), task(202, '実装B', 3, { owner: '担当A' }), task(210, '結合確認', 1, { after: [201, 202] })], [201, 202, 210]),
  missing: sample('情報不足', missing, [201, 202, 210]),
  cycle: sample('依存の循環', [task(201, '実装A', 2, { after: [202] }), task(202, '実装B', 3, { after: [201] }), task(210, '結合確認', 1, { after: [202] }), task(220, '独立した作業', 1)], [201, 202, 210, 220]),
  fraction: sample('0日と端数', [task(201, '実装A', 5, { progress: 100 }), task(202, '確認B', 0.5, { after: [201] }), task(210, '確認C', 0.5, { after: [202] }), task(220, '承認', 0.004, { after: [210] })], [201, 202, 210, 220], { due: '2026-11-02' }),
  boundary: sample('金曜・年境界・土日の期日', [task(201, '実装A', 2, { start: '2026-12-31', end: '2027-01-01' }), task(202, '実装B', 2, { start: '2027-01-01', end: '2027-01-01' }), task(210, '結合確認', 0.5, { after: [201, 202], start: '2026-12-31', end: '2027-01-03' })], [201, 202, 210], { base: '2026-12-31', due: '2027-01-03' }),
  noDue: sample('期日未設定・複数の経路', [task(201, '実装A', 2), task(202, '実装B', 2), task(210, '結合確認', 1, { after: [201, 202] })], [201, 202, 210], { due: null }),
  external: sample('中間の親・外部の前提', [task(190, '外部の準備', 1, { project: 'external-project' }), task(200, '機能A', null, { children: [205], after: [190], closed: true }), task(205, '実装のまとまり', null, { parent: 200, children: [201, 202] }), task(201, '実装A', 2, { parent: 205, owner: null }), task(202, '実装B', 3, { parent: 205 }), task(210, '結合確認', 1, { after: [200], category: '着手可能' })], [210]),
  empty: sample('作業未登録', [], []),
  completed: sample('全作業完了', [task(201, '実装A', 2, { done: true, closed: true })], [201]),
};
