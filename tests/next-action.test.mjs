import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSampleWorkspace } from '../scripts/make-booking-sample.mjs';
import { NEXT_ACTIONS, isNextActions, nextActionCopyText } from '../dist/next-action.mjs';
import { validateWorkspace, setNextAction, findProject } from '../dist/workspace.mjs';
import { renderGithubWork, githubNextActionCounts, githubNextActionText } from '../dist/github-planning-view.mjs';
import { githubMyWork } from '../dist/github-work.mjs';

const TODAY = '2026-10-13';
const sample = () => bookingSampleWorkspace(new Date('2026-10-13T00:30:00Z'));
const everyone = { all: true };

test('区分は仕様の9種類で、idと表示名が重複しない', () => {
  assert.equal(NEXT_ACTIONS.length, 9);
  assert.equal(new Set(NEXT_ACTIONS.map(action => action.id)).size, 9);
  assert.equal(new Set(NEXT_ACTIONS.map(action => action.label)).size, 9);
  assert.ok(NEXT_ACTIONS.some(action => action.label === '受入確認する'));
});

test('保存する区分は Issue番号と区分のidの組だけを受け付ける', () => {
  assert.ok(isNextActions({}));
  assert.ok(isNextActions({ 3: 'ai', 12: 'spec' }));
  for (const bad of [null, [], 'ai', { x: 'ai' }, { 0: 'ai' }, { '-1': 'ai' }, { 3: 'unknown' }, { 3: null }, { 3: 'ai', 4: 7 }]) assert.ok(!isNextActions(bad), JSON.stringify(bad));
});

test('区分を付けて外すと、プロジェクトの保存データだけが変わり、検証を通る', () => {
  const workspace = sample(), project = workspace.projects[0], snapshotBefore = JSON.stringify(project.githubSnapshot);
  assert.equal(project.nextActions, undefined);
  setNextAction(workspace, project.id, 9, 'spec');
  setNextAction(workspace, project.id, 3, 'ai');
  assert.deepEqual(findProject(workspace, project.id).nextActions, { 3: 'ai', 9: 'spec' });
  validateWorkspace(workspace);
  setNextAction(workspace, project.id, 3, 'later');
  assert.equal(project.nextActions[3], 'later');
  setNextAction(workspace, project.id, 3, null);
  setNextAction(workspace, project.id, 9, null);
  assert.equal(project.nextActions, undefined);
  assert.equal(JSON.stringify(project.githubSnapshot), snapshotBefore);
});

test('不正な区分・Issue番号は保存せず、保存データの検証でも拒否する', () => {
  const workspace = sample(), id = workspace.projects[0].id;
  assert.throws(() => setNextAction(workspace, id, 3, 'unknown'), /区分/);
  assert.throws(() => setNextAction(workspace, id, 0, 'ai'), /Issue番号/);
  assert.throws(() => setNextAction(workspace, id, 'x', 'ai'), /Issue番号/);
  assert.throws(() => setNextAction(workspace, 'missing', 3, 'ai'), /プロジェクト/);
  assert.equal(workspace.projects[0].nextActions, undefined);
  workspace.projects[0].nextActions = { 3: 'unknown' };
  assert.throws(() => validateWorkspace(workspace), /次にすること/);
});

test('区分のない旧データも読み込め、GitHub snapshotの再取得では区分が変わらない', () => {
  const workspace = sample();
  validateWorkspace(workspace);
  setNextAction(workspace, workspace.projects[0].id, 4, 'ai');
  const refreshed = sample().projects[0].githubSnapshot;
  workspace.projects[0].githubSnapshot = refreshed;
  validateWorkspace(workspace);
  assert.deepEqual(workspace.projects[0].nextActions, { 4: 'ai' });
});

test('一覧の区分の件数は、完了・Closedを除き、区分なしを別に数える', () => {
  const { githubSnapshot: snapshot } = sample().projects[0];
  const none = githubNextActionCounts(snapshot, everyone, TODAY, {});
  assert.equal(none.total, 14);
  assert.deepEqual([...none.counts], [['none', 14]]);
  const counts = githubNextActionCounts(snapshot, everyone, TODAY, { 3: 'ai', 4: 'ai', 9: 'spec', 2: 'done' });
  assert.equal(counts.counts.get('ai'), 2);
  assert.equal(counts.counts.get('spec'), 1);
  assert.equal(counts.counts.get('none'), 11, '#2はClosedなので区分を数えない');
  const wakua = githubNextActionCounts(snapshot, { owner: 'Wakua' }, TODAY, { 3: 'ai', 9: 'spec' });
  assert.equal(wakua.counts.get('spec'), 1);
  assert.equal(wakua.counts.get('ai'), undefined, '担当者で絞った外の作業は数えない');
});

test('区分で絞った作業を、番号・題名・状態・根拠つきでコピーする文にする', () => {
  const { githubSnapshot: snapshot } = sample().projects[0];
  const text = githubNextActionText(snapshot, everyone, TODAY, { 9: 'spec', 15: 'spec', 3: 'ai' }, 'spec');
  assert.equal(text.split('\n')[0], '次にすること：仕様を決める（区分：仕様を決める、2件）');
  assert.match(text, /^repository：example\/booking-app$/m);
  assert.match(text, /^- #9 保存形式を決める｜Todo｜根拠：要対応：仕様待ち：保存形式を決める、期限超過：It1（10\/11終了）$/m);
  assert.match(text, /^- #15 管理画面で予約を絞り込む｜Todo｜根拠：他の作業待ち：前提：#14 予約の変更を通知する$/m);
  assert.doesNotMatch(text, /#3 /, '別の区分の作業は含めない');
  const ready = githubNextActionText(snapshot, everyone, TODAY, { 8: 'ai' }, 'ai');
  assert.match(ready, /^- #8 手順書を書く｜Todo｜根拠：着手可能$/m);
  const review = githubNextActionText(snapshot, everyone, TODAY, { 11: 'accept' }, 'accept');
  assert.match(review, /^- #11 予約の自動テストを足す｜Todo｜根拠：確認待ち：承認待ちのPR #31$/m);
  assert.equal(githubNextActionText(snapshot, everyone, TODAY, {}, 'unknown'), null);
});

test('担当者の絞り込みの外にある作業はコピーしない', () => {
  const { githubSnapshot: snapshot } = sample().projects[0];
  const text = githubNextActionText(snapshot, { owner: 'Claude' }, TODAY, { 9: 'ai', 14: 'ai' }, 'ai');
  assert.match(text, /（区分：AIに渡す、1件）/);
  assert.match(text, /#14 /);
  assert.doesNotMatch(text, /#9 /);
});

test('コピー文は区分の次にすることを先頭に置き、作業のない区分も作れる', () => {
  assert.equal(nextActionCopyText('a/b', NEXT_ACTIONS[0], [{ number: 1, title: 'x', status: 'Todo', basis: '着手可能' }]),
    '次にすること：Issueを閉じる（区分：終わっている、1件）\nrepository：a/b\n- #1 x｜Todo｜根拠：着手可能');
  assert.equal(nextActionCopyText(null, NEXT_ACTIONS[0], []), '次にすること：Issueを閉じる（区分：終わっている、0件）');
});

test('区分が一つもなければ絞り込みを出さず、作業ごとに区分の選択を出す。完了・Closedには出さない', () => {
  const { githubSnapshot: snapshot } = sample().projects[0];
  const html = renderGithubWork(snapshot, everyone, TODAY);
  assert.doesNotMatch(html, /next-action-filter/);
  assert.equal(html.match(/class="next-action-select/g).length, 14);
  assert.doesNotMatch(html, /data-id="2" aria-label="#2の次にすること"/);
  assert.match(html, /<option value="">区分<\/option>/);
  assert.match(html, /他の作業待ち <span class="my-work-count">2件/);
  assert.doesNotMatch(html, /前提待ち/);
});

test('区分を付けた作業があれば絞り込みを出し、選んだ区分の作業だけを一覧に残す', () => {
  const { githubSnapshot: snapshot } = sample().projects[0];
  const nextActions = { 9: 'spec', 15: 'spec', 3: 'ai' };
  const all = renderGithubWork(snapshot, everyone, TODAY, { nextActions });
  assert.match(all, /data-next-action-filter="" aria-pressed="true">すべて 14件/);
  assert.match(all, /data-next-action-filter="spec" aria-pressed="false">仕様を決める 2件/);
  assert.match(all, /data-next-action-filter="none" aria-pressed="false">区分なし 11件/);
  assert.doesNotMatch(all, /data-next-action-copy/, '「すべて」ではコピーを出さない');
  const spec = renderGithubWork(snapshot, everyone, TODAY, { nextActions, nextFilter: 'spec' });
  assert.deepEqual([...spec.matchAll(/data-github-task="(\d+)"/g)].map(m => m[1]).sort(), ['15', '9']);
  assert.match(spec, /data-next-action-copy="spec"/);
  assert.match(spec, /<option value="spec" selected>仕様を決める<\/option>/);
  const none = renderGithubWork(snapshot, everyone, TODAY, { nextActions, nextFilter: 'none' });
  assert.equal([...none.matchAll(/data-github-task="/g)].length, 11, '区分なしの未完了11件だけで、完了・Closedは出さない');
  assert.doesNotMatch(none, /data-next-action-copy/);
});

test('選んだ区分の作業がなくなったら「すべて」に戻す', () => {
  const { githubSnapshot: snapshot } = sample().projects[0];
  const html = renderGithubWork(snapshot, everyone, TODAY, { nextActions: { 3: 'ai' }, nextFilter: 'spec' });
  assert.equal([...html.matchAll(/data-github-task="/g)].length, 15);
  assert.match(html, /data-next-action-filter="" aria-pressed="true"/);
});

test('区分は要対応・緊急などのまとまりの判定を変えない', () => {
  const { githubSnapshot: snapshot } = sample().projects[0];
  const before = githubMyWork(snapshot, everyone, TODAY, { urgentFirst: true }).sections.map(s => [s.id, s.tasks.map(t => t.task.number)]);
  const html = renderGithubWork(snapshot, everyone, TODAY, { nextActions: { 6: 'later', 12: 'later' }, nextFilter: 'later' });
  assert.match(html, /要対応 <span class="my-work-count">2件/);
  assert.deepEqual(githubMyWork(snapshot, everyone, TODAY, { urgentFirst: true }).sections.map(s => [s.id, s.tasks.map(t => t.task.number)]), before);
});
