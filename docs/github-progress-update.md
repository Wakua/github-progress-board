# 作業進捗率の入力と更新

指定されたGitHub Projectの初期設定担当者と作業担当者向けに、変更対象を確認し、根拠を残して進捗率を更新する手順を示す。
対象は数値フィールドの初期設定と、指定した作業Issue一件の更新である。
画面からの入力、snapshotの取得・変換、ガント画面への接続は含めない。
値の意味、入力する担当とタイミングは[正本と更新の範囲](milestone-gantt.md#正本と更新の範囲)に従う。

## 適用前の確認

利用者が指定したProjectとrepositoryを使う。
初期設定では作成するフィールドと入力するIssue、更新では変更前後の値と根拠を利用者に提示し、許可された対象だけへ適用する。
同じIssueを複数の担当者・コマンドで同時に更新しない。
GitHub APIには、この処理で使う値の比較と書込みを一括で行う仕組みがないため、直前の再取得後に起きる競合を完全には防げない。

対象表には次の内容を記載する。
StatusがTodoであることだけを未着手の根拠にしない。

| 対象表の項目 | 確認する内容 |
| --- | --- |
| 接続先 | ProjectのURL・node ID、repository |
| 作業 | IssueのURL、Projectの担当、子Issueがないこと |
| 差分 | 作業進捗率とEstimateの変更前後。未入力は未入力と記す |
| 根拠 | 完了した内容、残る内容、現在のEstimateに対する割合、成果へのURL |
| 初期値0の候補 | 担当者が未着手と確認した根拠。確認できなければ対象外にする |
| 対象外 | 他担当、進み具合を確認できない作業、集約用Issue |

## 最短の手順

Node.jsと認証済みの`gh`を用意する。
接続先はgithub.comであり、認証情報をファイルへ書き出さない。
Projectの読取り・更新とIssueへのコメントに必要な権限を使う。
以下の`PVT_example`、`example/demo`、Issue番号は架空の例なので、許可された対象に置き換える。

1. 初期設定担当者は、Projectのnode IDを確認し、フィールド作成の予定を表示する。

   ```sh
   node scripts/update-github-progress.mjs --project-id PVT_example --repo example/demo --setup
   ```

   対象を確認して許可を得たら、同じコマンドに`--apply`を付ける。
   名前が完全一致する数値フィールドを再利用し、同名の重複や型の不一致があれば停止する。
   結果に返るフィールドIDを取得担当へ伝える。
   フィールド作成ではIssueの値を入力しない。

2. 作業担当者はProjectの現在値を読み、根拠をUTF-8のファイルへ記載する。
   ファイルは`references/`などGit管理外に置く。

   ```text
   実装3ptを確認した。
   検証2ptが残るため、見積5ptに対して60%とする。
   成果: https://github.com/example/demo/pull/8
   ```

3. 指定した一件の変更予定を表示する。

   ```sh
   node scripts/update-github-progress.mjs --project-id PVT_example --repo example/demo --issue 7 --actor Codex --operation task7-validation --progress 60 --expected-progress unset --expected-estimate 5 --reason-file references/task7-reason.txt
   ```

   `--apply`がなければ、コメントも値も変更しない。
   `--operation`は更新ごとに一意な英数字・ハイフン・アンダースコアの名前とし、同じ変更の再実行では変えない。
   プレビューの`changes`で変更前後、`pending`で未適用分を確認する。
   進捗率フィールドをまだ作成していない場合は、先に手順1を終える。

4. 対象表の許可を得たら、同じコマンドに`--apply`を付けて実行する。
   根拠と変更前後の値をIssueへ記録し、値を変更して再取得した後、完了コメントを残す。
   結果の`mode: applied`はGitHubの値を確認した状態を表し、利用者受入や日程表示の検証は表さない。

5. [GitHubの再取得](github-integration.md#ローカルのghで自動取得する)を行う。
   新しい取得時点のsnapshotで、Project・フィールドの出典と値が一致することを確認する。
   ガント接続後は、[残り作業量と日程](milestone-gantt.md#作業進捗率)を確認する。
   取得や画面の接続前は、その確認を未実施として残す。

## 初期値と見積の変更

初期値0を入力する場合は、担当者の未着手確認を根拠ファイルへ記載し、`--progress 0 --expected-progress unset --confirm-unstarted`を指定する。
一括で0を入れるコマンドは設けない。
確認できない既存作業には実行しない。
初期設定後の新規作業登録と作業の区切りにも、この一件単位の手順を使う。

Estimateの見直しが必要なら、根拠ファイルへ理由を加え、`--estimate 4`のように変更後の値を指定する。
`--expected-estimate`には変更前の値を指定し、未入力なら`unset`とする。
Estimateを変えない場合も、進捗率の根拠となる現在の値を確認するために`--expected-estimate`は必須とする。
見積の変更前の値は根拠コメントに残る。

## 失敗と再実行

| 結果・停止箇所 | 次の操作 |
| --- | --- |
| フィールド作成に失敗・応答喪失 | `--setup`で再取得する。既に同名の数値フィールドがあれば再利用する |
| 読取り不足・権限不足・対象不一致 | 原因を解消してプレビューする。Projectへの自動登録や担当変更はしない |
| 現在値が変更前と異なる | 差分と担当者の変更を確認する。変更前値を機械的に差し替えて上書きしない |
| 根拠コメントで停止 | 同じ引数でプレビューする。根拠が保存されていなければ値は変更していない |
| 進捗率・Estimateの途中で停止 | 適用済みの値を保持し、同じ引数でプレビューして未適用分を確認する |
| 完了コメントで停止 | 同じ引数でプレビューする。値が変更後と一致すれば再実行で完了コメントを補う |
| `mode: unchanged` | 同じ操作の完了済み、またはフィールドが既存。重複した書込みはしない |
| GitHub更新後のsnapshot取得に失敗 | GitHubの値を戻さず、[保存済みデータの保持](specification.md#保存済みデータの保持)に従って再取得する |

再実行では、同じ操作名・引数・根拠ファイルを使う。
根拠コメントが残り、値が変更前または変更後と一致する範囲で再開する。
別の値に変わっていた場合や、同じ操作名で内容を変えた場合は停止する。
更新予定のコメントだけでは適用完了と判断せず、Projectの値と完了コメントを照合する。

## 実装と検証の境界

コマンドは`update-github-progress.mjs`、更新手順は`github-progress-update.mjs`、GitHubとの通信は`github-progress-client.mjs`に分ける。
サンプル用の`server/progress-update.mjs`と、snapshot取得・画面の読込みから呼び出さない。
[GitHub公式のProject API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)を使い、数値フィールドの作成・更新とIssueコメントだけを行う。

Projectのフィールド、Issueの登録Project、フィールド値は各100件まで取得し、続きがある場合は更新を停止する。
根拠コメントは全ページを取得し、件数の変化・重複・取得不足を検出した場合も停止する。
試験は`node --test tests/github-progress-update.test.mjs`で実行する。
fixtureの失敗・再実行試験と、実GitHubへの適用・日程の確認は区別して記録する。
