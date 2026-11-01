# GitHub snapshotの取得

この文書の取得経路は、既存の認証済み`gh`を使う。
新しいcredential・ログイン・npm依存は追加しない。
取得は複数要求であり、GitHub側の一時点のトランザクションではないため、取得中の変更をすべて検出する保証はない。
取得・取込の操作範囲と検証条件は[snapshotの仕様](specification.md#採用済み仕様読み取り専用github-snapshot)に従う。

## ローカルのghで自動取得する

`gh`とNode.jsを同じ環境に用意し、[READMEの起動手順](../README.md#起動と検証)に従う。

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
取得後の画面構成は[GitHubから表示する計画](specification.md#githubから表示する計画)に従う。

再取得は設定したrepositoryのうち登録済みのものを順に取得する。
他のrepositoryはJSONの手動取込を使う。

同じrepositoryを複数登録した場合は、そのrepositoryの各projectIdへsnapshotだけを反映し、手動計画はそれぞれ保持する。

Nodeがブラウザ外で`gh api --hostname github.com`を呼ぶ。
Issue・PR・MilestoneはREST GETで、親子IssueとProjectはGraphQL queryで読み取る。
ブラウザからcredential・コマンド・queryを渡さない。

各一覧を最後のページまで取得し、`buildSnapshot`・`attachSnapshot`で検証する。
RESTとGraphQLのIssue集合・更新日時が一致しない場合も更新を見送る。

取得項目は[データ形式](development.md#データ形式)に従う。

取得は同時に1repositoryまでとし、同repositoryの同時要求を共有する。
取得中に届いた登録後の取得要求と明示的な再取得要求はまとめて保持し、現在の取得が終わった後に最新の登録先を確認して処理する。
要求が届いた後に取得を始めて保存したrepositoryは取り直さない。

成功結果はNodeのメモリで15秒だけ再利用し、取得全体90秒・gh一回20秒・生応答の合計20MiB・各一覧最大50ページの上限を持つ。
生成するsnapshotの容量上限は[snapshotの検証条件](specification.md#採用済み仕様読み取り専用github-snapshot)に従う。

GraphQLのIssueは1ページ100件で取得する。
IssueごとのProject登録は10件、Project登録ごとのフィールド値は100件、前提（blocked by）は20件、前提ごとのラベルは50件、紐づくPRは20件までとし、次ページが残る場合は不完全として更新を見送る。

取得失敗やページ不整合では更新を見送る。
取込・保存時の失敗は[snapshotの仕様](specification.md#採用済み仕様読み取り専用github-snapshot)に従う。
同じ取得日時・同じ内容の共有応答は保存を省略する。

GitHub APIの1時間の枠（GraphQLは5,000ポイント）は、同じ`gh`の認証を使うほかの作業と共有する。
GitHubはGraphQLのコストを、入れ子の接続の親の件数の積から数える。
上の上限では、Issue 100件のページごとに33ポイントを使う（実測）。
GraphQL queryは全体の残りポイントも読み、その値が1,000を下回る間は、リセット時刻まで新しい取得を始めない。
取得の途中で下回ったときも、次のページを取得しない。
ほかのプロセスが枠を使い切り、`gh`が利用制限の応答を返したときも同じく止める。
Nodeは`gh api --include`で応答のヘッダーも読み、一次制限は`x-ratelimit-reset`、二次制限は`retry-after`が示す時刻まで止める。
時刻が分からないときは5分間止める。
止めている間は`gh`を呼ばず、取得状態に止めている理由と再開できる時刻を示す。
停止中のデータは[snapshotの保持規則](specification.md#保存済みデータの保持)に従う。
別のプロセスや別のコマンドが使ったポイントも、残りに含まれる。

手動編集は取得中も使える。
保存直前に最新の手動計画を読み直し、既存のWeb Locksと保存検証を使う。

詳細drawerと未保存の入力を更新で閉じない。
開いている「登録・取込」のsnapshot一覧とGitHub詳細は最新snapshotのタイトル・状態・日時で更新する。
対象が最新snapshotに含まれなくなった場合は、その旨を詳細に表示する。

別タブによる更新は[ローカル保存の規則](specification.md#採用済み仕様プロジェクトと保存ローカルモード)に従う。
自動保存でもこの検出が働くため、編集は一つのタブで行う。

サーバーは127.0.0.1だけで待ち受ける。
APIはloopback Host、同一Origin、プロセスごとのCSRF token、設定したrepository、入力サイズを検証し、CORSを許可しない。
ghのstderr・credentialをブラウザに返さない。

Nodeのキャッシュは保存先ではなく、サーバー再起動で消える。
保存先は[保存の範囲](specification.md#保存の範囲)に従う。

Hostedの対応範囲は[ガント情報の取得と保存](#ガント情報の取得と保存)を参照する。

## ガント情報の取得と保存

ローカル自動取得は、既存の計画情報に任意の `planning.schedule` を加える。
この項目は `schemaVersion: 1`、GraphQLの出典URL `sourceUrl`、repository込みのIssue URLをキーにした `issues` を持つ。
既存の `planning.issues`・Milestone・作業分類・集計は変更しない。
旧snapshotは移行せず読めるが、旧形式が持たない作業進捗率は未取得になる。

| 保存する情報 | 内容 |
| --- | --- |
| Issue | 正規化したURL `key`、タイトル、更新日時、開閉、親、子の一覧、blocked by |
| Project | ID・タイトル・URL、一覧の取得完全性と取得不能の原因 |
| 計画フィールド | Status・担当・Estimate・作業進捗率・Iterationの取得結果。`fieldSources` にフィールド名と取得できたIDを保持する |
| 値の取得結果 | `value` と `problem`。取得済みの空欄は `value: null, problem: null`、未取得・権限不足・失敗はそれぞれ `not-fetched`・`forbidden`・`failed` とする |
| 一覧の取得結果 | キーの一覧 `keys`、全件数 `totalCount`、完全性 `complete`、取得不能の `problem` を保持する |

フィールド値の一覧に項目がなければ取得済みの空欄とし、IDは `null` にする。
フィールド自体の未作成と、作成済みだが値が空欄の場合は、この取得経路では区別できない。
取得できた有限の数値は、作業進捗率が範囲外でもその値を保持し、計算側で不正値として診断する。
未取得や不正値を0へ変換しない。
Iterationは開始日と、開始日からduration日間の最終日を保存する。
外部Issueの日付が不正なら実在する別の日付へ補正しない。

開いたMilestoneに所属する末端Issueから、前提と祖先をたどる。
前提が集約Issueなら最下位の子まで展開し、祖先に登録されたblocked byも取得する。
祖先を確認しただけでは兄弟作業の詳細を追加取得しない。
完了が確定した末端の過去の前提は追加取得しないが、Closedの集約Issueは配下を確認する。
同じURLは共有し、repositoryが異なる同番号のIssueは区別する。
外部repositoryは、取得した親・子・blocked byの参照先だけを読む。

追加取得は1回の更新につき100要求までとし、Issueの合計は5,000件までとする。
追加queryの子・blocked byは各100件、Project登録は10件、フィールド値は100件までで、次ページが残れば更新を見送る。
既存の全体時間・応答容量・GraphQL予約枠を共有し、各追加要求の前にも予約枠を確認する。
追加取得が失敗した場合はsnapshotの一部だけを保存せず、[保存済みデータを保持する](specification.md#保存済みデータの保持)。
サーバーは原因を `schedule_forbidden`（権限不足）、`schedule_failed`（取得失敗）、`schedule_limit`（範囲・要求数の上限）、`schedule_invalid`（応答の不整合）として返す。
APIの一次・二次制限と時間切れには、既存の `rate_limited`・`timeout` を使う。
ブラウザの取得状態には既存の失敗表示を使い、原因別のガント画面表示は画面への組込みで扱う。

保存前の検証では、構造、URL、重複、件数、取得結果の組合せ、親子関係、既存planningと重複する値を照合する。
再取得した外部Issueの更新日時が保存済みの同じIssueより古い場合も、snapshotを置き換えない。
取得不能を記録した拡張snapshotの手動取込は可能だが、ローカル自動取得は必要な追加取得に失敗すると結果を返さない。

### 計算入力への変換

`dist/github-schedule-input.mjs` の `githubScheduleInput(snapshot, options)` を使う。
`options` は `baseDate`、`selectedProjectId`、任意の `sourceProjectIds` を持つ。
`sourceProjectIds` はIssue URLから利用者が指定したProject IDへの対応であり、永続化はこのadapterでは行わない。
同一repositoryの既定の出典には `selectedProjectId` を使い、外部Issueには個別指定を求める。
先頭のProjectを自動選択せず、指定先への未登録・未取得と、出典未選択を区別する。

完了判定は出典を絞る前のProject一覧に対して求める。
計画値は選ばれたProjectだけから渡し、別Projectの値で不足を埋めない。
Milestoneの期日は日時の年月日部分を使い、旧snapshotで不足する前提・親子・進捗率は未取得のまま渡す。
入出力の意味は[計算側の入力契約](milestone-gantt-calculation.md#入力)を参照する。
このadapterは保存・通信・画面の組込みを行わない。

### 取得経路ごとの対応

| 経路 | ガント情報の対応 |
| --- | --- |
| ローカル自動取得 | 拡張情報を取得・検証し、既存の保存経路へ渡す |
| snapshot JSONの手動取込 | 拡張あり・なしの両方を検証する。下記のREST専用helperは拡張情報を生成しない |
| クラウドのworkspace保存・読込み | 共通validatorを使い、拡張情報を保持する。GitHubの自動取得はしない |
| 限定Hosted MCP | 保存済み拡張情報の読取りはできる。計画情報付きsnapshotの更新は拒否し、保存済みデータを保持する |

GraphQLの項目はGitHub公式の[Issue](https://docs.github.com/en/graphql/reference/issues)・[Project](https://docs.github.com/en/graphql/reference/projects)の定義を使う。
Hosted MCPによる取得範囲の拡張、GitHubへの書込み、画面への接続はこの取得機能に含めない。

## snapshot JSONを手動で再取得する

ブラウザからGitHubへ直接アクセスせず、取得と取込を分ける。
既存の`gh`に対象repositoryの読み取り許可がある環境では、次のGET専用helperで新しいファイルを作る。

```sh
node scripts/fetch-github-snapshot.mjs --repo owner/repo --output snapshot-new.json
```

helperはIssue/PRの`state=all`を100件ずつ取得し、最後の100件未満のページまで進む。
取得上限・欠落・重複・Issue一覧とPR一覧の不一致があれば出力しない。
既存の出力ファイルは上書きせず、失敗時も保持する。

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

取込先ごとの保存先は[保存の範囲](specification.md#保存の範囲)に従う。

クラウドモードはローカルghの自動取得を実行しない。
同期の実装状況は[未実装・未決定事項](development.md#未実装未決定事項)を参照する。
