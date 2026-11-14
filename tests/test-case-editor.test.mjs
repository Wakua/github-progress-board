import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaseEditor, validateCase, UnsavedCaseError, CASE_FIELDS } from '../dist/testing/case-editor.mjs';
import { memoryCaseRepository, fixtureCases } from './support/test-case-fixture.mjs';

async function setup(repository = memoryCaseRepository()) {
  let sequence = 0;
  const editor = createCaseEditor(repository,{requestId:()=>`request-${++sequence}`});
  await editor.load(); editor.select('TC-101'); return {editor,repository};
}
test('開閉しても編集対象・全入力・フィルター・一覧位置を保持する',async()=>{
  const {editor}=await setup();
  editor.filter({category:'予約',status:'Active'}); editor.edit('expected','未保存の期待結果'); editor.setScroll(197);
  const before=editor.snapshot(); editor.setSidebar(false); editor.setSidebar(true);
  assert.deepEqual(editor.snapshot(),before); assert.equal(editor.snapshot().dirty,true);
});
test('別ケースと取消しは未保存保護、同じケースは入力を破棄しない',async()=>{
  const {editor}=await setup(); editor.edit('steps','未保存');
  assert.throws(()=>editor.select('TC-102'),UnsavedCaseError); assert.throws(()=>editor.cancel(),UnsavedCaseError);
  const before=editor.snapshot(), events=[]; editor.subscribe(kind=>events.push(kind));
  assert.equal(editor.select('TC-101'),true); assert.equal(editor.snapshot().draft.steps,'未保存');
  assert.deepEqual(editor.snapshot(),before); assert.deepEqual(events,['focus']);
  editor.select('TC-102',{discard:true}); assert.equal(editor.snapshot().dirty,false);
});
test('必須項目が空白だけなら保存先を呼ばず該当項目を示す',async()=>{
  const {editor,repository}=await setup();
  for(const key of ['title','steps','expected']) editor.edit(key,' \n');
  assert.equal(await editor.save(),false); assert.deepEqual(Object.keys(editor.snapshot().errors),['title','steps','expected']);
  assert.equal(repository.requests.length,0);
  assert.ok(validateCase({...fixtureCases[0],id:''}).id); assert.ok(validateCase({...fixtureCases[0],status:'Unknown'}).status);
});
test('新規ケースは全項目を保存し、DraftからActiveとDeprecatedへ変更しても残る',async()=>{
  const {editor,repository}=await setup(); await editor.create(); const id=editor.snapshot().selected;
  for(const key of CASE_FIELDS.filter(key=>!['id','status'].includes(key))) editor.edit(key,`値-${key}`);
  editor.edit('category','予約'); assert.equal(await editor.save(),true);
  assert.equal(editor.snapshot().draft.status,'Draft');
  for(const status of ['Active','Deprecated']) {editor.edit('status',status); assert.equal(await editor.save(),true);}
  assert.ok(!(editor.visibleCases().some(record=>record.id===id)));
  editor.filter({status:'Deprecated'}); assert.ok(editor.visibleCases().some(record=>record.id===id));
  const record=(await repository.load()).cases.find(record=>record.id===id); assert.equal(record.notes,'値-notes');
});
test('カテゴリと状態の絞込みは同じ集合から件数を数える',async()=>{
  const {editor}=await setup(); assert.equal(editor.visibleCases().length,5);
  editor.filter({category:'予約'}); assert.equal(editor.visibleCases().length,3);
  editor.filter({status:'Deprecated'}); assert.equal(editor.visibleCases().length,0);
  editor.filter({category:''}); assert.equal(editor.visibleCases().length,1);
});
test('保存失敗と応答消失の再試行は入力を保持し、同じ受付キーを使う',async()=>{
  for(const scenario of ['failure','lost-response']) {
    const {editor,repository}=await setup(); editor.edit('expected','変更後'); repository.setScenario(scenario);
    assert.equal(await editor.save(),false); assert.equal(editor.snapshot().draft.expected,'変更後'); assert.equal(editor.snapshot().dirty,true);
    assert.equal(await editor.save(),true); assert.equal(repository.requests[0].requestId,repository.requests[1].requestId);
    assert.equal((await repository.load()).cases[0].revision,2); assert.equal(editor.snapshot().dirty,false);
  }
});
test('再試行前に入力を変えたら新しい受付キーにする',async()=>{
  const {editor,repository}=await setup(); editor.edit('expected','一回目'); repository.setScenario('failure'); await editor.save();
  editor.edit('expected','二回目'); await editor.save(); assert.notEqual(repository.requests[0].requestId,repository.requests[1].requestId);
});
test('競合を受けた入力は保持し、古い更新番号で最新の内容を上書きしない',async()=>{
  const {editor,repository}=await setup(); editor.edit('expected','自分の入力'); repository.setScenario('conflict');
  assert.equal(await editor.save(),false); assert.equal(editor.snapshot().draft.expected,'自分の入力');
  assert.equal(editor.snapshot().conflict.expected,'別の担当者が保存した架空の期待結果。');
  assert.equal(await editor.save(),false); assert.equal((await repository.load()).cases[0].revision,2);
});
test('保存中は二重保存と編集対象の切替を防ぎ、開閉は許可する',async()=>{
  let finish;
  const repository=memoryCaseRepository(), save=repository.save;
  repository.save=request=>new Promise(resolve=>{finish=()=>save(request).then(resolve);});
  const {editor}=await setup(repository); editor.edit('expected','保存する内容'); const saving=editor.save();
  assert.equal(await editor.save(),false); assert.equal(editor.select('TC-102'),false); assert.equal(await editor.create(),false);
  editor.edit('expected','保存中の別内容'); editor.setSidebar(false);
  assert.equal(editor.snapshot().draft.expected,'保存する内容'); assert.equal(editor.snapshot().sidebar,false);
  await finish(); await saving; assert.equal(editor.snapshot().selected,'TC-101'); assert.equal(editor.snapshot().dirty,false);
});
test('不正な保存応答を成功と表示せず入力を保持する',async()=>{
  const repository=memoryCaseRepository(); repository.save=async()=>({id:'違うID'});
  const {editor}=await setup(repository); editor.edit('title','入力');
  assert.equal(await editor.save(),false); assert.equal(editor.snapshot().draft.title,'入力'); assert.equal(editor.snapshot().dirty,true);
});
test('読込み失敗から再取得できる',async()=>{
  const repository=memoryCaseRepository(), load=repository.load; let failed=false;
  repository.load=async()=>{if(!failed){failed=true;throw new Error('読み込み失敗');}return load();};
  const editor=createCaseEditor(repository); await editor.load(); assert.equal(editor.snapshot().phase,'load-error');
  await editor.load(); assert.equal(editor.snapshot().phase,'ready'); assert.equal(editor.visibleCases().length,5);
});
test('UIは受取ったケースや結果参照を直接書き換えず、ケース値だけを保存先へ渡す',async()=>{
  const input=structuredClone(fixtureCases), result={title:input[0].title,steps:input[0].steps,expected:input[0].expected};
  input[0].pastResult=result; const before=structuredClone(input); let submitted;
  const repository={load:async()=>({cases:input,categories:['予約']}),save:async request=>{submitted=request;return {...request.values,revision:2};}};
  const {editor}=await setup(repository); editor.edit('steps','新しい手順'); await editor.save();
  assert.deepEqual(input,before); assert.deepEqual(result,before[0].pastResult);
  assert.equal('pastResult' in submitted.values,false);
  const external=editor.snapshot(); external.cases[0].title='外から変更'; assert.notEqual(editor.snapshot().cases[0].title,'外から変更');
});
