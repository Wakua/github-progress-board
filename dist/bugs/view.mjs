export const statusNames={received:'受付済み',working:'対応中',fixed:'修正済み・公開待ち',checking:'テスター確認待ち',complete:'確認完了'};
export const nextStatusNames={received:'対応を始める',working:'修正済み・公開待ちにする',fixed:'公開してテスターへ確認を依頼する'};
export function nextAction(report,role) {
  return {received:'報告は保存済みです。開発側の対応をお待ちください。',working:'開発側が調査・修正しています。再確認の依頼をお待ちください。',fixed:'修正は完了し、公開を待っています。再確認の依頼をお待ちください。',checking:report.isOwn===false?'報告したテスターの確認結果を待っています。':'報告した操作を修正版で試し、結果を送ってください。',complete:report.isOwn===false?'報告したテスターが対象バージョンで解消を確認しました。':'対象バージョンでの解消を確認しました。'}[report.status];
}
export const registrationNames={pending:'GitHub登録待ち',creating:'GitHub登録中',registered:'GitHub登録済み',failed:'GitHub登録失敗',unknown:'GitHub作成結果が未確認'};
export function registrationName(report) {
  return report.github.state==='pending'&&!report.github.repository?'GitHub未登録':registrationNames[report.github.state]||'GitHub登録状況が不明';
}
// 一覧の行には、GitHub登録が完了していない報告だけ印を出す。GitHubの接続がなければ登録は始まらないので、出さない。
export function registrationMark(report,githubEnabled) {
  return githubEnabled&&report.github.state!=='registered'?registrationName(report):null;
}
// A failed report registers to the configured repository on retry, so show that one before the operation.
export function registrationTarget(github,configured) {
  if(github.state==='failed'&&configured&&github.repository&&github.repository!==configured)return '登録先：'+configured+'（失敗した登録先：'+github.repository+'）';
  return '登録先：'+(github.repository||configured||'未設定');
}
// カテゴリの絞り込み。割り当てた役割（メイン・サブ）は、GitHubのタグのidに付ける。使わないタグと、未設定のタグは、カテゴリに数えない。
export const uncategorized='uncategorized';
// タグのid → 役割と名前。名前は選択肢と同じ、最後に取得した名前を使う。
export function roleMap(tags) {
  return new Map(tags.filter(tag=>tag.role==='main'||tag.role==='sub').map(tag=>[tag.id,{role:tag.role,name:tag.name}]));
}
// 報告のカテゴリを、役割ごとに分ける。登録前の報告は、保留したカテゴリ（タグのid）を使い、登録後は、GitHubのタグを使う。
// タグの取得に失敗して前回の結果を保持している報告も、その結果で分ける。
export function categoriesOf(report,roles) {
  const found={main:[],sub:[]};
  const labels=report.github.state==='registered'?report.github.tags.labels:(report.categories??[]).map(id=>({id}));
  for(const label of labels) {const assigned=roles.get(label.id);if(assigned)found[assigned.role].push({...label,name:assigned.name});}
  return found;
}
// 登録前のカテゴリを変えられるのは、Issueを作る要求を送る前の、登録待ちと登録失敗だけ。
export const categoriesEditable=report=>report.github.state==='pending'||report.github.state==='failed';
// 行に添える領域。メインを「・」で並べ、サブを「 / 」の後ろに並べる。例：「予約・通知 / 一覧」
export function areaText(report,roles) {
  const {main,sub}=categoriesOf(report,roles);
  return [main,sub].filter(group=>group.length).map(group=>group.map(label=>label.name).join('・')).join(' / ');
}
// 報告の種別。ツールの中だけで持ち、更新前の報告（kindを持たない）は不具合として扱う。
export const kindNames={bug:'不具合',request:'要望',question:'確認'};
export const kindOf=report=>report.kind??'bug';
// 未対応は、受付済みと対応中。
export const isUnaddressed=report=>report.status==='received'||report.status==='working';
function inMain(report,main,roles) {
  if(main==='all')return true;
  const found=categoriesOf(report,roles);
  return main===uncategorized?!found.main.length&&!found.sub.length:found.main.some(label=>'label:'+label.id===main);
}
const byName=(a,b)=>a.name.localeCompare(b.name,'ja');
// 報告に選べるカテゴリ。メインかサブを割り当てたタグを、役割ごとに名前順で返す。
export function selectableCategories(tags) {
  const pick=role=>tags.filter(tag=>tag.role===role).sort(byName).map(tag=>({id:tag.id,name:tag.name}));
  return {main:pick('main'),sub:pick('sub')};
}
const countUnaddressed=reports=>reports.filter(isUnaddressed).length;
// 種別の絞り込みを選んだときだけ、選択肢の件数も、その種別で数える。
const inKind=(reports,kind)=>kind==='all'?reports:reports.filter(report=>kindOf(report)===kind);
// メインの選択肢。割り当てたメインのタグと「未分類」に、未対応の件数を添える。報告のないメインも、件数0で出す。
export function mainChoices(reports,tags,kind='all') {
  const roles=roleMap(tags),scope=inKind(reports,kind);
  return [{value:'all',text:'すべて'},
    ...tags.filter(tag=>tag.role==='main').sort(byName).map(tag=>({value:'label:'+tag.id,text:tag.name+'（'+countUnaddressed(scope.filter(report=>inMain(report,'label:'+tag.id,roles)))+'）'})),
    {value:uncategorized,text:'未分類（'+countUnaddressed(scope.filter(report=>inMain(report,uncategorized,roles)))+'）'}];
}
// サブの選択肢。選んだメインの報告に付いているサブだけを出し、未対応の件数を添える。
export function subChoices(reports,tags,main,kind='all') {
  const roles=roleMap(tags),scope=inKind(reports,kind).filter(report=>inMain(report,main,roles));
  return [{value:'all',text:'すべて'},
    ...tags.filter(tag=>tag.role==='sub').sort(byName).map(tag=>({tag,reports:scope.filter(report=>categoriesOf(report,roles).sub.some(label=>label.id===tag.id))}))
      .filter(entry=>entry.reports.length).map(entry=>({value:'label:'+entry.tag.id,text:entry.tag.name+'（'+countUnaddressed(entry.reports)+'）'}))];
}
// found: 本文の検索に一致した報告のIDの集合。検索していないときはnull。roles: roleMapの結果。
// status: 'all'、対応状況の値、または 'incomplete'（確認完了を除く）。
export function matchesFilters(report,{main='all',sub='all',state='all',status='all',kind='all',found=null,roles=new Map()}={}) {
  if(found&&!found.has(report.id))return false;
  if(kind!=='all'&&kindOf(report)!==kind)return false;
  if(status==='incomplete'){if(report.status==='complete')return false;}
  else if(status!=='all'&&report.status!==status)return false;
  if(state!=='all'&&report.github.state!==state)return false;
  if(!inMain(report,main,roles))return false;
  return sub==='all'||categoriesOf(report,roles).sub.some(label=>'label:'+label.id===sub);
}
export function contrastColor(color) {
  const channels=[0,2,4].map(index=>parseInt(color.slice(index,index+2),16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
  return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722>.179?'#202941':'#ffffff';
}
// かんばんの列。対応状況の流れの順に並べ、報告がない列も残す。
export function boardColumns(reports) {
  return Object.entries(statusNames).map(([status,name])=>({status,name,reports:reports.filter(report=>report.status===status)}));
}
