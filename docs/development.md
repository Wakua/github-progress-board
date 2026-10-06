# 開発と検証

## クラウド共有保存の実装と確認範囲

既存の画面をWorkerに載せ、同じSites認証ユーザーのデータをD1の`DB` bindingに保存する構造を追加した。
全プロジェクトの所属と参照を検証し、サーバーの保存確認後に画面を更新する。

古い端末の上書き、アカウント変更、通信失敗、破損では編集を停止し、変更候補と未保存入力を退避できる。

初回は空であり、既存ブラウザ保存やサンプル記録を自動投入しない。

既存データの移行は、移行元のバックアップ保存、project ID・repository URLのpreview、明示確認を経て新規プロジェクトを追加する。
同一IDの異なる内容は全件拒否し、原本や既存のクラウド計画を上書きしない。

表示中のプロジェクトだけは端末ごとの設定として保持する。

`npm run build`はクラウド用の`dist/client`と`dist/server`を生成する。
実行時依存は追加せず、ビルド・schema生成用の開発依存を3件に限定した。

`npm run preview:cloud`はloopback専用の隔離QAであり、実際のSites認証やD1を利用しない。

クラウドでは、[用意済み記録の初回取込](prepared-workspace.md)、[仮見積の登録](estimate-proposals.md)、[本人限定MCP](sites-mcp.md)を使う。
作業行には[完了条件達成率](progress-visibility.md)を表示する。

これらは明示操作で保存し、同梱のサンプル記録や進捗案を自動投入しない。

検証はGitHubソースと隔離QAについての確認である。
本番の認証、永続D1、実端末共有、公開Site全体との一致は未確認である。
公開前の条件は[反映前の検証](cloud-release-verification.md)を参照する。

- 操作・保存範囲・安全性・公開準備：[docs/cloud-workspace.md](cloud-workspace.md)
- 用意済み記録の取込用JSON（架空のサンプル）：[samples/prepared-workspace.json](../samples/prepared-workspace.json)

## データ構造とsnapshot

`dist/workspace.mjs`が登録、projectIdによる境界、検証、保存を担当し、`dist/engine.mjs`は一つのプロジェクトの表示判断と集計を担当する。

UIは表示対象のプロジェクトを明示して変更候補を作る。
プロジェクト間を切り替えると詳細と展開状態を閉じ、前の画面からの編集を持ち越さない。

保存キーは`progress-tool.workspace.v1`、直前バックアップは`.backup`、破損原本の退避は`.recovery`である。

最上位は`schemaVersion`、`selectedProjectId`、`projects`を持つ。
各projectは`id`、`name`、`repositoryUrl`、`data`を持ち、dataの目標・作業等は既存の集計処理で扱える形を維持する。

Issueの出典識別にはprojectId、repository URL、entityId、Issue番号の組を使う。

各projectは任意の`githubSnapshot`を持つ。
`data`は手動計画、`githubSnapshot`はGitHubの状態であり、取込時に変換・統合しない。
既存v1データは移行せず読み込める。

snapshotにはprojectId、repository URL、取得日時、全ページの取得元URL、Issue/PRの種類・番号・URL・タイトル・状態・GitHub更新日時を保持する。
PRにはDraft・merge日時も保持する。

識別はrepository URL（大文字小文字を同一視）・種類・番号の組で行う。

`dist/github-snapshot.mjs`が検証・REST adapter・古さの表示を担当する。
Issue/PRのOpen・Closed・Merged・Draftを表示するが、手動の作業状態、完了条件、受入完了へ写さない。
Issue・PRの基本項目の見積・期限はnullを保持する。

任意の`planning`に親子Issue、Milestone、Projectの「担当」「Iteration」「Estimate」「Status」と、Issueの依存関係（blocked by）・紐づく開いたPR・`仕様` ラベルを保持する。

`dist/github-planning.mjs`が検証と集計、`dist/github-planning-view.mjs`が読み取り専用表示を担当する。
planningを含まない既存snapshotも読み込める。

Issue本文、コメント、CI、レビュー、完了条件は取得しない。

## 起動と検証

Node.jsを用意し、このフォルダで `npm start` を実行する。
外部パッケージのインストールは不要で、Node.js v24.19.0で動作を確認している。

ブラウザで <http://127.0.0.1:4319/> を開く。
`PORT` 環境変数でポートを変えられる。
ブラウザの保存領域はポートごとに分かれるため、別のポートでは保存したデータが見えない。

ブラウザ検証は `QA_BASE_URL` で接続先を指定する。

```sh
# bash・Git Bash
PORT=4320 npm start
```

```powershell
# PowerShell
$env:PORT = '4320'; npm start
```

PowerShellで設定した `$env:PORT` は、そのウィンドウを閉じるまで残る。
4319に戻すときは `Remove-Item Env:PORT` を実行する。

`npm test` は表示判断と保存・分離・復旧・snapshot・ローカルgh・共有保存のテストを実行する。
共有SQLの試験はNodeのSQLiteを使う。
`npm run check` はJavaScriptの構文を検査する。

`dist/` は手書きのアプリ本体、`tests/` は表示判断のテスト、`samples/` は架空のサンプル記録を持つ。
観察資料（`references/`）はGit管理しない。

## 実装状況

複数プロジェクトの登録・切替、目標・作業の追加、依存・条件・証拠・待ち・Estimate・担当・状態の編集、ブラウザ保存、JSON書出し、破損検出と明示復旧、読み取り専用GitHub snapshotの検証付き取込・更新・表示、ローカルghによる設定したrepositoryの自動取得と、親子Issue・Milestone・Projectからの目標・作業・期間・リリース表示を実装済みである。

既存の親子Issue集計とイテレーション表示は選択したプロジェクト内で利用する。
自分の作業のタブ、担当者の絞り込み、要対応と前提待ちの分類を実装済みである。

GitHubの作業にも同じ分類を使い、依存関係・紐づくPR・`仕様` ラベルを取得する。

Nodeテスト、構文チェック、`npm start`による起動、クラウド環境のChromiumでの操作検証を実施した。
サンプルデータの表示確認と、破損・失敗を起こすQA用fixtureを区別する。
どちらも専用の一時ブラウザコンテキストで行い、利用者の保存領域を変更しない。

ブラウザ検証は起動済みサーバーに対して`npm run test:browser`を実行する。
ローカルアプリの起動に外部パッケージは不要。

単体テストのMCP出力契約はPythonのjsonschemaを使う。

任意のブラウザ検証には環境が提供するPlaywrightとChromiumを利用する。
Playwrightのモジュールとブラウザの場所は環境変数で指定できる。

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chromium npm run test:browser
```

登録・保存とsnapshotの検証結果・画面は、既定で`/tmp/progress-tool-browser-qa/`に保存する。
イテレーションの検証は、OSの一時領域に実行ごとのフォルダーを作って保存する。

`QA_ARTIFACT_DIR`で保存先を指定できる。

クラウド用のビルドと隔離QAは`npm ci`後に実行する。
`npm run build`、`npm run test:cloud:browser`を使う。

初回取込は`npm run test:prepared:browser`、仮見積は`npm run test:estimates:browser`で操作検証する。
各結果の保存先は`PREPARED_QA_ARTIFACT_DIR`と`ESTIMATE_QA_ARTIFACT_DIR`で指定できる。

共有保存の結果と画面は`/tmp/progress-tool-cloud-browser-qa/`へ保存し、`CLOUD_QA_ARTIFACT_DIR`で変更できる。
本番認証・D1・公開の確認とは分ける。

## 未実装・未決定事項

- 双方向同期は未実装である。
  認証別サーバー保存・複数端末共有はソースと隔離QAまで確認する。
- プロジェクト名・repository URLの変更や削除、イテレーションの新規登録、親子Issueの構造編集は次の実装に分ける。
  初回に期間を補わず、期限未設定を保持する。
- クラウドへのJSON追加はpreview・原本バックアップ・明示確認を経る新規projectの追加に対応する。
  同一IDの異なる内容の統合・更新は未実装である。

  ローカルモードの手動計画JSON読込は保存破損時の検証付き復旧に限定する。
  GitHub snapshotは別領域への取込に対応する。
- GitHubで計画しているプロジェクトはGitHubの作業を使い、手動計画は畳む（採用済み）。
  同じプロジェクトにある手動計画とGitHubの作業の統合・移行、明示された完了条件の取得は未決定である。

  snapshotの出典・取得日時・分離規則は上記の採用済み仕様に従う。
- 子Issueを持つIssue自身に独立した作業量がある場合は、作業Issueへ分ける運用か、別の集計規則を採用するかを接続前に決定する。

## 参考

- [Asanaのプロジェクト表示](https://asana.com/features/project-management/project-views)：作業名と属性を列でそろえる一覧。
- [Linearの表示設定](https://linear.app/docs/display-options)：一覧の属性表示と、対象から詳細を開く構成。
- [GitHub Projectsの表示](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project)：テーブル形式による項目の表示。

## 公開対象

公開対象の文書・ソース・テスト・サンプルには、実際の活動を推測できるプロジェクト名、利用製品、制作内容、作業計画、公開サイトのURL、非公開repositoryの参照を含めない。
サンプルは実際の活動と無関係な題材で作る。

次の利用製品は例外として記載する（2026-10-05 ユーザー決定）。

- ChatGPT Sites：クラウドモードの認証と保存先。
  コード・画面・文書に記載してよい。
  公開サイトのURLは含めない。
- Claude・Codex：開発の作業手順と担当。
  AGENTS.md・CLAUDE.md・README・ブランチ名・テストの担当者名に記載してよい。

公開版は整理後のファイルから履歴を引き継がずに作成し、最初のコミットに個人の氏名・メールアドレスを含めない。
公開前に、新しいrepositoryの全ファイルと履歴を再確認する。
