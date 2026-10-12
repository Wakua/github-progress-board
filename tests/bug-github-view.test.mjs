import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesFilters,roleMap,categoriesOf,areaText,mainChoices,subChoices,uncategorized,registrationName,registrationMark,registrationTarget,nextAction} from '../dist/bugs/view.mjs';
const report=(state,labels=[],registration='registered')=>({github:{state:registration,repository:'Wakua/github-progress-board',tags:{state,labels}}});
const bug={id:1,name:'bug',color:'cc0000'},otherTag={id:2,name:'別の報告者のタグ',color:'ffffff'};
const tags=[{id:1,name:'bug',color:'cc0000',role:'none'},{id:2,name:'予約',color:'3a6ea5',role:'main'},{id:3,name:'一覧',color:'7a5195',role:'sub'},{id:4,name:'決済',color:'ef5675',role:'main'},{id:5,name:'画面',color:'ffa600',role:'sub'},{id:6,name:'新しいタグ',color:'888888',role:null}];
const label=id=>tags.find(tag=>tag.id===id);
const withTags=(id,status,ids,registration='registered',state='ok')=>({id,status,github:{state:registration,repository:'Wakua/github-progress-board',tags:{state,labels:ids.map(label)}}});
const roles=roleMap(tags);
const texts=choices=>choices.map(choice=>choice.text);
test('割り当てたメインとサブだけをカテゴリに数え、使わないタグと未設定のタグは数えない',()=>{
  assert.deepEqual([...roles],[[2,{role:'main',name:'予約'}],[3,{role:'sub',name:'一覧'}],[4,{role:'main',name:'決済'}],[5,{role:'sub',name:'画面'}]]);
  assert.deepEqual(categoriesOf(withTags('r','received',[1,2,3,6]),roles),{main:[label(2)],sub:[label(3)]});
});
test('行の領域は、メインを「・」で並べ、サブを「 / 」の後ろに並べる',()=>{
  assert.equal(areaText(withTags('r','received',[2,4,3,5]),roles),'予約・決済 / 一覧・画面');
  assert.equal(areaText(withTags('r','received',[2]),roles),'予約');
  assert.equal(areaText(withTags('r','received',[3]),roles),'一覧');
  assert.equal(areaText(withTags('r','received',[1,6]),roles),'');
  assert.equal(areaText(withTags('r','received',[],'pending','unfetched'),roles),'');
});
test('メインとサブは別々の軸で、重ねて絞り込め、サブはメインを選ばなくても探せる',()=>{
  const value=withTags('r','working',[2,3]);
  assert.equal(matchesFilters(value,{main:'label:2',roles}),true);
  assert.equal(matchesFilters(value,{main:'label:4',roles}),false);
  assert.equal(matchesFilters(value,{sub:'label:3',roles}),true);
  assert.equal(matchesFilters(value,{sub:'label:5',roles}),false);
  assert.equal(matchesFilters(value,{main:'label:2',sub:'label:3',roles}),true);
  assert.equal(matchesFilters(value,{main:'label:4',sub:'label:3',roles}),false);
  assert.equal(matchesFilters(withTags('r','working',[3]),{main:'label:2',roles}),false);
  assert.equal(matchesFilters(withTags('r','working',[3]),{sub:'label:3',roles}),true);
});
test('未分類は、割り当てたタグを持たない報告と、タグを取得できていない報告を含み、サブだけを持つ報告は含まない',()=>{
  const inUncategorized=value=>matchesFilters(value,{main:uncategorized,roles});
  assert.equal(inUncategorized(withTags('r','received',[])),true);
  assert.equal(inUncategorized(withTags('r','received',[1])),true);
  assert.equal(inUncategorized(withTags('r','received',[6])),true);
  assert.equal(inUncategorized(withTags('r','received',[],'pending','unfetched')),true);
  assert.equal(inUncategorized(withTags('r','received',[2])),false);
  assert.equal(inUncategorized(withTags('r','received',[3])),false);
  assert.equal(inUncategorized(withTags('r','received',[1,3])),false);
});
test('領域の名前は、報告に残った古い名前ではなく、tag-rolesの最新の名前を使う',()=>{
  const renamed=withTags('r','received',[2]);renamed.github.tags.labels=[{...label(2),name:'旧名'}];
  assert.equal(areaText(renamed,roles),'予約');
  assert.equal(categoriesOf(renamed,roles).main[0].name,'予約');
});
test('タグの取得に失敗しても、前回のタグでカテゴリを判定する',()=>{
  const value=withTags('r','received',[2],'registered','error');
  assert.equal(matchesFilters(value,{main:'label:2',roles}),true);
  assert.equal(areaText(value,roles),'予約');
});
test('メインの選択肢は、割り当てたメインと未分類に、未対応（受付済みと対応中）の件数を添え、未対応がなくても件数0で出す',()=>{
  const reports=[withTags('a','received',[2,3]),withTags('b','working',[2]),withTags('c','fixed',[2]),withTags('d','complete',[2]),withTags('e','received',[1]),withTags('f','received',[],'pending','unfetched'),withTags('g','checking',[3]),withTags('h','complete',[4])];
  const choices=mainChoices(reports,tags);
  assert.equal(choices[0].value,'all');assert.equal(choices[0].text,'すべて');
  assert.deepEqual(texts(choices.slice(1)).sort(),['予約（2）','決済（0）','未分類（2）'].sort());
  assert.equal(choices.find(choice=>choice.value===uncategorized).text,'未分類（2）');
  assert.deepEqual(mainChoices([],[]),[{value:'all',text:'すべて'},{value:uncategorized,text:'未分類（0）'}]);
});
test('サブの選択肢は、選んだメインの報告に付いているサブだけを出し、未対応の件数を添える',()=>{
  const reports=[withTags('a','received',[2,3]),withTags('b','working',[2,3]),withTags('c','received',[4,5]),withTags('d','complete',[4,3])];
  const choose=main=>subChoices(reports,tags,main);
  assert.equal(choose('all')[0].text,'すべて');
  assert.deepEqual(texts(choose('all').slice(1)).sort(),['一覧（2）','画面（1）'].sort());
  assert.deepEqual(choose('label:2'),[{value:'all',text:'すべて'},{value:'label:3',text:'一覧（2）'}]);
  assert.deepEqual(texts(choose('label:4').slice(1)).sort(),['一覧（0）','画面（1）'].sort());
  assert.deepEqual(choose(uncategorized),[{value:'all',text:'すべて'}]);
  assert.deepEqual(subChoices([],[],'all'),[{value:'all',text:'すべて'}]);
});
test('登録状況の絞り込みは、メインの絞り込みと重ねられる',()=>{
  assert.equal(matchesFilters(withTags('r','received',[2],'failed'),{main:'label:2',state:'failed',roles}),true);
  assert.equal(matchesFilters(withTags('r','received',[2],'failed'),{main:'label:2',state:'registered',roles}),false);
});
test('reports saved before connection are distinguishable from the automatic registration queue',()=>{
  assert.equal(registrationName({github:{state:'pending',repository:null}}),'GitHub未登録');
  assert.equal(registrationName(report('unfetched',[],'pending')),'GitHub登録待ち');
});

test('一覧の行は、GitHubの接続があり、登録が完了していない報告だけ印を出す',()=>{
  assert.equal(registrationMark(report('ok',[],'registered'),true),null);
  assert.equal(registrationMark(report('unfetched',[],'pending'),true),'GitHub登録待ち');
  assert.equal(registrationMark(report('unfetched',[],'creating'),true),'GitHub登録中');
  assert.equal(registrationMark(report('ok',[],'failed'),true),'GitHub登録失敗');
  assert.equal(registrationMark(report('ok',[],'unknown'),true),'GitHub作成結果が未確認');
  assert.equal(registrationMark({github:{state:'pending',repository:null}},true),'GitHub未登録');
  assert.equal(registrationMark({github:{state:'pending',repository:null}},false),null);
  assert.equal(registrationMark(report('ok',[],'failed'),false),null);
});

test('本文の検索に一致した報告のIDで絞り、ほかの絞り込みと重ねられる',()=>{
  const value=withTags('r1','working',[2]);
  assert.equal(matchesFilters(value,{found:null}),true);
  assert.equal(matchesFilters(value,{found:new Set(['r1'])}),true);
  assert.equal(matchesFilters(value,{found:new Set(['r2'])}),false);
  assert.equal(matchesFilters(value,{found:new Set()}),false);
  assert.equal(matchesFilters(value,{main:'label:2',state:'registered',status:'working',found:new Set(['r1']),roles}),true);
  assert.equal(matchesFilters(value,{main:'label:2',state:'registered',status:'complete',found:new Set(['r1']),roles}),false);
});

test('対応状況の絞り込みは、メインと登録状況の絞り込みと重ねられる',()=>{
  const value=withTags('r','checking',[2]);
  assert.equal(matchesFilters(value,{main:'label:2',state:'registered',status:'checking',roles}),true);
  assert.equal(matchesFilters(value,{main:'label:2',state:'registered',status:'complete',roles}),false);
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
