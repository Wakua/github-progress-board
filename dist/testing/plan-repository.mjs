const messages={
 invalid_plan:'入力内容を確認してください。入力は残っています。',
 plan_conflict:'別の変更が保存されています。入力を残したまま最新内容と比較してください。',
 plan_deleted:'この計画は削除されています。入力を控えてから再取得してください。',
 recorded_target:'結果を記録したケース・実施条件は外したり差し替えたりできません。',
 case_not_active:'追加するケースの状態が変わっています。最新の一覧を取得してください。',
 case_missing:'追加するケースが見つかりません。最新の一覧を取得してください。',
 plan_delete_forbidden:'削除できるのは結果のないDraft計画だけです。',
 plan_closed:'計画を再開してから、ケースや実施条件を変更してください。',
 not_run_remaining:'未実施の結果が残っているため、計画を完了できません。',
 completion_warning:'不合格・保留・スキップ・再テスト待ちを確認してから完了してください。',
 invalid_transition:'この状態へは変更できません。最新の計画を確認してください。',
 request_reused:'保存要求が一致しません。入力を控えてから再取得してください。',
 store_unavailable:'保存先を利用できません。入力は残っています。復旧後に再試行してください。',
};
export function createPlanRepository({fetchImpl=fetch}={}) {
 async function request(url,method='GET',body){
  let response,value;
  try{response=await fetchImpl(url,{method,headers:{'x-test-client':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});value=await response.json();}
  catch{throw new Error('サーバーから応答を受け取れませんでした。入力は残っています。');}
  if(!response.ok)throw Object.assign(new Error(messages[value?.error]||'操作を完了できませんでした。入力は残っています。'),{status:response.status,code:value?.error,current:value?.current});
  return value;
 }
 return {
  async load(){const [plans,cases]=await Promise.all([request('/api/testing/plans'),request('/api/testing/cases')]);return {...plans,...cases};},
  newPlan:()=>request('/api/testing/plan-ids','POST',{}),
  save:packet=>request('/api/testing/plans','PUT',packet)
 };
}
