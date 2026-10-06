# GitHub snapshotの二経路更新

## 取得と対象

手元では[ローカルghの自動取得](github-integration.md#ローカルのghで自動取得する)を使う。
Hosted MCPでは認証済みGitHub connectorで全ページを取得し、共通builderで作ったsnapshotをpreview・apply・readで扱う。
SiteにGitHub tokenやgh実行を持ち込まない。

MCPの対象はproject IDがprogress-board、repository URLがhttps://github.com/Wakua/github-progress-boardの既存プロジェクトに限る。
snapshotの構造と取得規則は[snapshot仕様](specification.md#採用済み仕様読み取り専用github-snapshot)に従う。
Hostedの入力にはProjectのcustom担当、決定者、Milestone、Issue本文を含めない。
mainの経路で計画情報付きsnapshotが保存されている場合は、その情報を読取結果に保持する。
限定MCPによる更新は停止し、計画情報を消さない。

呼出し側は全ページを読んだ結果を送る。
サーバーの検証範囲は[snapshot仕様](specification.md#採用済み仕様読み取り専用github-snapshot)に従う。
入力は500件および[MCPのRPC上限](sites-mcp.md#契約と保存)に収める。
超過時に分割更新や欠落を成功扱いしない。

## 保存

読取結果は保存時のrepository表記を保持し、同一repositoryを表す大文字・小文字の違いを出力契約でも許容する。入力で指定する固定repositoryの条件は変えない。

固定repository・projectの条件を、共通のsnapshot検証に追加する。
旧snapshotの番号が欠落する更新は、自動削除せず停止する。
previewとapplyは[本人限定MCPの保存契約](sites-mcp.md#契約と保存)を使う。

対象snapshot以外の保持条件は[snapshot仕様](specification.md#採用済み仕様読み取り専用github-snapshot)、再送は[MCPの保存契約](sites-mcp.md#契約と保存)に従う。

## 検証と定期実行

定期実行の設定は、取得経路の実装と別に行う。
