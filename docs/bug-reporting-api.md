# バグ報告API

`/api/bugs/` のAPIはこのPCで共通の利用者として使い、APIキーとセッションCookieを必要としない。接続と保存の条件は[運用仕様](bug-reporting.md)に従う。

## 操作

| Method | パス（/api/bugs/以下） | 内容 |
| --- | --- | --- |
| GET | me | 共通利用者のID・名前・role・shared、容量設定、GitHub接続情報 |
| GET | reports | 全報告の一覧 |
| POST | reports | JSONで報告を作成する |
| GET | reports/:reportId | 本文、添付情報、対応状況と確認履歴 |
| POST | reports/:reportId/status | 対応状況を次の段階へ進める |
| POST | reports/:reportId/confirmations | 修正版の確認結果を保存する |
| GET | uploads | 全確定済み・未登録データの情報 |
| POST | uploads | 新しい報告へ付ける再現データを保存する |
| POST | reports/:reportId/attachments | 既存報告に再現データを追加する |
| GET / HEAD | reports/:reportId/attachments/:fileId | ファイル本体を取得する |

共通利用者のIDはlocal-shared、名前は「共通の利用者」である。互換性のためroleはadmin、共通利用を示すsharedはtrueとする。報告、再現データ、状況と確認結果を同じ利用者で扱い、要求の報告者IDや認証ヘッダーでは利用者を変更しない。

APIは127.0.0.1宛てHostを確認し、Originがある場合は同一オリジンに限る。以前のsession作成・終了APIは廃止し、404を返す。

## 報告のJSON

| フィールド | 内容 |
| --- | --- |
| body | 空白だけではない報告文。256,000文字以内 |
| reportedVersion | バージョンの文字列。任意、未記入は空文字。200文字以内 |
| requestId | 再送しても変えない受付キー。英数字・ハイフン・アンダースコア、1〜80文字 |
| uploadIds | 確定した未登録データの内部IDの配列。添付なしは空配列 |

JSONの要求は `Content-Type: application/json` を使い、最大2MiBまで受ける。成功時は201と `{report: ...}` を返す。同じ受付キーで異なる内容を送ると409になる。報告者は共通利用者に固定する。

## 再現データの要求

ファイル一件のバイト列を要求本体へ送る。multipartとJSONへの埋め込みは使わない。

| ヘッダー | 内容 |
| --- | --- |
| Content-Length | バイト数。必須 |
| Content-Type | application/octet-stream |
| X-File-Name | 元のファイル名をencodeURIComponentと同じ方式で符号化する。名前は240文字以内で、制御文字・スラッシュ・バックスラッシュを含めない |
| X-File-Type | 元の種類。任意、160文字以内で制御文字を含めない |

成功時は201と `{attachment: ...}` を返す。attachmentはID、名前、容量、種類、SHA-256、保存状態を持つ。受信した容量が一致しなければ確定しない。保存したファイルは、取得APIからattachmentとして配信する。

初回送信で応答が途切れた場合は、`GET uploads` で未登録データを確認してから報告へ関連付ける。受付後の追加で応答が途切れた場合は、報告詳細を確認する。ファイル追加そのものに重複排除キーは持たせていないため、結果を確認せずに同じファイルを再送しない。

## 対応状況と確認

更新の順序と、対象版による状態の変更は[確認の仕様](bug-reporting.md#修正後の確認)に従う。両方のPOSTは、次の共通フィールドを使う。

| フィールド | 内容 |
| --- | --- |
| revision | 報告自身の現在の更新番号。正の整数 |
| requestId | 同じ要求の再送に使うキー。形式は報告のJSONと同じ |

POST reports/:reportId/statusはtargetVersionとdeveloperNoteを文字列で送る。targetVersionは確認対象の版で、確認待ちへ進めるときに必須である。developerNoteは開発側からの連絡で、任意の場合は空文字を使う。成功時は200と {report: ...} を返す。

POST reports/:reportId/confirmationsはversion、result、noteを送る。versionは実際に確認した版で必須、resultはresolved（直った）かunresolved（まだ起きる）、noteは任意の確認内容である。成功時は200と {report: ..., matchesTarget: 真偽値, confirmationId: 履歴ID} を返す。

targetVersionとversionの長さは、報告のreportedVersionと同じ上限である。developerNoteとnoteは4,000文字以内とする。文字列の前後の空白は保存前に除く。

同じ利用者が同じ報告に同じrequestIdと内容を再送すると、元の更新を再実行せずに現在の報告を返す。確認のmatchesTargetとconfirmationIdは元の結果を返す。同じキーで内容を変えると409になる。異なる要求の更新番号が古い場合も409を返す。状態と履歴の保存に失敗した場合は両方を巻き戻す。

報告の一覧・詳細はstatus、targetVersion、developerNote、isOwnを持つ。isOwnは報告者IDと共通利用者のIDが同じ場合にtrueとなる。以前の報告はfalseでも追加と確認を行える。詳細のhistoryは更新順の配列で、id、kind（statusまたはconfirmation）、fromStatus、toStatus、targetVersion、version、result、matchesTarget、note、at、actorNameを持つ。状態更新のversion、result、matchesTargetはnullである。confirmationsはhistoryのうち確認結果だけを返す。

## GitHub管理

GitHub管理の操作も共通の利用者で行う。許可されたGitHub操作の範囲は[運用仕様](bug-reporting.md#github登録)に従う。

| POSTパス（/api/bugs/以下） | JSONの要求 | 内容 |
| --- | --- | --- |
| reports/:reportId/github/register | {} | 接続前の報告または確定した登録失敗を登録待ちへ戻す |
| reports/:reportId/github/reconcile | {} | 結果未確認の報告を既存Issueと照合する |
| reports/:reportId/github/retry | confirmNoIssue: true、revision: 照合結果の更新番号 | 最新の該当なし結果を確認し、登録待ちへ戻す |
| reports/:reportId/github/tags | {} | 登録済みIssueのタグを再取得する |

成功時は200と `{report: ...}` を返す。接続が無効なら503、指定外の接続元は403、対象状態や照合結果が古い場合は409、利用制限の待機中は429を返す。タグの取得失敗は報告内のタグ取得状態に記録し、Issue登録済みの関連は保持する。

## 登録情報のJSON

`GET me` のgithubはenabledとrepositoryを返す。登録先を設定していない場合はenabledがfalse、repositoryがnullとなる。報告の一覧・詳細のgithubは、次の情報を持つ。

| フィールド | 内容 |
| --- | --- |
| state | pending、creating、registered、failed、unknown |
| repository | 記録した接続先。接続前の報告はnull |
| number / url | 登録したIssue番号とURL。未登録はnull |
| error / retryAt | 登録のエラーと自動再試行時刻。時刻はUnixミリ秒 |
| revision | 登録情報の更新番号。再試行の競合検査に使う |
| tags | state（unfetched、ok、error）、labels（id・name・colorの配列）、fetchedAt（成功した取得日時）、error |
| checkedAt / candidates | 照合時刻（Unixミリ秒）と候補のnumber・url。照合していなければnull |

ticketStateはgithub.stateと同じ値である。報告自身のrevisionとupdatedAtは、登録状況やタグの取得だけでは変更しない。未取得、空の取得結果、取得失敗の表示条件は[タグの仕様](bug-reporting.md#タグの表示と取得)に従う。

## PowerShellの例

接続先のポートは起動したサーバーに合わせる。認証ヘッダーは不要である。

```powershell
$bugBase = 'http://127.0.0.1:4327/api/bugs'
Invoke-RestMethod -Uri "$bugBase/me"

$bugFile = (Resolve-Path -LiteralPath './reproduction.dat').Path
$bugUploadHeaders = @{
  'X-File-Name' = [Uri]::EscapeDataString([IO.Path]::GetFileName($bugFile))
}
$bugUpload = Invoke-RestMethod -Uri "$bugBase/uploads" -Method Post -Headers $bugUploadHeaders -ContentType 'application/octet-stream' -InFile $bugFile
$bugReportRequest = @{
  body = '架空の予約一覧が更新されない。再現手順を記入する。'
  reportedVersion = ''
  requestId = [guid]::NewGuid().ToString()
  uploadIds = @($bugUpload.attachment.id)
}
$bugSaved = Invoke-RestMethod -Uri "$bugBase/reports" -Method Post -ContentType 'application/json; charset=utf-8' -Body ($bugReportRequest | ConvertTo-Json)
$bugSaved.report
```

報告要求の応答が途切れた場合は、同じ `$bugReportRequest` を保持して再送する。新しいrequestIdに置き換えない。本文を変更する前に、元の要求の保存結果を確認する。

## エラー

| Status | 判断 |
| --- | --- |
| 400 / 411 / 415 | 本文、ファイル情報、容量指定、形式を確認する |
| 403 | 接続元を確認する |
| 404 | 報告と添付のIDを確認する |
| 409 | 受付キーの内容、更新番号と対象状態、添付の保存状態、ディスク上のファイルを確認する |
| 413 | 容量または件数を減らす |
| 429 | GitHubの利用制限が解除されるまで待つ |
| 503 | 初期設定か保存処理の失敗。既存の報告を保持し、入力と保存結果を確認して再試行する |

送信やダウンロードが途中で切れた場合は、HTTPの成功結果として扱わない。受け取ったデータの容量とSHA-256を添付情報と照合できる。

## 履歴

- 2026-10-05: 公開版の共通利用と、設定したGitHub登録先への操作を記載した。
