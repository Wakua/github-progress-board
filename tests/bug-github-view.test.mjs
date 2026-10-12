import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesFilters,tagOptions,registrationName,registrationTarget,nextAction} from '../dist/bugs/view.mjs';
const report=(state,labels=[],registration='registered')=>({github:{state:registration,repository:'Wakua/github-progress-board',tags:{state,labels}}});
const bug={id:1,name:'bug',color:'cc0000'},otherTag={id:2,name:'別の報告者のタグ',color:'ffffff'};
test('shared report lists include every reporter tag and collapse repeated tags',()=>{
  const own=[report('ok',[bug]),report('error',[bug])],other=[report('ok',[otherTag])];
  assert.deepEqual(tagOptions([...own,...other]),[bug,otherTag].sort((a,b)=>a.name.localeCompare(b.name,'ja')));assert.deepEqual(tagOptions(other),[otherTag]);
});
test('none, unfetched, failed fetch and cached labels remain distinct when filters combine',()=>{
  assert.equal(matchesFilters(report('ok'),'none'),true);
  assert.equal(matchesFilters(report('unfetched'),'none'),false);
  assert.equal(matchesFilters(report('error'),'none'),false);
  assert.equal(matchesFilters(report('error',[bug]),'label:1'),true);
  assert.equal(matchesFilters(report('error',[bug]),'error'),true);
  assert.equal(matchesFilters(report('ok',[bug],'failed'),'label:1','failed'),true);
  assert.equal(matchesFilters(report('ok',[bug],'failed'),'label:1','registered'),false);
});
test('reports saved before connection are distinguishable from the automatic registration queue',()=>{
  assert.equal(registrationName({github:{state:'pending',repository:null}}),'GitHub未登録');
  assert.equal(registrationName(report('unfetched',[],'pending')),'GitHub登録待ち');
});

test('workflow status can be combined with tag and registration filters',()=>{
  const value={...report('ok',[bug]),status:'checking'};
  assert.equal(matchesFilters(value,'label:1','registered','checking'),true);
  assert.equal(matchesFilters(value,'label:1','registered','complete'),false);
});

test('other reporters see the original tester waiting instruction',()=>{
  assert.equal(nextAction({status:'checking',isOwn:false},'tester'),'報告したテスターの確認結果を待っています。');
  assert.match(nextAction({status:'checking',isOwn:true},'tester'),/結果を送って/);
  assert.match(nextAction({status:'complete',isOwn:false},'tester'),/報告したテスター/);
});


test('共通の利用者へ対応と確認の次の操作を表示する',()=>{
  assert.match(nextAction({status:'received'},'shared'),/開始/);
  assert.match(nextAction({status:'fixed'},'shared'),/確認対象/);
  assert.match(nextAction({status:'checking',isOwn:false},'shared'),/結果を送って/);
  assert.match(nextAction({status:'complete'},'shared'),/解消を確認/);
});
test('a failed report shows the repository the retry will use before the operation',()=>{
  const failed=repository=>({state:'failed',repository});
  assert.equal(registrationTarget(failed('example/typo'),'example/fixed'),'登録先：example/fixed（失敗した登録先：example/typo）');
  assert.equal(registrationTarget(failed('example/fixed'),'example/fixed'),'登録先：example/fixed');
  assert.equal(registrationTarget({state:'registered',repository:'example/old'},'example/fixed'),'登録先：example/old');
  assert.equal(registrationTarget({state:'pending',repository:null},null),'登録先：未設定');
});
