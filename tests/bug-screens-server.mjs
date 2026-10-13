// バグ報告ツールの画面を撮るための、架空のデータと模擬のGitHubを持つサーバー。
// 実際の報告、個人の声、実在のrepositoryは使わない。架空の予約管理アプリの報告13件と、タグ7つだけを使う。
// 使い方: node tests/bug-screens-server.mjs <保存先> <ポート> [<コードのフォルダー>]
//   保存先が空なら、報告とタグの役割を作る。既にあれば、そのまま使う。
//   コードのフォルダーを渡すと、そのフォルダーのserver.mjsで起動する。変更前のmainと変更後のブランチで、同じデータを撮るために使う。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const [dataDir, portText, codeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')] = process.argv.slice(2);
if (!dataDir || !Number(portText)) { console.error('使い方: node tests/bug-screens-server.mjs <保存先> <ポート> [<コードのフォルダー>]'); process.exit(2); }
const port = Number(portText);
const load = file => import(pathToFileURL(path.join(codeDir, file)).href);
const { BugStore } = await load('server/bug-store.mjs');
const { createProgressServer } = await load('server.mjs');
const { GitHubFailure } = await load('server/bug-github-client.mjs');

const tags = {
  予約: { id: 1, name: '予約', color: '3a6ea5' }, 一覧: { id: 2, name: '一覧', color: '7a5195' }, 通知: { id: 3, name: '通知', color: 'bc5090' },
  決済: { id: 4, name: '決済', color: 'ef5675' }, 画面: { id: 5, name: '画面', color: 'ffa600' }, bug: { id: 6, name: 'bug', color: 'd73a4a' }, enhancement: { id: 7, name: 'enhancement', color: 'a2eeef' },
};
// タグの役割。メインは予約・通知・決済、サブは一覧・画面。bugとenhancementは使わない。
const roles = [['予約', 'main'], ['通知', 'main'], ['決済', 'main'], ['一覧', 'sub'], ['画面', 'sub'], ['bug', 'none'], ['enhancement', 'none']];
// 古い順。GitHub接続の前に保存した報告は、GitHub未登録のまま残る。
const early = [['予約の確認メールの日付が1日ずれる', 'received']];
const registered = [
  ['予約一覧が更新されない', 'working', ['予約', '一覧']],
  ['日付を選ぶと一覧が空になる', 'received', ['予約', '一覧']],
  ['キャンセルしても予約枠が戻らない', 'fixed', ['予約']],
  ['検索結果の並び順が毎回変わる', 'received', ['予約', '一覧']],
  ['スマートフォンの表示で「予約する」ボタンが画面外に出る', 'received', ['予約', '画面']],
  ['通知メールが届かない', 'complete', ['通知']],
  ['通知メールの件名が空になる', 'received', ['通知', '画面']],
  ['支払い方法を変更すると合計金額が0円になる', 'working', ['決済']],
  ['領収書の金額が税込と税抜で食い違う', 'received', ['決済', 'bug']],
  ['会員登録の確認画面で電話番号が消える', 'complete', ['画面']],
  ['管理画面でCSVを出力すると文字化けする', 'received', ['bug']],
  ['「ヘルプ」リンクが404になる', 'received', []],
];
const bodyOf = title => title + '\n架空の予約管理アプリでの再現手順を記入する。';

if (!fs.existsSync(path.join(dataDir, 'reports.sqlite'))) {
  const store = new BugStore(dataDir, { initialize: true });
  const actor = store.sharedActor();
  for (const [title] of early) store.createReport(actor, { body: bodyOf(title), reportedVersion: 'S-1', requestId: 'seed-' + randomUUID(), uploadIds: [] });
  store.close();
}

const repository = 'qa-fixture/booking-reports';
const issues = [];
const github = {
  repository,
  async createIssue(title, body) {
    const number = 101 + issues.length;
    const issue = { number, title, body, html_url: 'https://github.com/' + repository + '/issues/' + number, labels: (github.nextLabels || []).map(name => tags[name]) };
    issues.push(issue); return issue;
  },
  async getIssue(number) { return issues.find(issue => issue.number === number); },
  async findIssues(marker) { return issues.filter(issue => issue.body.startsWith(marker + '\n')); },
  async listIssues() { return new Map(issues.map(issue => [issue.number, issue])); },
};
// 再起動しても、登録済みのIssueが一覧に載るようにする。
registered.forEach(([, , labels], index) => issues.push({ number: 101 + index, html_url: 'https://github.com/' + repository + '/issues/' + (101 + index), body: '', labels: labels.map(name => tags[name]) }));
const reloaded = issues.splice(0);
const server = createProgressServer({ repositories: [], dataDir, githubRepository: repository, githubClient: github });
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
console.log('http://127.0.0.1:' + port + '/bugs/');

const base = 'http://127.0.0.1:' + port + '/api/bugs';
const call = async (method, p, body) => (await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })).json();
const existing = (await call('GET', '/reports')).reports;
const expected = early.length + registered.length;
if (existing.length > early.length && existing.length < expected) {
  console.error('保存先が途中までしか作られていません（' + existing.length + '/' + expected + '件）。保存先を消して、作り直してください。');
  server.close(); process.exit(1);
}
if (existing.length >= expected) {
  issues.push(...reloaded); // 作成済みのIssueを模擬のGitHubに戻す。
} else {
  const order = ['received', 'working', 'fixed', 'checking', 'complete'];
  for (const [title, status, labels] of registered) {
    github.nextLabels = labels;
    const { report } = await call('POST', '/reports', { body: bodyOf(title), reportedVersion: 'S-1', requestId: 'seed-' + randomUUID(), uploadIds: [] });
    // 登録とタグの取得を待ってから、対応状況を進める。
    for (let i = 0; i < 50; i++) { const d = (await call('GET', '/reports/' + report.id)).report; if (d.github.state === 'registered' && d.github.tags.state === 'ok') break; await new Promise(r => setTimeout(r, 200)); }
    let d = (await call('GET', '/reports/' + report.id)).report;
    while (order.indexOf(d.status) < order.indexOf(status)) {
      if (d.status === 'checking') await call('POST', '/reports/' + report.id + '/confirmations', { revision: d.revision, requestId: 'c-' + randomUUID(), version: 'S-2', result: 'resolved', note: '' });
      else await call('POST', '/reports/' + report.id + '/status', { revision: d.revision, requestId: 's-' + randomUUID(), targetVersion: d.status === 'fixed' ? 'S-2' : '', developerNote: '' });
      d = (await call('GET', '/reports/' + report.id)).report;
    }
  }
  await call('POST', '/tag-roles', { roles: roles.map(([name, role]) => ({ id: tags[name].id, role })) });
  console.log('seeded', (await call('GET', '/reports')).reports.length);
}
