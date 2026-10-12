export const statusNames={received:'受付済み',working:'対応中',fixed:'修正済み・公開待ち',checking:'テスター確認待ち',complete:'確認完了'};
export const nextStatusNames={received:'対応を始める',working:'修正済み・公開待ちにする',fixed:'公開してテスターへ確認を依頼する'};
export function nextAction(report,role) {
  if(role==='shared')return {received:'調査・修正を開始してください。',working:'修正を終えたら、公開待ちへ進めてください。',fixed:'修正版を公開し、確認対象のバージョンを指定してください。',checking:'報告した操作を修正版で試し、結果を送ってください。',complete:'対象バージョンでの解消を確認しました。'}[report.status];
  if(role==='admin')return {received:'調査・修正を開始してください。',working:'修正を終えたら、公開待ちへ進めてください。',fixed:'修正版を公開し、確認対象のバージョンを指定してください。',checking:'報告したテスターの確認結果を待っています。',complete:'テスターが対象バージョンで解消を確認しました。'}[report.status];
  return {received:'報告は保存済みです。開発側の対応をお待ちください。',working:'開発側が調査・修正しています。再確認の依頼をお待ちください。',fixed:'修正は完了し、公開を待っています。再確認の依頼をお待ちください。',checking:report.isOwn===false?'報告したテスターの確認結果を待っています。':'報告した操作を修正版で試し、結果を送ってください。',complete:report.isOwn===false?'報告したテスターが対象バージョンで解消を確認しました。':'対象バージョンでの解消を確認しました。'}[report.status];
}
export const registrationNames={pending:'GitHub登録待ち',creating:'GitHub登録中',registered:'GitHub登録済み',failed:'GitHub登録失敗',unknown:'GitHub作成結果が未確認'};
export function registrationName(report) {
  return report.github.state==='pending'&&!report.github.repository?'GitHub未登録':registrationNames[report.github.state]||'GitHub登録状況が不明';
}
// A failed report registers to the configured repository on retry, so show that one before the operation.
export function registrationTarget(github,configured) {
  if(github.state==='failed'&&configured&&github.repository&&github.repository!==configured)return '登録先：'+configured+'（失敗した登録先：'+github.repository+'）';
  return '登録先：'+(github.repository||configured||'未設定');
}
export function tagOptions(reports) {
  const labels=new Map();
  for(const report of reports) for(const label of report.github.tags.labels) labels.set(label.id,label);
  return [...labels.values()].sort((a,b)=>a.name.localeCompare(b.name,'ja'));
}
export function matchesFilters(report,tag='all',state='all',status='all') {
  if(status!=='all'&&report.status!==status)return false;
  if(state!=='all'&&report.github.state!==state)return false;
  const tags=report.github.tags;
  if(tag==='all')return true;
  if(tag==='none')return tags.state==='ok'&&tags.labels.length===0;
  if(tag==='unfetched'||tag==='error')return tags.state===tag;
  return tags.labels.some(label=>'label:'+label.id===tag);
}
export function contrastColor(color) {
  const channels=[0,2,4].map(index=>parseInt(color.slice(index,index+2),16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
  return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722>.179?'#202941':'#ffffff';
}
