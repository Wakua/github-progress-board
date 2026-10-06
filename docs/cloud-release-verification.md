# 既存Siteへ反映する前の検証

## 対象と基準

公開担当は、既存本人限定Siteの認証、保存データ、公開設定と対象版を確認する。
採用済みの認証・保存条件は[共有保存の仕様](cloud-workspace.md#採用済み仕様)、MCPの契約は[本人限定MCP](sites-mcp.md)を基準にする。
公開Site全体、公開専用hosting manifest、packagerの実設定とGitHubソースの一致は未確認である。
公開版をGitHub headで一括置換する前に、公開差分を照合する。

開発中のため、移行・旧版へのrollback確認は必須条件から外す。
既存の公開設定・保存内容は維持し、データを消して旧形式へ合わせる操作は行わない。
復旧が必要になった場合は[復旧条件](#復旧条件)を使う。

## 本番で残る確認

次の実環境の操作は未確認である。
[隔離QA](development.md#クラウドのビルドと隔離qa)の成功とは分けて確認する。
実環境で使えない経路や未実施の操作は、未確認として残す。

| 対象 | 読取と管理情報による確認 | 書込や対応環境が必要な確認 |
| --- | --- | --- |
| 認証と配布 | 共有保存の認証境界が実packager・dispatchでも維持されているか | 模擬cookieでは実環境の境界を証明できない |
| D1 | 既存workspace・backupの整合、現行bindingと適用済みschema | 新規保存、競合・障害、deployをまたぐ保持 |
| 実端末 | 同じownerの実PC・スマートフォンで既存計画を再読込し、ID・versionと内容を比較 | 端末間の新規保存と通信断 |
| MCP | 公開カタログ、本人読取、出力契約と保存内容の一致 | preview/apply、OAuth、再送と競合 |
| native WebMCP | 対応ブラウザの登録・読取結果と画面の保存済み状態を比較 | mockや通常Chromeの成功をnative実行成功にしない |

## 読取確認の手順

1. 進行中のPRのheadと状態、Siteのproject ID・audience・owner・現行deployment・saved versionを正規の管理ツールで読み直す。最新saved versionを現行公開版と決めつけない。
2. ownerの通常セッションで既存workspaceを読めることを確認する。
匿名・架空の同名user headerでは画面、実asset、workspace、backupを読めないこと、外部の認証ヘッダーがdispatchで破棄・置換され、別ユーザーへ上書きできないことを確認する。
他人の実IDは使わない。
3. buildの認証先行・直接入口を作らない設定が実packagerに保持され、dispatchを迂回する直接Worker入口が公開されていないことを確認する。既知の入口だけを扱い、URLを推測して走査しない。
4. version、schema、project/task ID、head/chunkとdigestを本人の保護された手元で比較する。
原本や認証情報の扱いは[公開対象](development.md#公開対象)に従い、cookie・tokenも公開記録へ載せない。
5. 既知のMCP読取を実行し、カタログのoutputSchemaと返却内容を照合する。固定案の適用条件は[進捗記録の更新](progress-record-update.md#固定案)に従う。

本番のPUT、編集・移行・apply、DB変更、設定変更は、書込対象を確定した別作業として扱う。
書込でしか確認できない項目の受入方法は未決定である。

## 復旧条件

コードの戻し先は、公開差分を含む現在の安定saved versionとする。
archive、source commit、同じproject・audience・D1 resourceを確認し、戻し先が現在の保存形式とMCP契約を扱えることを確認する。
過去のPRや現在のGitHub headを公開版の代用にしない。

コードの再deployとD1の復元は別操作である。
コードを戻してもデータを戻したとは扱わない。
保存内容の形式・schema・bindingが変わる場合は、旧コードだけで安全に復旧できると判断しない。
保存基盤の履歴保持は[共有保存の仕様](cloud-workspace.md#採用済み仕様)を参照し、DB全体の復元保証として扱わない。

データ復元が必要なら、対象resource、復旧時点、失われる更新、退避した候補、schema互換性、正規の実行権限を確定する。
独自credentialの追加、復元の試行、rawデータの本番importは、通常の読取確認に含めない。
