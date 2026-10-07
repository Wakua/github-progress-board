# 開発と検証

## 内部構造

| ファイル・フォルダー | 責務 |
| --- | --- |
| `dist/` | 手書きのアプリ本体。Git管理する |
| `dist/workspace.mjs` | 登録、projectIdによる境界、workspaceの検証とローカル保存 |
| `dist/engine.mjs` | 一つのプロジェクトの表示判断と集計 |
| `dist/github-snapshot.mjs` | snapshotの検証、REST adapter、古さの表示 |
| `dist/github-planning.mjs` | GitHubの計画情報の検証と集計 |
| `dist/github-planning-view.mjs` | GitHubの計画情報の表示 |
| `dist/release.mjs` | リリースタブの表示判断 |
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
識別にはrepository URL（大文字小文字を同一視）・種類・番号の組を使う。
Issue・PRの基本項目の見積・期限はnullを保持する。

任意の`planning`に親子Issue、Milestone、Projectの「担当」「Iteration」「Estimate」「Status」「優先度」、依存関係（blocked by）、紐づく開いたPR、`仕様` ラベルを保持する。
planningを含まない既存snapshotも読み込める。
Issue本文、コメント、CI、レビュー、完了条件は取得しない。

## 検証手順

ローカル起動と基本の検証コマンドは[READMEの起動と検証](../README.md#起動と検証)に従う。

`npm test`は表示判断、保存・分離・復旧、snapshot、ローカルgh、共有保存、バグ報告APIを検証する。
共有SQLの試験はNodeのSQLiteを使う。
MCP出力契約の試験にはPythonとjsonschemaが必要であり、テスト環境のPATHからPythonを起動できるようにする。
`npm run check`はJavaScriptの構文と[画面画像の保存規則](screenshots.md#保存の規則)を検査する。

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
要対応・リリースのタブは試作として扱い、幅の狭い画面と複数のProjectに登録したIssueの表示は未確認である。
リリースの変更前後の画面は `docs/screens/6/` にある。

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
- 手動の作業に緊急を指定する機能は未実装である。緊急の定義は[自分の作業と要対応](specification.md#自分の作業と要対応)に従う。
- 手動計画とGitHubの作業の統合・移行、明示された完了条件の取得は未決定である。
- 子Issueを持つIssue自身に独立した作業量がある場合は、作業Issueへ分ける運用か、別の集計規則を採用するかを接続前に決定する。
- 同じ担当者が複数のプロジェクトを兼務するときの、担当別の負荷の合算は未実装である。担当者名と期間をプロジェクトの間で対応づける規則が決まっていない。

## バージョン

現在の版は `0.1.0`（公開時点）である。
版の正本は`package.json`と`package-lock.json`の`version`で、一致を単体テストで検査する。
画面には表示しない。

- 版は`0.<Milestoneの通し番号>.<修正の番号>`とする。Milestoneが一つ終わるたびに2番目の数字を上げる。R2は`0.2.0`である。同じMilestoneの中で緊急の修正だけを出すときは、3番目の数字を上げる。
- `1.0.0`は、保存データの形式が安定したとユーザーが判断したときにする。それまでは`0.`で始め、仕様の変更で互換性が変わることがある。
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

- ChatGPT Sites：クラウドモードの認証と保存先。コード・画面・文書に記載してよい。
- Claude・Codex：開発の作業手順と担当。AGENTS.md・CLAUDE.md・README・ブランチ名・テストの担当者名に記載してよい。

公開版は整理後のファイルから履歴を引き継がずに作成し、最初のコミットに個人の氏名・メールアドレスを含めない。
公開前に、新しいrepositoryの全ファイルと履歴を再確認する。
