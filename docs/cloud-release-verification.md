# 既存Siteへ反映する前の検証

## 対象と基準

既存本人限定Siteへ反映する前に、公開担当が認証、保存データ、公開設定と対象版を確認する。PR4担当はmainとの統合と隔離QAを担当する。今回の作業範囲はPR4の更新までであり、マージ、公開、本番データと認証設定の変更を含まない。

開発中のため移行・旧版互換性を気にしなくてよいというユーザー指示に従い、移行と旧版へのrollback確認はPR4整理の必須条件から外す。下記の復旧条件は、将来復旧が必要になったときの区別を残すものである。既存の公開設定・保存内容は維持し、今回の作業でデータを消して旧形式へ合わせる操作は行わない。

進行中のPRの機能を先取りせず、作業開始・反映前にheadと状態を読み直す。

7パッチの機能は個別統合している。公開Site全体、公開専用hosting manifest、packagerの実設定との一致は未確認である。公開版の認証・MCP・原本配布をPR4のソースで一括置換しない。

## 本番で残る確認

| 対象 | 読取と管理情報で確認する内容 | 読取だけでは確認できない内容 |
| --- | --- | --- |
| 認証と配布 | owner限定のaudience、匿名の画面・JS・同梱JSON・API拒否、dispatchによる偽造headerの破棄・置換、直接Worker入口の非公開 | packagerとdispatchの実動作を模擬cookieの成功で証明しない |
| D1 | 既存workspace・backupの整合、現行bindingと適用済みschema | 実D1の新規保存、競合・障害、deployをまたぐ保持 |
| 実端末 | 同じownerの実PC・スマートフォンで既存計画を再読込し、ID・versionと内容を比較 | 実端末間の新規保存と通信断 |
| MCP | 公開カタログ、既知の本人読取、出力契約と保存内容の一致 | 本番preview/apply、OAuth、再送と競合 |
| native WebMCP | 対応ブラウザの登録・読取結果と画面の保存済み状態を比較 | mockや通常Chromeの成功をnative実行成功にしない |

隔離QAの結果と本番の結果は分けて記録する。実環境で使えない経路や未実施の操作は未確認として残す。

## 読取確認の手順

1. 既存Siteのproject ID、audience、owner、現行deployment、saved versionを正規の管理ツールで読み直す。最新saved versionを現行公開版と決めつけない。
2. ownerの通常セッションで既存workspaceを読めることを確認する。匿名・架空の同名user headerでは保護された画面、実asset、workspace、backupを読めないことを確認する。他人の実IDは使わない。
3. buildの認証先行・直接入口を作らない設定が実packagerに保持されていることを確認する。既知の入口だけを扱い、URLを推測して走査しない。
4. version、schema、project/task ID、head/chunkとdigestを本人の保護された手元で比較する。workspace原本、credential、cookie、tokenをGitHubや公開QA記録へ載せない。
5. 既知のMCP読取を実行し、カタログのoutputSchemaと返却内容を照合する。固定進捗案は過去時点の証拠であり、現在のPRと人間判断を再確認せず適用しない。

本番のPUT、編集・移行・apply、DB変更、設定変更は、書込対象を確定した別作業として扱う。

## 復旧条件

コードの戻し先は、公開差分を含む現在の安定saved versionとする。archive、source commit、同じproject・audience・D1 resourceを確認し、戻し先が現在の保存形式とMCP契約を扱えることを確認する。元PR4や現在のGitHub headを公開版の代用にしない。

コードの再deployとD1の復元は別操作である。コードを戻してもデータを戻したとは扱わない。保存内容の形式・schema・bindingが変わる場合は、旧コードだけで安全に復旧できると判断しない。保存基盤の履歴保持は[共有保存の仕様](cloud-workspace.md#採用済み仕様)を参照し、DB全体の復元保証として扱わない。

データ復元が必要なら、対象resource、復旧時点、失われる更新、退避した候補、schema互換性、正規の実行権限を確定する。独自credentialの追加、復元の試行、rawデータの本番importは今回の範囲外である。

## 未決定事項

実環境の認証・D1・実端末・native WebMCP、hosting manifestと実設定の確認、書込でしか確認できない項目の受入方法が残る。公開担当の読取照合とPR4の隔離QAは区別して記録する。移行・旧版へのrollback確認は上記のユーザー指示により必須条件ではない。本作業はPR4のmain統合と検証までとし、本番反映を実施しない。
