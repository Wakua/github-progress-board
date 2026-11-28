# 開発と検証

着手から受入までの進め方と証拠の残し方は、[開発手順と実施記録](development-workflow.md)に従う。

## 内部構造

| ファイル・フォルダー | 責務 |
| --- | --- |
| `dist/` | 手書きのアプリ本体。Git管理する |
| `dist/workspace.mjs` | 登録、projectIdによる境界、workspaceの検証とローカル保存 |
| `dist/engine.mjs` | 一つのプロジェクトの表示判断と集計 |
| `dist/github-snapshot.mjs` | snapshotの検証、REST adapter、古さの表示 |
| `dist/github-planning.mjs` | GitHubの計画情報の検証と集計 |
| `dist/github-schedule-data.mjs`・`dist/github-schedule-input.mjs` | ガント取得情報の検証と計算入力への変換 |
| `scripts/github-schedule-fetch.mjs` | 外部の前提・集約配下・祖先に必要な情報の追加取得 |
| `dist/github-planning-view.mjs` | GitHubの計画情報の表示 |
| `dist/release-gantt-model.mjs`・`dist/release-gantt.mjs` | 取得結果と日程計算をリリースタブへ接続 |
| `dist/gantt-chart.mjs`・`dist/gantt-axis.mjs` | ガントの時間軸、詳細、依存の追跡 |
| `dist/release.mjs` | リリースの割当と要対応の集計 |
| `dist/milestone-schedule.mjs` | Milestoneの日程、依存関係、余裕、担当重複の純粋な計算 |
| `dist/milestone-schedule-math.mjs` | 日程計算で使う十進演算と平日の座標変換 |
| `server/worker.mjs` | クラウドAPIと認証境界 |
| `server/cloud-db.mjs` | クラウドの保存境界 |
| `dist/cloud-workspace.mjs` | 画面側のクラウド保存確認と移行 |
| `tests/` | 表示判断、保存、APIのテスト |
| `samples/` | 架空のサンプル記録 |

クラウドでもworkspaceの検証とプロジェクト別集計を再利用する。
動作の規則は[進捗管理の仕様](specification.md)、取得処理は[GitHub snapshotの取得](github-integration.md)、クラウドの保存条件は[共有保存](cloud-workspace.md)を参照する。

### データ形式

ローカル保存キーは`progress-tool.workspace.v1`、直前バックアップは`.backup`、破損原本の退避は`.recovery`である。

workspaceの最上位は`schemaVersion`、`selectedProjectId`、`projects`を持つ。
各projectは`id`、`name`、`repositoryUrl`、`data`と任意の`githubSnapshot`、`approvalLimit`を持つ。
`approvalLimit`の条件は[承認待ちのPR](specification.md#承認待ちのpr)に従う。
既存v1データは移行せず読み込める。
Issueの出典識別にはprojectId、repository URL、entityId、Issue番号の組を使う。

snapshotにはprojectId、repository URL、取得日時、全ページの取得元URL、Issue/PRの種類・番号・URL・タイトル・状態・GitHub更新日時を保持する。
PRにはDraft・merge日時も保持する。
Issueには、本文を取得できたときだけ受入待ちの有無 `acceptancePending` を保持する。
本文がnullならfalse、未取得なら項目を省略する。
ClosedのIssueは、RESTの終了理由が `completed` なら `notPlanned: false`、`not_planned` なら `notPlanned: true` を保持する。
終了理由が不明なときとOpenでは項目を省略し、旧snapshotもそのまま読み込む。
識別にはrepository URL（大文字小文字を同一視）・種類・番号の組を使う。
Issue・PRの基本項目の見積・期限はnullを保持する。

任意の`planning`に親子Issue、Milestone、Projectの「担当」「Iteration」「Estimate」「Status」「優先度」、依存関係（blocked by）、紐づく開いたPR、`仕様` ラベルを保持する。
planningを含まない既存snapshotも読み込める。
任意の `planning.schedule` にガント計算用の取得情報を保持する。
形式・旧snapshotとの互換性・取得経路の違いは[ガント情報の取得と保存](github-integration.md#ガント情報の取得と保存)を参照する。
Issue本文からは[受入待ちの記録](#受入と公開版の記録)だけを読み、本文そのものは保存しない。
コメント、CI、レビュー、完了条件は取得しない。

## 試験の分担

振る舞いごとに、確かめる層を一つ決める。
その振る舞いを観察できる、いちばん下の層で確かめ、上の層では下の層で確かめられないことだけを確かめる。
同じ規則を複数の層で確かめると、試験が増えるだけでなく、規則を変えるたびに複数の層の試験を直すことになるためである。

| 層 | 例 | 確かめること | 確かめないこと |
| --- | --- | --- | --- |
| 単体 | `dist/bugs/view.mjs`、`server/test-plan-store.mjs` の試験 | 判定、件数、表示する印、入力の検査、状態の遷移。値ごとに確かめる | — |
| API | `tests/test-plan-api.test.mjs` | HTTPでの受け渡し、接続元の制限、失敗と再送 | 単体で確かめた入力の検査を、値ごとに確かめ直すこと |
| 画面（擬似DOM） | `tests/support/bug-ui.mjs` を使う試験 | 画面の層で初めて観察できる振る舞い（日本語の変換中は検索しない、古い検索の応答を捨てるなど）と、描画と操作が単体の判定につながること。振る舞いごとに1件 | 単体で確かめた判定を、値ごとに確かめ直すこと |
| ブラウザー | `tests/*-browser-qa.mjs` | 実際のブラウザーで初めて観察できる振る舞い（フォーカスの戻り、スクロールの位置、表示の幅）と、利用者の一連の操作（一覧から絞り込み、詳細を開いて戻るなど） | 単体と画面で確かめた判定の細部 |
| 手のケース | [テストケース作成の方針](test-case-design.md) | 自動の試験がまだない操作、自動にできない操作、分かりやすさ | 自動の試験で確かめている内容 |

複数の機能が使う規則（絞り込みの重ね方など）は、その規則を持つ部品の単体の試験で一度だけ確かめる。
機能ごとの試験では、その機能に固有の条件だけを確かめる。

自動にできるが試験がまだない振る舞いは、手のケースで先に確かめてよい。
例えば、狭い画面で計画を選ぶとフォーカスが計画名へ移ることは、ブラウザーの試験で確かめられるが、試験がないうちは手のケースで確かめる。
リリースごとに繰り返し確かめる振る舞いは、それを観察できるいちばん下の層に自動の試験を足し、手のケースをDeprecatedにする。

### 試験を足す・消す

- 試験を足す前に、同じ振る舞いを確かめている試験を探す。
  あれば、新しく足さずに既存の試験を直す。
- 上の層の試験や利用者の操作で不具合が見つかり、下の層の試験が失敗しなかったときは、その不具合を再現できる、いちばん下の層に試験を足す。
- 下の層と同じことを確かめている上の層の試験は消す。
  消すときは、代わりに確かめている試験をPRに示す。

### 分岐網羅

製品のコードを変えたPRでは、試験を変えたかどうかにかかわらず、変えたファイルの分岐網羅を測り、PRに次を書く。

- 測定に使った試験
- 変えた行にある分岐のうち、通っていないもの

ファイル全体の網羅率だけでは、今回変えた分岐を通ったかが分からないためである。
次の例は、`dist/bugs/view.mjs` を変えたときに、その単体の試験で測り、分岐ごとの記録をlcov形式でGit管理外のファイルへ書き出す。

```sh
node --test --experimental-test-coverage --test-coverage-include='dist/bugs/view.mjs' --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=<Git管理外のファイル> tests/bug-github-view.test.mjs
```

lcovの `BRDA:<行>,<ブロック>,<分岐>,<通った回数>` のうち、行が変更箇所にあり、通った回数が0または`-`のものが、通っていない分岐である。
通っていない分岐には、試験を足すか、確かめない理由を書く。
全体の網羅率を目標にせず、網羅率を上げるためだけの試験は足さない。
網羅率では、書かれたコードを通ったかだけが分かり、仕様にあるのに実装されていない動作は見つからないためである。

## 検証手順

ローカル起動と基本の検証コマンドは[READMEの起動と検証](../README.md#起動と検証)に従う。

`npm test`は表示判断、保存・分離・復旧、snapshot、ローカルgh、共有保存、バグ報告APIを検証する。
共有SQLの試験はNodeのSQLiteを使う。
MCP出力契約の試験にはPythonとjsonschemaが必要であり、テスト環境のPATHからPythonを起動できるようにする。
`npm run check`はJavaScriptの構文と[画面画像の保存規則](screenshots.md#保存の規則)を検査する。
PRの判定表と根拠は[UIレビューのCI検査](ui-ux-review.md#ciによる検査)で確認する。
検査コードの回帰テストは`node --test tests/check-ui-review.test.mjs tests/run-ui-review.test.mjs`で実行する。
回帰テストはGitHubの応答を模擬するため、実際のAPI・権限・イベントの確認とは区別する。

### ブラウザ検証

起動済みサーバーに対して`npm run test:browser`を実行する。
接続先は`QA_BASE_URL`で指定する。
環境が提供するPlaywrightとChromiumを使い、場所を次の環境変数で指定できる。

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chromium npm run test:browser
```

サンプルの表示確認と、破損・失敗を起こすQA用fixtureを区別する。
どちらも専用の一時ブラウザコンテキストで行い、利用者の保存領域を変更しない。

登録・保存とsnapshotの結果・画面は、既定で`/tmp/progress-tool-browser-qa/`に保存する。
イテレーションの結果は、OSの一時領域に実行ごとのフォルダーを作って保存する。
`QA_ARTIFACT_DIR`で保存先を指定できる。
バグ報告の検証は[バグ報告の確認範囲](bug-reporting.md#実装状況と未確認事項)を参照する。

### UI/UXレビュー

画面変更と試作の提出前の確認は、[UI/UXレビューの手順](ui-ux-review.md)に従う。

### クラウドのビルドと隔離QA

実行時のnpm依存は0件、開発依存はesbuild・drizzle-kit・drizzle-ormの固定3件である。
`npm ci`後に`npm run build`を実行し、`dist/client`と`dist/server`を生成する。

`npm run preview:cloud`はloopback専用で、独立したローカルSQLiteと模擬cookie認証を使う。
隔離context間の共有を確認できる。
操作検証には次のコマンドを使う。

| 対象 | コマンド | 結果の保存先を指定する環境変数 |
| --- | --- | --- |
| 共有保存 | `npm run test:cloud:browser` | `CLOUD_QA_ARTIFACT_DIR` |
| 用意済み記録の初回取込 | `npm run test:prepared:browser` | `PREPARED_QA_ARTIFACT_DIR` |
| 仮見積 | `npm run test:estimates:browser` | `ESTIMATE_QA_ARTIFACT_DIR` |

共有保存の既定の保存先は`/tmp/progress-tool-cloud-browser-qa/`である。
本番の確認項目は[反映前の検証](cloud-release-verification.md#本番で残る確認)に従う。

## 実装状況

ローカル機能は、[操作説明](usage.md)にある登録・編集と、[進捗管理の仕様](specification.md)にある表示・保存に対応する。
要対応タブの狭い画面は、[理由による絞り込みの観察](attention-filter-observation.md#操作結果)で確認した。
リリースタブは、[採用した表示・操作](milestone-gantt-ui.md#表示と操作の契約)で、取得済みsnapshotから日程と警告を表示する。
通常幅・狭い幅、依存追跡、取得失敗と再取得の確認範囲は[組込み検証記録](verification/128-gantt-integration.json)を参照する。

[日程計算の内部契約](milestone-gantt-calculation.md)に従う純粋関数は、日程、クリティカルパス、作業進捗率から求める残量、担当重複を計算する。
計算は `tests/milestone-schedule.test.mjs`、取得・変換は `tests/github-schedule-input.test.mjs`・`tests/github-schedule-fetch.test.mjs`、画面への入力は `tests/release-gantt.test.mjs` で検証する。
作業進捗率の実書込み後の再取得、利用者の独力操作、製品全体の受入は未確認である。
進捗率の未入力を0%として計算せず、不足する項目として表示する。

担当別の負荷の上限は、手動計画とGitHubの計画の画面で確認した。
変更前後の画面は `docs/screens/18/` にある。
幅の狭い画面は担当別の残りの折り返しだけを確認し、複数のProjectに登録したIssueの集計は未確認である。

クラウドの機能別の規則は、次の文書で定義する。

| 機能 | 文書 |
| --- | --- |
| 認証付きの保存・移行 | [共有workspace](cloud-workspace.md) |
| 同梱サンプルの取込 | [用意済み記録](prepared-workspace.md) |
| 見積案の登録 | [仮見積](estimate-proposals.md) |
| 作業行の指標 | [完了条件達成率](progress-visibility.md) |
| 本人限定のMCP | [MCP](sites-mcp.md) |
| 証拠付きの固定案 | [進捗記録の更新](progress-record-update.md) |
| Hosted MCPによるGitHub取得 | [snapshotの二経路更新](github-facts-sync.md) |

GitHubソースと隔離QAを確認している。
実環境の確認状況は[本番で残る確認](cloud-release-verification.md#本番で残る確認)、バグ報告の確認状況は[機能別の確認範囲](bug-reporting.md#実装状況と未確認事項)で管理する。

## 未実装・未決定事項

- 双方向同期、プロジェクト名・repository URLの変更や削除、イテレーションの新規登録、親子Issueの構造編集は未実装である。
- 手動の作業に緊急を指定する機能は未実装である。
  緊急の定義は[自分の作業と要対応](specification.md#自分の作業と要対応)に従う。
- 手動計画とGitHubの作業の統合・移行、明示された完了条件の取得は未決定である。
- [次にすることの区分](specification.md#次にすることの区分)は、人が付けてコピーする範囲を実装した。
  次の項目は未実装・未決定である。
  - 「終わっている」「別のブランチで作業中」「やったはず」をPRの状態から推定する範囲と、根拠の取得元。
  - 「後回しでよい」の理由と見直す時期、「他の人に渡す」の相手など、区分ごとの補足の保存。
  - 手動計画の作業への区分。
  - 区分を、要対応タブの理由と同じ語で扱うか。
  - 利用者が実際の一覧で区分を使い、過不足を判断する。
- 子Issueを持つIssue自身に独立した作業量がある場合は、作業Issueへ分ける運用か、別の集計規則を採用するかを接続前に決定する。
- 同じ担当者が複数のプロジェクトを兼務するときの、担当別の負荷の合算は未実装である。
  担当者名と期間をプロジェクトの間で対応づける規則が決まっていない。

## 受入と公開版の記録

利用者は、作業を含む版を公開した後に、公開版で受入を確認する。

リリースの担当者はGitHub Releaseを公開したら、公開ページと対象のMilestoneを確認する。
Milestone説明には、公開版のURLと `受入: 確認中` をそれぞれ1行で記録する。
その版に含めた作業Issueの本文には `受入: 確認待ち` を独立した1行で記録し、公開版を同じ本文から参照できるようにする。
これで進捗管理のリリース一覧では、計画が「受入確認中」と公開版つきで未完了に並び、受入待ちの作業の件数を確認できる。

利用者が作業を受け入れたら、担当者は回答の根拠と受入結果を残して、Issueの待ちの行を削除する。
差戻しや再作業でも待ちの行を削除し、残作業を記録する。
引用・コード・HTML内の例や、重複・矛盾した受入行は集計しない。
マージや作業進捗率から、受入待ちを自動判定しない。

利用者が版の対象を受け入れたら、担当者はMilestone説明の `受入: 確認中` を `受入: 済` に更新し、判断の根拠を別の行に残す。
これで進捗管理のリリース一覧では「完了」になる。
たとえば次の記録では、公開版 `v1.4.0` の計画が受入済みになる。

```text
受入: 済
公開版: https://github.com/example/booking/releases/tag/v1.4.0
```

実際の説明にはコード枠や引用を付けず、それぞれ1行に書く。
版番号はMilestone名とは別に決める。
画面で「GitHubを再取得」すると記録が反映される。

## バージョン

現在の版は `0.4.0` である。
版の正本は`package.json`と`package-lock.json`の`version`で、一致を単体テストで検査する。
画面には表示しない。

- Milestone名は作業範囲を表す。アプリの版は、直前に公開した正式版と今回の変更内容から決める。
  機能を追加するときは2番目の数字を1上げ、3番目を0に戻す（例：`0.1.1` → `0.2.0`）。
  修正だけのときは3番目の数字を1上げる（例：`0.2.0` → `0.2.1`）。
- `1.0.0`は、保存データの形式が安定したとユーザーが判断したときにする。
  それまでは`0.`で始め、仕様の変更で互換性が変わることがある。
- 版の番号はアプリの版であり、保存データの`schemaVersion`とは別である。

リリースの周期、承認、タグとReleaseの作成手順は[作業規則](../AGENTS.md#issueとgithub-project)に従う。

## 参考

- [Asanaのプロジェクト表示](https://asana.com/features/project-management/project-views)：作業名と属性を列でそろえる一覧。
- [Linearの表示設定](https://linear.app/docs/display-options)：一覧の属性表示と、対象から詳細を開く構成。
- [GitHub Projectsの表示](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project)：テーブル形式による項目の表示。

## 公開対象

公開対象の文書・ソース・テスト・サンプルには、実際の活動を推測できるプロジェクト名、利用製品、制作内容、作業計画、公開サイトのURL、非公開repositoryの参照、個人の情報を含めない。
サンプルは実際の活動と無関係な題材で作り、実際の報告や添付本体、他社サービスの画面は公開しない。
観察資料の保存は[UI設計の規則](../AGENTS.md#ui設計)、本ツールの画面画像は[画像の保存規則](screenshots.md)に従う。

次の利用製品は例外として記載する。

- ChatGPT Sites：クラウドモードの認証と保存先。
  コード・画面・文書に記載してよい。
- Claude・Codex：開発の作業手順と担当。
  AGENTS.md・CLAUDE.md・README・ブランチ名・テストの担当者名に記載してよい。

公開版は整理後のファイルから履歴を引き継がずに作成し、最初のコミットに個人の氏名・メールアドレスを含めない。
公開前に、新しいrepositoryの全ファイルと履歴を再確認する。
