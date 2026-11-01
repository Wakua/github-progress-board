import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseTaskCounts, goalTaskCounts } from '../dist/release-task-counts.mjs';

const task = (number, state, fields = {}, status = 'In Progress') => ({
  number, item:{state, ...fields}, projects:[{status}]
});

test('リリース内の作業を完了・取り下げ・受入待ち・未完了へ重複なく分ける', () => {
  const result = releaseTaskCounts([
    task(1,'closed',{notPlanned:false,acceptancePending:true}),
    task(2,'closed',{notPlanned:true}),
    task(3,'open',{acceptancePending:true}),
    task(4,'open',{acceptancePending:false}),
    task(5,'open',{acceptancePending:false},'Done'),
  ]);
  assert.deepEqual(Object.fromEntries(['done','cancelled','ended','pending','open'].map(key=>[key,result[key].map(t=>t.number)])),
    {done:[1,5],cancelled:[2],ended:[],pending:[3],open:[4]});
  assert.equal(result.pendingUnfetched,false);
  assert.equal(result.allPending,false);
});

test('古い記録と未取得は受入待ち0件・実装完了として推測しない', () => {
  const old=releaseTaskCounts([task(1,'closed'),task(2,'open')]);
  assert.equal(old.ended.length,1);
  assert.equal(old.done.length,0);
  assert.equal(old.pending.length,0);
  assert.equal(old.pendingUnfetched,true);
  assert.equal(old.allPending,false);
});

test('残りがすべて明示的な受入待ちの場合だけ日程の詳細を折りたたむ', () => {
  const done=task(1,'closed',{notPlanned:false});
  const pending=task(2,'open',{acceptancePending:true});
  assert.equal(releaseTaskCounts([done,pending]).allPending,true);
  assert.equal(releaseTaskCounts([done]).allPending,false);
  assert.equal(releaseTaskCounts([]).allPending,false);
  assert.equal(releaseTaskCounts([done,pending,task(3,'open')]).allPending,false);
});

test('親の内訳は中間親を重複させず、一覧と同じ完了・取り下げ・終了を数える', () => {
  const tasks = new Map([
    ['a',task(1,'closed',{notPlanned:false})],
    ['b',task(2,'closed',{notPlanned:true})],
    ['c',task(3,'closed')],
    ['d',task(4,'open',{acceptancePending:true})],
    ['other-release',task(5,'closed',{notPlanned:false})],
  ]);
  const group = {children:[{children:[{task:{key:'a'}},{task:{key:'b'}}]},{task:{key:'c'}},{task:{key:'d'}}]};
  const counts = goalTaskCounts(group,tasks);
  assert.deepEqual(['done','cancelled','ended','pending','open'].map(key=>counts[key].length),[1,1,1,1,0]);
  assert.equal(goalTaskCounts({task:{key:'unfetched'}},tasks),null);
});
