# github-progress-board

複数プロジェクトの次の作業・要対応・確認待ちを把握する進捗管理ツール。
手動の計画と、GitHubから取得したIssue・PRの情報を確認できる。

## 起動と検証

Node.jsを用意し、このフォルダーで次を実行する。
ローカル起動に外部パッケージのインストールは不要で、Node.js v24.19.0で動作を確認している。

```sh
npm start
```

ブラウザで <http://127.0.0.1:4319/> を開く。
ポートを変える場合は、起動前に `PORT` を指定する。

```sh
# bash・Git Bash
PORT=4320 npm start
```

```powershell
# PowerShell
$env:PORT = '4320'; npm start
```

検証には次のコマンドを使う。
ブラウザ検証とクラウド用ビルドの手順は[開発と検証](docs/development.md#実装状況)を参照する。

```sh
npm test
npm run check
```

## 基本の操作

1. 「登録・取込」からプロジェクトを登録する。名前と任意のGitHub repository URLを入力する。
2. プロジェクトを開き、「自分の作業」「イテレーション」「要対応」で作業を確認する。GitHubで計画しているプロジェクトでは「リリース」も使える。
3. 手動計画の目標・作業は「登録・取込」で追加し、作業名から開く詳細で担当・見積・完了条件などを編集する。
4. 必要なデータは「データを書き出す」で保存する。

詳しい画面構成と操作は[操作の説明](docs/usage.md)を参照する。

## GitHubからの取得

既存の認証済み `gh` とNode.jsが同じ環境にある場合は、自動取得するrepositoryを `PROGRESS_GITHUB_REPOS` に指定して起動する。
指定したrepositoryのURLをプロジェクトに登録すると、Issue・PRとGitHubの計画を取得できる。

```sh
# bash・Git Bash
PROGRESS_GITHUB_REPOS=owner/repo-a,owner/repo-b npm start
```

```powershell
# PowerShell
$env:PROGRESS_GITHUB_REPOS = 'owner/repo-a,owner/repo-b'; npm start
```

GitHubの情報は読み取り専用である。
JSONによる手動取込と、取得の条件・上限は[GitHub snapshotの取得](docs/github-integration.md)を参照する。

## バグ報告

このPCに接続できる利用者が、共通の利用者として報告と再現データを扱うローカル機能を持つ。
初期設定、GitHubへの登録範囲、修正版の確認は[バグ報告の仕様と運用](docs/bug-reporting.md)を参照する。

## 保存と利用上の制約

- ローカルモードのデータは、同じブラウザ・同じURLの保存領域に保存する。
  別ブラウザ・別端末とは共有しない。ブラウザのデータ削除で失われるため、必要なデータは書き出す。
- 初回は空の一覧を表示する。架空のサンプルを自動投入しない。
- クラウド共有保存は、ソースと隔離QAまで確認している。
  本番の認証、永続D1、実端末共有、公開Site全体との一致は未確認である。
  詳細は[クラウド共有保存の確認範囲](docs/development.md#クラウド共有保存の実装と確認範囲)を参照する。

## 詳しい説明

| 文書 | 内容 |
| --- | --- |
| [進捗管理の仕様](docs/specification.md) | 作業の分類、集計、期限、保存とGitHub snapshotの規則 |
| [操作の説明](docs/usage.md) | 画面の構成と詳しい操作 |
| [GitHub snapshotの取得](docs/github-integration.md) | 自動取得の設定、JSONでの再取得と取込 |
| [利用場面](docs/use-cases.md) | ツールが助ける場面と画面の対応 |
| [開発と検証](docs/development.md) | 内部構造、ビルドと検証、実装状況、バージョン、公開対象 |

## ライセンス

[MIT License](LICENSE)
