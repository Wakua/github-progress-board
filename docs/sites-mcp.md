# 本人限定SiteのMCP

## 経路と認証

同じ本人限定Siteの/mcpへ、statelessなJSONのMCP要求を送る。Sites dispatchが付与する本人IDを保存先に使い、呼出し引数のuser ID・email・account UUIDを受け付けない。認証の前提と配布境界は[共有保存](cloud-workspace.md#採用済み仕様)に従う。

initialize、tools/list、pingは固定protocol metadataを返す。データを扱うtools/callは認証IDがなければHTTP401となる。Originがある要求は同一originに限り、cross-site・same-siteのブラウザ要求を拒否する。CORSや独自credentialは追加しない。

## 操作

| ツール | 動作 |
| --- | --- |
| read_progress | 本人workspaceのversion、プロジェクト概要、上限付きの作業ページを読む |
| preview_estimates / apply_estimates | [固定仮見積](estimate-proposals.md)を確認し、一致する未入力見積へ適用する |
| preview_progress_update / apply_progress_update | [証拠付きの固定記録](progress-record-update.md)を確認し、限定された既存作業へ適用する |
| read_github_facts / preview_github_facts / apply_github_facts | [固定repositoryのsnapshot](github-facts-sync.md)を読み、更新を確認して保存する |

任意のworkspace置換、作業追加・削除、SQL、ファイルupload、コード実行、外部URLへの要求、credential操作は提供しない。記録中の文字列は信用しないデータとして扱う。

## 契約と保存

すべてのツールにinputSchemaとoutputSchemaを定義する。未知入力を拒否し、成功時はstructuredContentと同じJSONのtextを返す。見積の再送・変更なしの結果も宣言した出力に合わせる。

previewは保存せず、本人ID・version・対象差分に結び付いたdigestとoperation IDを返す。applyは最新保存と再照合し、[共有保存のCASと履歴](cloud-workspace.md#採用済み仕様)を使う。同じ操作の再送は保存済みheadと対象の記録を照合し、版を増やさず結果を返す。別更新や異なる差分があれば停止する。

RPCの入力は64KiB、結果は500,000文字を上限とする。read_progressは既定25・最大50作業を返す。GET/SSEとDELETE/sessionは405とし、session tokenを作らない。対応protocol versionはserver/mcp.mjsで定義する。

診断ログはmethod、protocol、HTTP status、結果区分、RPCエラーcodeに限定する。本人ID、引数、結果本文、保存内容、credentialを記録しない。

## 接続と検証範囲

既存SiteのMCP capabilityは公開担当が管理する。ローカル統合でhosting manifest、Site identity、OAuthや公開範囲を変更しない。
