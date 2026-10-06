# GitHub snapshotの取得

## ローカルのghで自動取得する

既存の認証済み`gh`とNodeが同じ環境にある場合、次の起動後に`http://127.0.0.1:4319`を開く。
新しいcredential、ログイン、npm依存を追加しない。

```sh
npm start
```

自動取得するrepositoryは、環境変数 `PROGRESS_GITHUB_REPOS` にカンマ区切りで指定する。
`owner/repository` と `https://github.com/owner/repository` のどちらでもよく、50件までとする。
既定は空で、指定がなければ自動取得しない。

```sh
PROGRESS_GITHUB_REPOS=owner/repo-a,owner/repo-b npm start
```

```powershell
# PowerShell
$env:PROGRESS_GITHUB_REPOS = 'owner/repo-a,owner/repo-b'; npm start
```

指定したrepositoryのURLをプロジェクトに登録すると、JSONファイルを扱わずGitHub snapshotを自動保存する。
初回の空一覧からは取得・登録しない。

ブラウザは起動時にサーバーから許可された一覧を受け取り、それ以外のrepositoryを要求しない。

ページ起動時、新しい対象プロジェクトの登録後、表示中の5分ごとに取得する。
非表示のタブは新しい取得を始めず、再表示時に前回から5分以上経っていれば取得する。

選択したプロジェクトの両タブと「登録・取込」に取得状態と「GitHubを再取得」を表示する。
「自分の作業」ではGitHubの作業を分類して表示し、手動計画は畳む。

再取得は設定したrepositoryのうち登録済みのものを順に取得する。
他のrepositoryはJSONの手動取込を使う。

同じrepositoryを複数登録した場合は、そのrepositoryの各projectIdへsnapshotだけを反映し、手動計画はそれぞれ保持する。

Nodeがブラウザ外で`gh api --hostname github.com`を呼ぶ。
Issue・PR・MilestoneはREST GETで、親子IssueとProjectはGraphQL queryで読み取る。
ブラウザからcredential・コマンド・queryを渡さず、GitHubへの書き込みを行わない。

各一覧を最後のページまで取得し、`buildSnapshot`・`attachSnapshot`で検証する。
RESTとGraphQLのIssue集合・更新日時が一致しない場合も更新を見送る。

取得はGitHub側の一時点のトランザクションではなく、取得中の変更をすべて検出する保証はない。
完了条件の取得は別の作業とする。

取得は同時に1repositoryまでとし、同repositoryの同時要求を共有する。
取得中に届いた登録後の取得要求と明示的な再取得要求はまとめて保持し、現在の取得が終わった後に最新の登録先を確認して処理する。
要求が届いた後に取得を始めて保存したrepositoryは取り直さない。

成功結果はNodeのメモリで15秒だけ再利用し、取得全体90秒・gh一回20秒・生応答の合計20MiB・snapshot 5MiB・各一覧最大50ページの上限を持つ。

GraphQLのIssueは1ページ100件で取得する。
IssueごとのProject登録は20件、Project登録ごとのフィールド値は100件、前提（blocked by）は50件、前提ごとのラベルは50件、紐づくPRは20件までとし、次ページが残る場合は不完全として更新を見送る。

途中失敗、ページ不整合、古い取得日時、保存容量不足では保存済みのsnapshotと手動計画を保持する。
同じ取得日時・同じ内容の共有応答は保存を省略する。

手動編集は取得中も使える。
保存直前に最新の手動計画を読み直し、既存のWeb Locksと保存検証を使う。

詳細drawerと未保存の入力を更新で閉じない。
開いている「登録・取込」のsnapshot一覧とGitHub詳細は最新snapshotのタイトル・状態・日時で更新する。
対象が最新snapshotに含まれなくなった場合は、その旨を詳細に表示する。

別タブが保存した場合は取得結果も反映を止め、再読み込みを案内する。
自動保存も別タブの編集停止を起こすため、編集は一つのタブで行う。

サーバーは127.0.0.1だけで待ち受ける。
APIはloopback Host、同一Origin、プロセスごとのCSRF token、設定したrepository、入力サイズを検証し、CORSを許可しない。
ghのstderr・credentialをブラウザに返さない。

Nodeのキャッシュは保存先ではなく、サーバー再起動で消える。
最終的な保存先は同ブラウザ・同オリジンのlocalStorageである。

hosted SiteのMCP経路・サーバー保存・双方向同期・deployはこのローカル機能の範囲に含めない。

ポートの指定方法は[起動と検証](development.md#起動と検証)に従う。

## snapshot JSONを手動で再取得する

ブラウザからGitHubへ直接アクセスせず、取得と取込を分ける。
新しい認証情報、ログイン、OAuthは作らない。
既存の`gh`に対象repositoryの読み取り許可がある環境では、次のGET専用helperで新しいファイルを作る。

```sh
node scripts/fetch-github-snapshot.mjs --repo owner/repo --output snapshot-new.json
```

helperはIssue/PRの`state=all`を100件ずつ取得し、最後の100件未満のページまで進む。
取得上限・欠落・重複・Issue一覧とPR一覧の不一致があれば出力しない。
既存の出力ファイルは上書きせず、失敗時も保持する。

取得は複数GETでありGitHub側の一時点のトランザクションではない。
取得中の変更をすべて検出する保証はない。

`gh`を使えない環境では、別の方法で取得した生のREST配列を次の形で保存すれば、追加のネットワークアクセスなしで同じhelperを使える。

```json
{
  "repositoryUrl": "https://github.com/owner/repo",
  "fetchedAt": "2026-10-03T16:14:45Z",
  "issuePages": [[]],
  "pullPages": [[]]
}
```

`issuePages`はPRも含むGitHubのIssue一覧、`pullPages`はPR一覧のREST応答をページ順に格納する。
上記の空配列は形式説明であり実データではない。

取得日時を実際のGET完了後に記録し、取得していないページや日時を補わない。

```sh
node scripts/fetch-github-snapshot.mjs --repo owner/repo --from-pages pages.json --output snapshot-new.json
```

単一snapshotをそのまま読み込める。
複数を一度に読み込む場合は`{"type":"github-snapshot-bundle","schemaVersion":1,"snapshots":[...]}`で包む。
取込用JSONにprojectIdは含めず、画面で取込先を決める。

`npm start`のローカルモードでは更新も同ブラウザ・同オリジンに保存する。
クラウドモードでは同じsnapshotを共有workspaceに保存する。
ローカルモードで設定したrepositoryは上記の自動取得に対応する。

クラウドモードはローカルghの自動取得を実行しない。
双方向同期は行わない。
