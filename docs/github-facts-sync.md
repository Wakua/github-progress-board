# GitHub snapshotの二経路更新

## 取得と対象

手元では[ローカルghの自動取得](github-integration.md#ローカルのghで自動取得する)を使う。Hosted MCPでは認証済みGitHub connectorで全ページを取得し、共通builderで作ったsnapshotをpreview・apply・readで扱う。SiteにGitHub tokenやgh実行を持ち込まない。

MCPの対象はproject IDがprogress-board、repository URLがhttps://github.com/Wakua/github-progress-boardの既存プロジェクトに限る。snapshotの構造と取得規則は[snapshot仕様](specification.md#採用済み仕様読み取り専用github-snapshot)に従う。Hostedの入力にはProjectのcustom担当、決定者、Milestone、Issue本文を含めない。mainの経路で計画情報付きsnapshotが保存されている場合は、その情報を読取結果に保持する。限定MCPによる更新は停止し、計画情報を消さない。

サーバーは受信データと全取得の申告を検証する。GitHubへ独立照会して取得の真正性を証明する機能はなく、呼出し側が全ページを読んだ結果だけを送る。入力は500件および[MCPのRPC上限](sites-mcp.md#契約と保存)に収める。超過時に分割更新や欠落を成功扱いしない。

## 保存

読取結果は保存時のrepository表記を保持し、同一repositoryを表す大文字・小文字の違いを出力契約でも許容する。入力で指定する固定repositoryの条件は変えない。

固定repository・project、schema、取得元URL、取得日時と個別更新日時を検証する。旧snapshotの番号が欠落する更新は、自動削除せず停止する。previewとapplyは[本人限定MCPの保存契約](sites-mcp.md#契約と保存)を使う。

手動計画、見積、条件、状態、依存、証拠、履歴、他プロジェクトを変更しない。Closedを手動作業の完了へ変換せず、新Issueも手動作業へ自動変換しない。正常な取得時刻の更新を保存し、同じ操作の再送は版を増やさない。

## 検証と定期実行

定期実行は別途設定する。本変更だけではHostedの定期更新は開始しない。
