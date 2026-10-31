import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMilestoneSchedule } from '../dist/milestone-schedule.mjs';

const key = name => `https://github.com/example/schedule/issues/${typeof name === 'number' ? name : name.charCodeAt(0)}`;
const milestoneKey = n => `https://github.com/example/schedule/milestone/${n}`;
const read = value => ({ value, problem: null });
const links = keys => ({ keys, totalCount: keys.length, complete: true, problem: null });
function task(name, estimate = 1, options = {}) {
  return {
    key: key(name), state: read('open'), completion: { value: options.done ? 'done' : 'not-done', reasons: [options.done ? 'existing-classification:done' : 'existing-classification:todo'] },
    parent: read(options.parent ? key(options.parent) : null), children: links((options.children || []).map(key)), blockedBy: links((options.after || []).map(key)),
    planning: { sourceProjectId: 'project-a', sourceProblem: null, status: read('Todo'), owner: read(options.owner || name.toString()), estimatePoints: read(estimate), workProgressPercent: read(options.progress ?? 0), iteration: read({ startDate: options.start || '2026-10-05', endDate: options.end || '2026-10-30' }) },
  };
}
const milestone = (names, options = {}) => ({ key: milestoneKey(options.id || 1), state: options.state || 'open', dueDate: options.due ?? null, tasks: links(names.map(key)) });
const input = (issues, milestones = [milestone(issues.filter(i => !i.children.keys.length).map(i => Number(i.key.split('/').at(-1))))], baseDate = '2026-10-05') => ({ baseDate, selectedProjectId: 'project-a', fetchedAt: '2026-10-05T09:00:00Z', milestones, issues });
const calculate = (...args) => calculateMilestoneSchedule(input(...args));
const row = (result, name) => result.tasks.find(t => t.key === key(name));
const release = (result, id = 1) => result.milestones.find(m => m.key === milestoneKey(id));
const slack = (result, name, id = 1) => release(result, id).tasks.find(t => t.key === key(name)).slackDays;
const duration = (result, name) => row(result, name).durationDays;
const finish = (result, id = 1) => release(result, id).finish?.coordinate;
const basic = c => [task('A', 2), task('B', 3, { after: ['A'] }), task('C', c)];

test('直列A→Bと並行C: 最早・最遅日程、余裕、クリティカルな辺', () => {
  const result = calculate(basic(4), [milestone(['B', 'C'])]);
  assert.equal(finish(result), 5);
  assert.deepEqual(release(result).criticalTaskKeys, [key('A'), key('B')]);
  assert.equal(slack(result, 'C'), 1);
  assert.equal(row(result, 'B').earliestStart.coordinate, 2);
  assert.equal(release(result).tasks.find(t => t.key === key('C')).latestStart.coordinate, 1);
  assert.deepEqual(release(result).criticalEdgeIds, [result.edges[0].id]);
  assert.equal(release(result).dueDifference, null);
});

for (const [due, days, relation] of [['2026-10-13', 2, 'early'], ['2026-10-07', -2, 'late'], ['2026-10-09', 0, 'on-time']]) {
  test(`期日${due}: 日程と作業の余裕を変えず期日差${days}`, () => {
    const result = calculate(basic(4), [milestone(['B', 'C'], { due })]);
    assert.equal(finish(result), 5);
    assert.equal(slack(result, 'C'), 1);
    assert.deepEqual(release(result).dueDifference, { days, relation, display: `${Math.abs(days)}日` });
  });
}

test('同じ長さの複数経路を列挙せず、作業と辺をすべて返す', () => {
  const result = calculate(basic(5), [milestone(['B', 'C'])]);
  assert.deepEqual(release(result).criticalTaskKeys, ['A', 'B', 'C'].map(key));
  assert.equal(slack(result, 'C'), 0);
  assert.equal(release(result).criticalEdgeIds.length, 1);
});

test('見積5ptの60%完了は残り2日。再取得値で再計算できる', () => {
  const original = input([task('A', 5, { progress: 60 })]);
  const before = structuredClone(original);
  assert.equal(duration(calculateMilestoneSchedule(original), 'A'), 2);
  assert.deepEqual(original, before);
  original.issues[0].planning.workProgressPercent = read(80);
  assert.equal(finish(calculateMilestoneSchedule(original)), 1);
});

test('0.5日ずつをつないで1日とし、途中の小数位置を保つ', () => {
  const result = calculate([task('A', 0.5), task('B', 0.5, { after: ['A'] })]);
  assert.equal(finish(result), 1);
  assert.deepEqual(row(result, 'A').earliestFinish, { coordinate: 0.5, date: '2026-10-05', fraction: 0.5, boundary: 'within' });
  assert.deepEqual(row(result, 'B').earliestFinish, { coordinate: 1, date: '2026-10-05', fraction: 1, boundary: 'end' });
});

for (const [base, start, amount, expectedStart, expectedEnd, coordinate] of [
  ['2026-10-09', '2026-10-05', 2, '2026-10-09', '2026-10-12', 2],
  ['2026-10-10', '2026-10-05', 1, '2026-10-12', '2026-10-12', 1],
  ['2026-10-11', '2026-10-05', 1, '2026-10-12', '2026-10-12', 1],
  ['2026-10-05', '2026-10-12', 2, '2026-10-12', '2026-10-13', 7],
  ['2026-10-09', '2026-10-10', 1, '2026-10-12', '2026-10-12', 2],
  ['2026-12-31', '2026-10-05', 2, '2026-12-31', '2027-01-01', 2],
  ['2028-02-28', '2026-10-05', 2, '2028-02-28', '2028-02-29', 2],
]) {
  test(`平日座標: 基準${base}・開始条件${start}・${amount}pt`, () => {
    const result = calculate([task('A', amount, { start, end: '2029-01-01' })], undefined, base);
    assert.equal(row(result, 'A').earliestStart.date, expectedStart);
    assert.equal(row(result, 'A').earliestFinish.date, expectedEnd);
    assert.equal(finish(result), coordinate);
  });
}

test('整数境界の開始は翌平日、完了は直前平日の終了', () => {
  const result = calculate([task('A'), task('B', 1, { after: ['A'] })], undefined, '2026-10-09');
  assert.equal(row(result, 'A').earliestFinish.date, '2026-10-09');
  assert.equal(row(result, 'B').earliestStart.date, '2026-10-12');
  assert.equal(row(result, 'B').earliestStart.boundary, 'start');
});

test('土日の期日を保持し、過去の期日も符号付き平日差で返す', () => {
  for (const due of ['2026-10-10', '2026-10-11']) {
    const result = calculate([task('A', 2)], [milestone(['A'], { due })], '2026-10-09');
    assert.equal(release(result).dueDate, due);
    assert.equal(release(result).dueDifference.days, -1);
  }
  const past = calculate([task('A')], [milestone(['A'], { due: '2026-10-02' })]);
  assert.equal(release(past).dueDifference.days, -1);
});

test('Iteration終了で切り詰めず、はみ出した量を返す', () => {
  const result = calculate([task('A', 2, { end: '2026-10-05' })]);
  assert.equal(finish(result), 2);
  assert.deepEqual(row(result, 'A').iterationOverflow, { days: 1, display: '1日' });
});

test('日数を小数第2位へ丸めるが、小さな超過や余裕を0と判定しない', () => {
  const result = calculate([task('A', 1.004), task('B', 1), task('C', 1.5)], [milestone(['A', 'B'], { due: '2026-10-05' }), milestone(['C'], { id: 2 })]);
  assert.deepEqual(release(result).dueDifference, { days: -0.004, relation: 'late', display: '0.01日未満' });
  assert.equal(slack(result, 'B'), 0.004);
  assert.equal(release(result).tasks.find(t => t.key === key('B')).slackDisplay, '0.01日未満');
  assert.deepEqual(release(result).criticalTaskKeys, [key('A')]);
  assert.equal(row(result, 'C').durationDisplay, '1.5日');
  assert.equal(row(calculate([task('A', 1.235)]), 'A').durationDisplay, '1.24日');
});

test('十進の0.1+0.2=0.3と科学表記の小数を正確に比較する', () => {
  const result = calculate([task('A', 0.1), task('B', 0.2, { after: ['A'] }), task('C', 0.3)]);
  assert.deepEqual(release(result).criticalTaskKeys, ['A', 'B', 'C'].map(key));
  assert.equal(finish(result), 0.3);
  const tiny = calculate([task('A', 1e-7, { progress: 99 }), task('B', 1e-9)]);
  assert.equal(duration(tiny, 'A'), 1e-9);
  assert.deepEqual(release(tiny).criticalTaskKeys, ['A', 'B'].map(key));
});

test('期日なし、閉じたMilestone、空、全作業完了、一覧不足を区別する', () => {
  const a = task('A', 2), b = task('B', 1, { done: true });
  const incomplete = milestone([], { id: 5 }); incomplete.tasks.complete = false;
  const result = calculate([a, b], [milestone(['A']), milestone(['X'], { id: 2, state: 'closed' }), milestone([], { id: 3 }), milestone(['B'], { id: 4 }), incomplete]);
  assert.deepEqual(result.milestones.map(m => m.state), ['calculated', 'excluded', 'empty', 'completed', 'incomplete']);
  assert.equal(finish(result), 2);
  for (const id of [2, 3, 4, 5]) assert.equal(release(result, id).finish, null);
  assert.equal(release(result, 4).remainingPoints, 0);
  assert.equal(release(result, 5).remainingPoints, null);
  assert.ok(!result.diagnostics.some(d => d.key === key('X')));
});

test('進捗100%でも開始条件と前提を保ち、承認に必要な1日を足す', () => {
  const result = calculate([task('A', 2), task('B', 3, { after: ['A'], progress: 100 }), task('C', 1, { after: ['B'] })], [milestone(['C'])]);
  assert.equal(finish(result), 3);
  assert.equal(duration(result, 'B'), 0);
  assert.equal(row(result, 'B').completion.value, 'not-done');
  assert.deepEqual(row(result, 'B').earliestFinish, row(result, 'B').earliestStart);
  assert.equal(row(result, 'B').earliestStart.coordinate, 2);
  const delayed = calculate([task('A', 1, { progress: 100, start: '2026-10-12' })]);
  assert.equal(finish(delayed), 5);
  assert.equal(release(delayed).finish.date, '2026-10-12');
  assert.equal(release(delayed).finish.boundary, 'start');
});

function parentFixture({ closed = false, nested = false, done = false, prerequisite = false } = {}) {
  const p = task('P', null, { children: nested ? ['M'] : ['A', 'B'], after: prerequisite ? ['Q'] : [] });
  p.state = read(closed ? 'closed' : 'open'); p.completion.value = closed ? 'done' : 'not-done'; p.planning.iteration = read(null);
  const issues = [p, task('A', 2, { parent: nested ? 'M' : 'P', done }), task('B', 3, { parent: nested ? 'M' : 'P', done }), task('T', 1, { after: ['P'] })];
  if (nested) issues.push(task('M', null, { parent: 'P', children: ['A', 'B'] }));
  if (prerequisite) issues.push(task('Q'));
  return issues;
}

for (const options of [{}, { closed: true }, { nested: true }, { closed: true, nested: true }]) {
  test(`集約Issueを末端まで展開: ${JSON.stringify(options)}`, () => {
    const result = calculate(parentFixture(options), [milestone(['T'])]);
    assert.equal(finish(result), 4);
    assert.equal(row(result, 'T').earliestStart.coordinate, 3);
    assert.deepEqual(result.tasks.map(t => t.key), ['A', 'B', 'T'].map(key));
    assert.equal(result.edges.length, 2);
    assert.ok(result.edges.every(edge => edge.evidence[0].prerequisiteAggregates.includes(key('P'))));
    assert.ok(result.relations.some(r => r.prerequisiteKey === key('P') && r.successorKey === key('T')));
  });
}

test('集約Issue自身の前提を末端へ継承し、兄弟を直列にしない', () => {
  const result = calculate(parentFixture({ prerequisite: true }), [milestone(['T'])]);
  assert.equal(finish(result), 5);
  assert.equal(row(result, 'A').earliestStart.coordinate, 1);
  assert.equal(row(result, 'B').earliestStart.coordinate, 1);
  const inherited = result.edges.find(e => e.from === key('Q') && e.to === key('A'));
  assert.deepEqual(inherited.evidence[0].successorAggregates, [key('P')]);
});

test('祖先を参照しただけでは兄弟を対象に追加しない', () => {
  const result = calculate(parentFixture({ nested: true, prerequisite: true }), [milestone(['A'])]);
  assert.deepEqual(result.tasks.map(t => t.key), ['A', 'Q'].map(key));
  assert.equal(finish(result), 3);
  assert.ok(!result.edges.some(e => e.from === key('B') || e.to === key('B')));
});

test('全子が完了ならOpenの親や過去の前提は将来日程を止めない', () => {
  const issues = parentFixture({ done: true, prerequisite: true });
  issues.find(i => i.key === key('Q')).planning.estimatePoints = read(null);
  const before = structuredClone(issues);
  const result = calculate(issues, [milestone(['T'])]);
  assert.equal(finish(result), 1);
  assert.ok(!row(result, 'Q'));
  assert.deepEqual(issues, before);
});

test('完了した末端の出典・計画・親・前提の不足を日程へ復活させない', () => {
  const a = task('A', null, { done: true, after: ['X'] });
  a.state = read('closed'); a.parent = { value: null, problem: 'failed' };
  a.blockedBy.complete = false; a.planning.sourceProblem = 'unselected'; a.planning.sourceProjectId = null;
  for (const field of ['estimatePoints', 'workProgressPercent', 'iteration']) a.planning[field] = { value: null, problem: 'not-fetched' };
  const result = calculate([a, task('B', 1, { after: ['A'] })], [milestone(['B'])]);
  assert.equal(finish(result), 1);
  assert.equal(duration(result, 'A'), 0);
  assert.equal(row(result, 'A').earliestStart, null);
  assert.equal(result.diagnostics.length, 0);
});

test('出典のStatusがDoneでもadapterの未完了判定を変えない', () => {
  const a = task('A', 2); a.planning.status = read('Done');
  const result = calculate([a]);
  assert.equal(finish(result), 2);
  assert.equal(row(result, 'A').completion.value, 'not-done');
});

test('完了判定unknownの理由を保持して後続へ伝える', () => {
  const a = task('A'); a.completion = { value: 'unknown', reasons: ['Project B status forbidden'] };
  const result = calculate([a, task('B', 1, { after: ['A'] }), task('C')]);
  assert.equal(release(result).state, 'incomplete');
  assert.equal(row(result, 'B').earliestStart, null);
  assert.equal(row(result, 'C').earliestFinish.coordinate, 1);
  const cause = result.diagnostics.find(d => d.code === 'unknown-completion');
  assert.deepEqual(cause.details, a.completion.reasons);
  assert.ok(row(result, 'B').diagnosticIds.includes(cause.id));
  assert.deepEqual(row(result, 'B').viaEdgeIds, [result.edges[0].id]);
});

for (const [field, value, problem] of [
  ['estimatePoints', null, null], ['estimatePoints', 0, null], ['estimatePoints', -1, null], ['estimatePoints', Infinity, null],
  ['workProgressPercent', null, null], ['workProgressPercent', -1, null], ['workProgressPercent', 101, null], ['workProgressPercent', 0.5, null],
  ['iteration', null, null], ['iteration', { startDate: '2026-02-30', endDate: '2026-10-30' }, null],
  ['iteration', { startDate: '2026-10-05', endDate: '2026-10-01' }, null],
  ['estimatePoints', null, 'forbidden'], ['workProgressPercent', null, 'not-fetched'], ['iteration', null, 'failed'],
]) {
  test(`必要な値の不足・不正: ${field}=${JSON.stringify(value)} (${problem})`, () => {
    const a = task('A'); a.planning[field] = { value, problem };
    const result = calculate([a, task('B', 1, { after: ['A'] }), task('C')], [milestone(['B', 'C']), milestone(['C'], { id: 2 })]);
    assert.equal(release(result).state, 'incomplete');
    assert.equal(row(result, 'A').earliestStart, null);
    assert.equal(row(result, 'B').earliestStart, null);
    assert.equal(finish(result, 2), 1);
    assert.ok(result.diagnostics.some(d => d.key === key('A') && d.field === field));
    assert.ok(release(result).tasks.every(t => t.slackDays === null));
  });
}

test('100%でもEstimate 0を受理しない。残量0は正の見積と進捗から求める', () => {
  assert.equal(release(calculate([task('A', 0, { progress: 100 })])).state, 'incomplete');
  assert.equal(release(calculate([task('A', 1, { progress: 100 })])).state, 'calculated');
});

test('出典Projectが未確定なら別Projectのフィールドを流用しない', () => {
  for (const sourceProblem of ['unselected', 'not-member', 'unavailable']) {
    const a = task('A'); a.planning.sourceProblem = sourceProblem;
    const result = calculate([a]);
    assert.equal(release(result).state, 'incomplete');
    assert.equal(duration(result, 'A'), null);
  }
});

for (const field of ['parent', 'children', 'blockedBy']) {
  test(`祖先・子・前提の取得不足: ${field}`, () => {
    const a = task('A');
    a[field] = field === 'parent' ? { value: null, problem: 'failed' } : { ...links([]), totalCount: 1, complete: false, problem: 'forbidden' };
    const result = calculate([a, task('T', 1, { after: ['A'] })], [milestone(['T'])]);
    assert.equal(release(result).state, 'incomplete');
    assert.equal(row(result, 'T').earliestStart, null);
    assert.ok(result.diagnostics.some(d => d.field === field));
  });
}

test('Closedでも子の完全取得前に末端または集約完了と推定しない', () => {
  const p = task('P', 1, { done: true }); p.state = read('closed'); p.children.complete = false;
  const result = calculate([p, task('T', 1, { after: ['P'] })], [milestone(['T'])]);
  assert.equal(release(result).state, 'incomplete');
  assert.equal(row(result, 'T').earliestStart, null);
});

test('集約の子が一部不足でも既知の作業と辺を残す', () => {
  const issues = parentFixture(); issues.find(i => i.key === key('P')).children = { keys: [key('A')], totalCount: 2, complete: false, problem: null };
  const result = calculate(issues, [milestone(['T'])]);
  assert.equal(release(result).state, 'incomplete');
  assert.equal(row(result, 'A').earliestFinish.coordinate, 2);
  assert.equal(result.edges.length, 1);
});

test('外部repositoryの前提を含むが対象外Projectの担当重複は断定しない', () => {
  const a = task('A', 2); a.key = 'https://github.com/another/external/issues/65'; a.planning.sourceProjectId = 'project-b';
  const b = task('B'); b.blockedBy = links([a.key]);
  const result = calculate([a, b], [milestone(['B'])]);
  assert.equal(finish(result), 3);
  assert.deepEqual(result.overlapUnchecked, [{ key: a.key, reasons: ['outside-project'] }]);
});

test('未取得の前提を消さず、原因から元のblocked byを追える', () => {
  const result = calculate([task('A', 1, { after: ['X'] })]);
  assert.equal(release(result).state, 'incomplete');
  assert.ok(result.diagnostics.some(d => d.key === key('X') && d.code === 'missing-reference'));
  assert.equal(result.relations[0].prerequisiteKey, key('X'));
});

test('祖先の不足は兄弟の取得を要求せず、継承前提の不足として扱う', () => {
  const a = task('A', 1, { parent: 'P' });
  const result = calculate([a]);
  assert.equal(release(result).state, 'incomplete');
  assert.ok(row(result, 'A').diagnosticIds.length);
  const p = task('P', null, { children: ['A'] }); p.children.complete = false; p.children.totalCount = 3;
  assert.equal(finish(calculate([a, p], [milestone(['A'])])), 1);
});

test('直接循環と、その影響を受ける後続を分ける', () => {
  const result = calculate([task('A', 1, { after: ['B'] }), task('B', 1, { after: ['A'] }), task('C', 1, { after: ['B'] }), task('D')], [milestone(['C']), milestone(['D'], { id: 2 })]);
  assert.deepEqual(result.cycles[0].taskKeys, ['A', 'B'].map(key));
  assert.ok(row(result, 'C').diagnosticIds.includes(result.cycles[0].diagnosticId));
  assert.ok(!row(result, 'C').directDiagnosticIds.includes(result.cycles[0].diagnosticId));
  assert.equal(release(result).state, 'incomplete');
  assert.equal(finish(result, 2), 1);
});

test('子が親を待つと展開後の自己参照を循環として返す', () => {
  const result = calculate([task('P', null, { children: ['A'] }), task('A', 1, { parent: 'P', after: ['P'] }), task('T', 1, { after: ['P'] })], [milestone(['T'])]);
  assert.deepEqual(result.cycles[0].taskKeys, [key('A')]);
  assert.equal(release(result).state, 'incomplete');
});

test('同じ辺の複数根拠を重複計算せず保持する', () => {
  const a = task('A', 2, { parent: 'P', after: ['Q'] });
  const result = calculate([a, task('P', null, { children: ['A'], after: ['Q'] }), task('Q')], [milestone(['A'])]);
  assert.equal(finish(result), 3);
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].evidence.length, 2);
});

test('開始条件による空きがあれば、両端がcriticalでも辺を接続しない', () => {
  const result = calculate([task('A', 2), task('D', 5, { after: ['A'] }), task('B', 2, { after: ['A'], start: '2026-10-12' })], [milestone(['B', 'D'])]);
  assert.equal(finish(result), 7);
  assert.deepEqual(release(result).criticalTaskKeys, ['A', 'B', 'D'].map(key));
  const edge = result.edges.find(e => e.to === key('B'));
  assert.equal(edge.criticalByMilestone[milestoneKey(1)], false);
  assert.equal(release(result).criticalEdgeIds.length, 1);
});

test('共有前提の余裕はMilestoneごとに独立して逆算する', () => {
  const result = calculate([task('A', 2), task('B', 1, { after: ['A'] }), task('C', 5), task('D', 8, { after: ['A'] })], [milestone(['B', 'C']), milestone(['D'], { id: 2 })]);
  assert.equal(finish(result), 5);
  assert.equal(finish(result, 2), 10);
  assert.equal(slack(result, 'A'), 2);
  assert.equal(slack(result, 'A', 2), 0);
  assert.equal(result.tasks.filter(t => t.key === key('A')).length, 1);
});

test('担当の重複区間を作業集合ごとに返し、日程を変更しない', () => {
  const result = calculate([task('A', 3, { owner: 'worker' }), task('B', 2, { owner: 'worker' }), task('C', 1, { owner: 'worker' })]);
  assert.equal(finish(result), 3);
  assert.deepEqual(result.overlaps.map(o => [o.taskKeys, o.start.coordinate, o.finish.coordinate]), [
    [['A', 'B', 'C'].map(key), 0, 1], [['A', 'B'].map(key), 1, 2],
  ]);
});

test('隣接区間と残量0を重複に含めず、極小の重なりは残す', () => {
  const adjacent = calculate([task('A', 0.1, { owner: 'worker' }), task('B', 0.2, { owner: 'worker', after: ['A'] }), task('C', 1, { owner: 'worker', progress: 100 })]);
  assert.equal(adjacent.overlaps.length, 0);
  const tiny = calculate([task('A', 0.3, { owner: 'worker' }), task('B', 0.3000000001), task('C', 1, { owner: 'worker', after: ['A'] }), task('D', 1, { owner: 'worker', after: ['B'] })]);
  assert.ok(tiny.overlaps.some(o => o.start.coordinate === 0.3000000001));
});

test('担当・日程の不足を重複未確認として返すが、担当不足だけでは日程を止めない', () => {
  const a = task('A'); a.planning.owner = read(null);
  const b = task('B'); b.planning.estimatePoints = read(null);
  const result = calculate([a, b]);
  assert.equal(row(result, 'A').earliestFinish.coordinate, 1);
  assert.deepEqual(result.overlapUnchecked, [{ key: key('A'), reasons: ['owner-unknown'] }, { key: key('B'), reasons: ['schedule-unknown'] }]);
});

for (const [name, edit] of [
  ['重複キー', i => i.issues.push(structuredClone(i.issues[0]))],
  ['大文字違いの重複キー', i => i.issues.push({ ...structuredClone(i.issues[0]), key: key('A').toUpperCase() })],
  ['重複リンク', i => i.milestones[0].tasks = links([key('A'), key('A')])],
  ['件数不一致', i => i.issues[0].children.totalCount = 1],
  ['不正基準日', i => i.baseDate = '2026-02-30'],
  ['形式違反の日付', i => i.baseDate = '2026-2-01'],
  ['親子の不一致', i => i.issues.push(task('P', null, { children: ['A'] }))],
  ['子一覧にない親参照', i => { i.issues[0].parent = read(key('P')); i.issues.push(task('P')); }],
  ['親子循環', i => { i.issues[0].parent = read(key('A')); i.issues[0].children = links([key('A')]); }],
  ['取得失敗と値の混在', i => i.issues[0].planning.estimatePoints = { value: 1, problem: 'failed' }],
  ['Read構造の欠落', i => i.issues[0].state = 'open'],
  ['親キーの形式違反', i => i.issues[0].parent = read('P')],
]) {
  test(`入力契約違反を診断として返す: ${name}`, () => {
    const source = input([task('A')]); edit(source);
    const result = calculateMilestoneSchedule(source);
    assert.equal(result.status, 'invalid');
    assert.ok(result.diagnostics.some(d => d.kind === 'contract'));
    assert.deepEqual(result.tasks, []);
  });
}

test('不正な期日は別の日へ補正せず、作業日程は計算する', () => {
  const result = calculate([task('A')], [milestone(['A'], { due: '2026-02-30' })]);
  assert.equal(finish(result), 1);
  assert.equal(release(result).dueDifference, null);
  assert.ok(result.diagnostics.some(d => d.field === 'dueDate'));
});

test('日付を表現できない計算値を確定日程として返さず、後続へ原因を伝える', () => {
  const result = calculate([task('A', 1e308), task('B', 1, { after: ['A'] }), task('C')], [milestone(['B']), milestone(['C'], { id: 2 })]);
  assert.equal(release(result).state, 'incomplete');
  assert.equal(row(result, 'B').earliestStart, null);
  assert.ok(result.diagnostics.some(d => d.code === 'out-of-range'));
  assert.equal(finish(result, 2), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('入力順に依存せず、入力を変更せず、JSONへシリアライズできる', () => {
  const source = input(parentFixture({ nested: true, prerequisite: true }), [milestone(['T', 'A']), milestone(['B'], { id: 2 })]);
  const before = structuredClone(source);
  const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } };
  freeze(source);
  const first = calculateMilestoneSchedule(source);
  assert.deepEqual(source, before);
  before.issues.reverse(); before.milestones.reverse();
  for (const issue of before.issues) { issue.children.keys.reverse(); issue.blockedBy.keys.reverse(); }
  for (const m of before.milestones) m.tasks.keys.reverse();
  assert.deepEqual(calculateMilestoneSchedule(before), first);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});
