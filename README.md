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
変更前に、[ローカル保存の範囲](docs/specification.md#保存の範囲)を確認する。

```sh
# bash・Git Bash
PORT=4320 npm start
```

```powershell
# PowerShell
$env:PORT = '4320'; npm start
```

PowerShellの環境変数は、そのウィンドウを閉じるまで残る。
既定のポートに戻すときは `Remove-Item Env:PORT` を実行する。

検証には次のコマンドを使う。
各検証の対象、ブラウザ検証、クラウド用ビルドは[開発と検証](docs/development.md#検証手順)を参照する。

```sh
npm test
npm run check
```

## 使い方と仕様

最初の登録は[プロジェクトの登録](docs/usage.md#プロジェクトの登録)から始める。
利用前に[ローカル保存の範囲](docs/specification.md#保存の範囲)を確認する。

| 文書 | 内容 |
| --- | --- |
| [進捗管理の仕様](docs/specification.md) | 作業の分類、集計、期限、保存とGitHub snapshotの規則 |
| [操作の説明](docs/usage.md) | 画面の構成と詳しい操作 |
| [GitHub snapshotの取得](docs/github-integration.md) | 自動取得の設定、JSONでの再取得と取込 |
| [利用場面](docs/use-cases.md) | ツールが助ける場面と画面の対応 |
| [開発と検証](docs/development.md) | 内部構造、ビルドと検証、実装状況、バージョン、公開対象 |
| [クラウド共有保存](docs/cloud-workspace.md) | 認証、端末間の共有、移行と障害時の操作 |
| [クラウドの本番確認](docs/cloud-release-verification.md#本番で残る確認) | 公開前に必要な確認と未確認事項 |
| [バグ報告](docs/bug-reporting.md) | 報告の初期設定、GitHub登録、修正版の確認 |

## ライセンス

[MIT License](LICENSE)
