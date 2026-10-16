// バグ報告ツールの画面を撮るための、架空のデータと模擬のGitHubを持つサーバー。
// 実際の報告、個人の声、実在のrepositoryは使わない。架空の予約管理アプリの報告18件と、タグ7つだけを使う。
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
// 経過に残す、開発側の連絡と確認の内容（#80）。キーは、その連絡を送る前の対応状況。confirm は、テスターの確認結果の内容。
const notes = {
  '通知メールが届かない': { received: '再現しました。送信キューを調べています。', working: '再送の条件を直しました。', fixed: 'S-2で確認をお願いします。', confirm: 'S-2で、メールが届きました。' },
  '支払い方法を変更すると合計金額が0円になる': { received: '調べています。' }
};
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
  // 種別（#73）。4つ目が種別で、省くと不具合。種別を持たない版は、同じ報告を種別なしで作る。
  ['予約一覧に、日付での並び替えがほしい', 'received', ['予約', '一覧'], 'request'],
  ['通知メールに、予約の変更前の日時も載せてほしい', 'working', ['通知'], 'request'],
  ['領収書に、会社名を入れられるようにしてほしい', 'received', ['決済'], 'request'],
  ['キャンセル後の返金は、仕様では何日かかるのか', 'received', ['決済'], 'question'],
  ['満席の日に、予約ボタンが押せないのは仕様なのか', 'received', ['予約', '画面'], 'question'],
];
const bodyOf = title => title + '\n架空の予約管理アプリでの再現手順を記入する。';
// 登録前のカテゴリ（#68）の例。GitHub未登録の報告に、保留したカテゴリを付ける。
const pendingCategories = ['予約', '通知'];
// 作成者にpush権限がなく、要求に含めたタグが黙って落ちた報告。カテゴリを指定できない版では、同じ報告をカテゴリなしで作る。
const droppedTitle = '確認メールの送信日時が表示とずれる';

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
  // 要求のタグの名前（labelNames）があればそれを付ける。dropLabelsのときは、タグが落ちた状態を模す。
  async createIssue(title, body, labelNames = []) {
    const number = 101 + issues.length;
    const names = github.dropLabels ? [] : labelNames.length ? labelNames : github.nextLabels || [];
    const issue = { number, title, body, html_url: 'https://github.com/' + repository + '/issues/' + number, labels: names.map(name => tags[name]) };
    issues.push(issue); return issue;
  },
  async getLabel(name) {
    if (!tags[name]) throw new GitHubFailure('GitHubにそのタグはありません。', { status: 404 });
    return tags[name];
  },
  async getIssue(number) { return issues.find(issue => issue.number === number); },
  async findIssues(marker) { return issues.filter(issue => issue.body.startsWith(marker + '\n')); },
  async listIssues() { return new Map(issues.map(issue => [issue.number, issue])); },
};
// 再起動しても、登録済みのIssueが一覧に載るようにする。
registered.forEach(([, , labels], index) => issues.push({ number: 101 + index, html_url: 'https://github.com/' + repository + '/issues/' + (101 + index), body: '', labels: labels.map(name => tags[name]) }));
issues.push({ number: 101 + registered.length, html_url: 'https://github.com/' + repository + '/issues/' + (101 + registered.length), body: '', labels: [] });
const reloaded = issues.splice(0);
const server = createProgressServer({ repositories: [], dataDir, githubRepository: repository, githubClient: github });
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
console.log('http://127.0.0.1:' + port + '/bugs/');

const base = 'http://127.0.0.1:' + port + '/api/bugs';
const call = async (method, p, body) => (await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })).json();
const existing = (await call('GET', '/reports')).reports;
const expected = early.length + registered.length + 1;
if (existing.length > early.length && existing.length < expected) {
  console.error('保存先が途中までしか作られていません（' + existing.length + '/' + expected + '件）。保存先を消して、作り直してください。');
  server.close(); process.exit(1);
}
if (existing.length >= expected) {
  issues.push(...reloaded); // 作成済みのIssueを模擬のGitHubに戻す。
} else {
  const order = ['received', 'working', 'fixed', 'checking', 'complete'];
  for (const [title, status, labels, kind] of registered) {
    github.nextLabels = labels;
    const { report } = await call('POST', '/reports', { body: bodyOf(title), reportedVersion: 'S-1', requestId: 'seed-' + randomUUID(), uploadIds: [], ...(kind ? { kind } : {}) });
    // 登録とタグの取得を待ってから、対応状況を進める。
    for (let i = 0; i < 50; i++) { const d = (await call('GET', '/reports/' + report.id)).report; if (d.github.state === 'registered' && d.github.tags.state === 'ok') break; await new Promise(r => setTimeout(r, 200)); }
    let d = (await call('GET', '/reports/' + report.id)).report;
    while (order.indexOf(d.status) < order.indexOf(status)) {
      if (d.status === 'checking') await call('POST', '/reports/' + report.id + '/confirmations', { revision: d.revision, requestId: 'c-' + randomUUID(), version: 'S-2', result: 'resolved', note: notes[title]?.confirm ?? '' });
      else await call('POST', '/reports/' + report.id + '/status', { revision: d.revision, requestId: 's-' + randomUUID(), targetVersion: d.status === 'fixed' ? 'S-2' : '', developerNote: notes[title]?.[d.status] ?? '' });
      d = (await call('GET', '/reports/' + report.id)).report;
    }
  }
  await call('POST', '/tag-roles', { roles: roles.map(([name, role]) => ({ id: tags[name].id, role })) });
  // 登録前のカテゴリ。タグの役割を割り当てたあとでないと、選べない。
  const unregistered = (await call('GET', '/reports')).reports.find(item => item.title === early[0][0]);
  await call('POST', '/reports/' + unregistered.id + '/categories', { categories: pendingCategories.map(name => tags[name].id), revision: unregistered.revision });
  github.dropLabels = true;
  const { report: dropped } = await call('POST', '/reports', { body: bodyOf(droppedTitle), reportedVersion: 'S-1', requestId: 'seed-' + randomUUID(), uploadIds: [], categories: [tags.通知.id] });
  for (let i = 0; i < 50; i++) { const d = (await call('GET', '/reports/' + dropped.id)).report; if (d.github.state === 'registered' && d.github.tags.state === 'ok') break; await new Promise(r => setTimeout(r, 200)); }
  github.dropLabels = false;
  // 要望の判定（#82）。判定に対応していない版（変更前のmain）では、断られるだけで、何も残らない。
  const decisions = new Map([['予約一覧に、日付での並び替えがほしい', ['accept', '次の版で入れる。']], ['通知メールに、予約の変更前の日時も載せてほしい', ['defer', '送信の作り直しのあとで見直す。']]]);
  for (const item of (await call('GET', '/reports')).reports) { const d = decisions.get(item.title); if (d) await call('POST', '/reports/' + item.id + '/decision', { decision: d[0], note: d[1], revision: item.revision }); }
  console.log('seeded', (await call('GET', '/reports')).reports.length);
}
