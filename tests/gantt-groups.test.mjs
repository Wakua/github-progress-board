import assert from 'node:assert/strict';
import test from 'node:test';
import { groupGanttTasks } from '../dist/gantt-groups.mjs';

test('親を未取得でも確認済みの子リンクを使い、曖昧な子と親なし作業は独立して表示する', () => {
  const issue = (key, children, parent, problem = null) => ({ key, parent:{value:parent,problem}, children:{keys:children} });
  const issues = [
    issue('parent',['child','ambiguous'],null), issue('other',['ambiguous'],null),
    issue('child',[],null,'not-fetched'), issue('ambiguous',[],null,'not-fetched'), issue('alone',[],null),
  ];
  const tasks = ['child','ambiguous','alone'].map(key => ({key}));
  const groups = groupGanttTasks(tasks, issues);
  assert.deepEqual(groups.map(entry => entry.key), ['parent','ambiguous','alone']);
  assert.deepEqual(groups[0].children.map(entry => entry.task), [tasks[0]]);
});
