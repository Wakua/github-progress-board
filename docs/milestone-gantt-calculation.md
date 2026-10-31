# マイルストーンの日程計算

計算処理、GitHub情報の取得、画面を担当する開発者向けに、[ガントチャートの要件](milestone-gantt.md)を関数の入出力と計算手順へ具体化する。
この文書で、取得する情報、計算できない範囲、画面へ渡す結果を照合できる。
対象は日程計算の内部契約であり、snapshotの保存形式、GitHubへの更新、画面構成は定めない。
動作・数値・条件は要件の参照先を正本とする。
対応する作業は [Issue #124](https://github.com/Wakua/github-progress-board/issues/124) で管理する。

## 要件との対応

| この文書で具体化する内容 | 採用済み要件の定義先 |
| --- | --- |
| 対象Issue、集約Issue、依存関係 | [計算する作業と依存関係](milestone-gantt.md#計算する作業と依存関係) |
| 完了判定、進捗率、残り作業量 | [作業進捗率](milestone-gantt.md#作業進捗率) |
| 基準日、開始条件、日数換算 | [基準日と平日](milestone-gantt.md#基準日と平日) |
| 最早・最遅日程、余裕、期日との差 | [クリティカルパスと余裕](milestone-gantt.md#クリティカルパスと余裕) |
| 担当の重複と確認範囲 | [担当の重複](milestone-gantt.md#担当の重複) |
| Projectの出典、取得範囲 | [正本と更新の範囲](milestone-gantt.md#正本と更新の範囲) |
| 情報不足、循環 | [情報不足と不整合](milestone-gantt.md#情報不足と不整合) |

## 関数の境界

`calculateMilestoneSchedule(input)` は、同じ入力に同じ結果を返す純粋関数とする。
`dist/milestone-schedule.mjs` から名前付きexportとして呼び出す。
基準日は引数から受け取り、DOM、通信、現在時刻の取得、保存を行わない。
入力も変更しない。

取得側のadapterが、検証済みのsnapshotと利用者が指定した出典Projectを入力へ変換する。
計算側はIssueの展開、日程、余裕、依存辺、担当重複、診断を返す。
画面側は結果を表示し、再取得や基準日の変更時に関数を呼び直す。
月・週・日への[表示単位の切替](milestone-gantt.md#時間軸の表示単位)は画面側で行い、この関数の計算結果を変更しない。
GitHubの作業分類と既存の集計値は計算結果で書き換えない。

この入力は関数間の内部データであり、snapshotへ同じ形を保存する提案ではない。
既存の `githubPlan`、`githubProgress`、`githubWorkCategory` の返却形式を変更する前提も置かない。

## 入力

### 識別子と取得結果

`IssueKey` はrepositoryを含むIssue URLを正規化した文字列とする。
番号だけをキーにせず、URLの比較規則は既存の[データ形式](development.md#データ形式)に合わせる。
`MilestoneKey` もrepositoryを含むMilestone URLを使う。

取得結果を表す `Read<T>` と一覧の `Links` は、次の意味で使う。

```ts
type ReadProblem = 'not-fetched' | 'forbidden' | 'failed';
type Read<T> = { value: T | null; problem: ReadProblem | null };
type Links = {
  keys: IssueKey[];
  totalCount: number | null;
  complete: boolean;
  problem: ReadProblem | null;
};
```

`Read` の `problem: null` は取得に成功したことを表す。
そのときの `value: null` は取得済みの空欄であり、未取得とは区別する。
取得できなかった値は `value: null` と原因を渡し、取得済みのように補わない。
入力できる値の範囲は要件の定義先に従い、取得に成功した不正値と取得失敗も区別する。

`Links` は確認できた参照先を残す。
`complete: true` の場合は件数と重複のない `keys` が一致し、取得失敗の原因を持たない。
末端Issueと確定できるのは、子の取得が完了し、その一覧が空の場合である。
取得できない参照先はキーを消さず、参照先の不足として計算側へ渡す。

### 最小の構造

```ts
type ScheduleInput = {
  baseDate: string;
  selectedProjectId: string;
  fetchedAt: string;
  milestones: {
    key: MilestoneKey;
    state: 'open' | 'closed';
    dueDate: string | null;
    tasks: Links;
  }[];
  issues: IssueInput[];
};

type IssueInput = {
  key: IssueKey;
  state: Read<'open' | 'closed'>;
  completion: {
    value: 'done' | 'not-done' | 'unknown';
    reasons: string[];
  };
  parent: Read<IssueKey>;
  children: Links;
  blockedBy: Links;
  planning: {
    sourceProjectId: string | null;
    sourceProblem: 'unselected' | 'not-member' | 'unavailable' | null;
    status: Read<string>;
    owner: Read<string>;
    estimatePoints: Read<number>;
    workProgressPercent: Read<number>;
    iteration: Read<{ startDate: string; endDate: string }>;
  };
};
```

`baseDate`、`dueDate`、Iterationの日付は、実在する日を表す `YYYY-MM-DD` 形式の文字列とする。
日時を日付へ変換する責務はadapterに置き、存在しない日や形式違反を別の日付へ補正しない。
`fetchedAt` は使用したsnapshotの取得日時であり、計算の基準日とは分ける。
Milestoneの `tasks` は、所属する末端Issueの一覧と取得完全性を表す。
Issueの表示名など、日程を決めない表示情報は画面側がキーから参照する。

`selectedProjectId` は担当重複を確認するProjectの範囲を示す。
各Issueの `sourceProjectId` は、そのIssueの日程に使うフィールドの出典を示す。
外部の前提にも出典を持たせ、複数Projectのフィールドを混ぜない。
候補が複数あって利用者の指定を特定できない場合は `unselected` とし、先頭のProjectを選ばない。
`sourceProblem` がある場合は、そのProjectの値を日程へ使わない。
日程フィールドを必要とする未完了作業は、出典が確定してから計算する。
既存分類で完了が確定した末端を、将来日程に不要な出典確認で止めない。

`completion` は、adapterが出典Projectへフィールドを絞る前に、[既存の作業分類](specification.md#githubから表示する計画)に従って求める完了判定である。
完了の分類なら `done`、完了以外の分類と確定できるなら `not-done` とする。
分類に必要なIssueの状態やProjectの一覧・Statusの取得が不足して判断できない場合は `unknown` とし、`reasons` に不足理由を残す。
既知の情報だけで完了が確定する場合は、判定に不要な取得不足で `unknown` にしない。
外部の前提にも同じ判定を渡す。
これは既存分類の結果の受渡しであり、日程に使う見積・担当・Iterationなどへ別Projectの値を混ぜるものではない。

子や前提だけでなく、対象作業の祖先と、各祖先に登録された前提も入力に含める。
親子関係をたどる途中の不足は、継承する前提が不明な原因になる。
必要な取得範囲を満たしたかは、一覧の空・非空だけで判断しない。

## 作業グラフへの変換

### 対象と集約Issueの展開

Milestoneの所属作業から、未完了の前提を再帰的にたどる。
作業の祖先に登録された前提もたどるが、祖先を参照しただけでは、その兄弟作業を計算対象へ加えない。
集約Issueそのものを前提として待つ場合に、その配下を末端まで展開する。

依存辺は前提から後続へ向ける。
元の `後続 X blocked by 前提 Y` に集約Issueが含まれる場合は、Y側の末端からX側の末端への辺に置き換える。
同じ末端への辺が複数経路から得られても、日程計算では一つの辺として扱う。
親子関係だけから兄弟同士を順序付ける辺は作らない。

集約Issue自身の状態と計画フィールドは、残量や日程へ使わない。
取得できた子の件数が不足する場合は、取得できた子だけで集約の完了を確定しない。
集約Issueと末端の判別ができない場合も、末端だと推定しない。

### 完了した作業と残量

末端Issueの完了判定には、adapterが渡した `completion` を使う。
計算側で `planning.status` や進捗率だけから完了を再判定しない。
`unknown` の場合は、記録された不足理由を診断とし、影響する後続の日程を確定しない。
完了と確定した作業は、将来の日程計算の前提待ちから外す。
その作業へ入る辺をたどって、完了前にあった待ちを復活させない。
完了済み作業の実際の着手・完了日時は推定しない。

未完了作業の残量は[作業進捗率の規則](milestone-gantt.md#作業進捗率)で求める。
残量がなくても未完了の作業は、開始条件と依存辺を持つ作業として残す。
これにより、進捗率だけでは完了分類を変えず、後続の承認なども計算できる。

Estimateなどの不足は、それが残量や開始条件に必要な未完了作業を止める。
完了と確定した末端には、将来日程に不要な見積や進捗率の入力を要求しない。
集約Issueの開閉だけで配下を完了扱いにはしない。

### 計算の根拠

元のblocked byに、入力中の両端を特定する `relationId` を付ける。
展開後の辺は、元の `relationId` と、前提側・後続側で展開した集約Issueのキーを参照する。
親子関係は入力のキーでたどれるため、末端までの全経路を各辺へ複製しない。
同じ辺へ複数の根拠が集まる場合は、根拠IDの重複を除いて保持する。

結果から、登録された前提、展開して待つ末端Issue、経由する親、末端の計算上の完了または不足理由をたどれるようにする。
例えばClosedの親を前提としていても、どの未完了の子が計算を待たせるかを示せる。
元の作業分類の理由と、日程計算の理由は別々に参照する。

## 平日座標の計算

### 座標と日付

[基準日と平日の規則](milestone-gantt.md#基準日と平日)で求めた計算開始日を座標の原点とする。
一つの平日の開始から次の平日の開始までを一単位とし、その途中を小数位置で表す。
暦日の経過時間や勤務時間へ換算しない。
Iterationの開始条件は同じ座標へ変換する。

日付へ戻す際は、開始と完了で整数境界の表示を区別する。
開始はその座標に対応する平日の開始、正の期間を使った完了は直前の平日の終了として表す。
途中の位置は該当する平日と小数位置で返し、根拠のない時刻を作らない。
期間がない作業は、開始と同じ位置の点として表す。

期日にも同じ座標を付けるが、表示用の日付は入力の期日を保持する。
土日の期日を座標へ変換するときは、その日までに終わる平日数を使う。
期日の前後関係は座標の差で判定し、表示する日付を前後の平日へ変更しない。

### 数値の比較

計算途中の丸めでクリティカルパスや重複を変えないため、内部では入力数値の十進表現を有限小数として扱う。
進捗率による残量を含めて表現できる桁にそろえ、整数の係数で加減算と比較を行う。
整数の係数にはJavaScript標準の `BigInt` を使い、新しい数値計算ライブラリは前提にしない。

一致判定に表示の丸め桁や任意の許容誤差を使わない。
公開する座標値をJavaScriptの数値へ変換する場合も、クリティカルか、超過か、重複するかは変換前に確定する。
画面の日数表示は[表示の丸め規則](milestone-gantt.md#クリティカルパスと余裕)に従う。

## 日程とクリティカルパスの計算

### 順方向と逆方向

展開後の未完了作業を、前提が先に来る順に並べる。
作業ごとに、開始条件と前提の最早完了から最早開始 `ES` を求め、残り期間を加えて最早完了 `EF` を求める。
この順方向計算は、同じ基準日の作業グラフで共有できる。

逆方向の計算はMilestoneごとに行う。
そのMilestoneの対象作業を終点へ接続し、[要件の完了と余裕の規則](milestone-gantt.md#クリティカルパスと余裕)から最遅完了 `LF`、最遅開始 `LS`、余裕を求める。
別のMilestoneへ向かう後続は、そのMilestoneの逆方向計算へ混ぜない。
共有する前提には、Milestoneごとに異なる余裕があり得る。

計算式では、残り期間を `D(v)`、平日座標へ変換した開始条件を `R(v)`、そのMilestoneの対象作業を `T` と表す。
以下は参照先の規則を実装用の変数で表したものであり、前提・後続は展開後の未完了作業に限る。

```text
ES(v) = max(R(v), 前提の EF)
EF(v) = ES(v) + D(v)
F = max(T 内の EF)
LF(v) = min(対象Milestoneへつながる後続の LS,
            v が T に属する場合の F)
LS(v) = LF(v) - D(v)
余裕(v) = LS(v) - ES(v)
```

前提がなければ `ES` は開始条件だけで決める。
逆方向では、そのMilestoneへつながる後続がない対象作業の `LF` を `F` とする。
計算不能の値を、式の最小・最大から除外して確定値を作らない。

逆方向計算の終点へ、Milestoneの期日を使わない。
期日との差は、計算上の完了を求めた後の別の結果とする。
Iterationの開始条件による空き期間は残し、その期間を前提の作業時間へ加えない。

### クリティカルな辺

クリティカルな作業の識別は[要件の判定](milestone-gantt.md#クリティカルパスと余裕)に従う。
その作業間の辺をクリティカルな接続として返すのは、前提の `EF` と後続の `ES` が一致する場合に限る。
両端の作業がクリティカルでも、その辺の間に開始条件による待ちがあれば、同じクリティカルパスとしてつながない。

結果はクリティカルな作業キーと辺を返し、全経路を配列へ展開しない。
複数の経路と分岐・合流を失わず、経路数による出力の増大を避ける。
クリティカルな前提がなくても、Iterationの開始条件によって完了日を決める作業は経路の始点になり得る。

## 不足と循環の伝播

入力の構造違反と、取得できなかった情報を分ける。
キー重複や取得完了を示す件数の不一致は入力契約違反として返す。
親子関係の循環と、完全に取得できた親の子一覧と子の親情報の食い違いも、入力契約違反とする。
未入力、取得不能、未確定の出典、不正な計算値は、対象キーと項目を持つ診断として扱う。

循環は集約Issueの展開後のグラフで検出する。
循環する作業群と、その影響を受ける後続を分けて返す。
自己参照になった辺も循環に含め、同じ辺の重複とは区別する。

開始や残量を確定できない作業から、後続へ計算不能の原因を伝える。
原因を後続ごとに全文複製せず、原因IDと直前の依存辺を参照してたどれるようにする。
判明している作業と辺は結果へ残す。

対象に影響する不足や循環があれば、そのMilestoneの完了、逆方向日程、余裕、クリティカルパスを未確定にする。
同じMilestoneでも、前提が判明している作業の最早日程は返せる。
無関係なMilestoneは独立して計算する。
期日未設定は作業日程を止める原因にはしない。

## 担当重複の計算

最早日程が確定した作業を、出典Projectと担当でまとめる。
重複を確認する範囲は[担当の重複の要件](milestone-gantt.md#担当の重複)に従い、対象外のProjectの担当名を同じ人だと推定しない。
複数のMilestoneから参照された同じ作業は、一度だけ扱う。

区間は開始を含み完了を含まない半開区間とする。
端点が一致するときは完了を先に処理し、隣り合う区間を重複にしない。
期間のない作業は区間の検査へ入れない。

結果は担当、同時に重なる作業キー、重複する区間を返す。
連続する区間で作業の集合が同じならまとめる。
担当不明、日程未確定、対象外Projectは検査できない範囲として別に返し、警告なしを重複なしの保証にしない。
検査結果から日程を変更しない。

## 出力

Milestoneの内部計算状態は、`calculated`、`incomplete`、`empty`、`completed`、`excluded` とする。
対象一覧の取得が不完全な場合は、空に見えても `empty` にせず `incomplete` にする。
`completed` は配下の作業が完了した場合であり、実際の完了日時や人間の受入完了を表さない。
その場合は残量を返し、将来の完了日を新たに推定しない。
閉じたMilestoneの `excluded` と、作業未登録の `empty` は区別する。
これらは関数内の分類であり、画面の名称や既存の作業分類を置き換えない。

### 返却フィールド

最上位の `status` は入力契約が有効なら `calculated`、契約違反なら `invalid` とする。
個々のMilestoneを計算できたかは `milestones[].state` で判断する。
契約違反時は `diagnostics` に原因を返し、作業やMilestoneの結果を空配列にする。
入力契約の検査は入力全体に適用し、計画値の不足・不正による制限は対象とその後続へ適用する。

| フィールド | 内容 |
| --- | --- |
| `baseDate`, `calculationStartDate`, `fetchedAt`, `selectedProjectId` | 入力の基準日、平日へ調整した原点、取得日時、担当重複を調べるProject |
| `tasks` | 展開した末端作業。`key`、`sourceProjectId`、adapter由来の `completion`、`remainingPoints`、`durationDays`、`durationDisplay`、`earliestStart`、`earliestFinish`、`iterationOverflow`、診断の参照を持つ |
| `milestones` | `key`、`state`、`targetTaskKeys`、前提を含む `taskKeys`、`remainingPoints`、`finish`、`dueDate`、`dueDifference`、作業別の `tasks`、`criticalTaskKeys`、`criticalEdgeIds`、`diagnosticIds` を持つ |
| `milestones[].tasks` | `key`、`latestStart`、`latestFinish`、`slackDays`、`slackDisplay`、`critical`、`diagnosticIds` を持つ。Milestoneが未確定なら逆方向日程とクリティカル判定は `null` |
| `edges` | `id`、`from`、`to`、`evidence`、Milestoneキーから真偽値または未確定の `null` を引く `criticalByMilestone` を持つ |
| `edges[].evidence` | `relationId`、前提側で展開した `prerequisiteAggregates`、後続側で継承した `successorAggregates` のキーを持つ |
| `relations` | `id`、元のblocked byの `prerequisiteKey`、`successorKey` を持つ |
| `hierarchy` | 参照したIssueの `key`、`parent`、`children`。計算対象外の兄弟のキーが含まれていても、その作業の日程を追加したことにはならない |
| `cycles` | 循環する `taskKeys` と `diagnosticId`。影響を受ける後続は各作業の診断参照から追う |
| `overlaps` | `sourceProjectId`、`owner`、同時に重なる `taskKeys`、区間の `start` と `finish` |
| `overlapUnchecked` | `key` と `reasons`。出典不足、対象外Project、担当不明、日程未確定をそれぞれ `source-unavailable`、`outside-project`、`owner-unknown`、`schedule-unknown` とする |
| `diagnostics` | `id`、`kind`（`contract` または `data`）、対象の `key`、`field`、原因の `code`、追加情報の `details` |

作業の `diagnosticIds` は影響する原因、`directDiagnosticIds` はその作業で検出した原因を示す。
`viaEdgeIds` は原因を受け取った直前の依存辺であり、前提側の作業へたどれる。
IDは結果内で参照する不透明な文字列として扱い、画面やadapterは文字列を分解しない。
IssueとMilestoneのキーは大文字小文字を同一視し、末尾のスラッシュを除いて返す。

日付位置は `{ coordinate, date, fraction, boundary }` を持つ。
`boundary` は平日の開始を `start`、終了を `end`、途中を `within` とし、`fraction` はその日の位置を0〜1で表す。
正の期間の完了が整数境界なら `fraction: 1`、期間0の点なら開始と同じ位置を返す。
完了済み作業の最早・最遅日程は `null` とし、過去の実績日時を推定しない。
計算値がnumberまたは `YYYY-MM-DD` の日付で表現できる範囲を超えた場合は、`schedule` の `out-of-range` 診断を返し、後続の日程も確定しない。

`dueDifference` は `{ days, relation, display }` を持つ。
`days` は期日までの平日座標から計算上の完了を引いた符号付きの値で、`relation` は正なら `early`、0なら `on-time`、負なら `late` とする。
`display` は絶対量を要件の丸め規則で表した文字列であり、符号やクリティカル判定へ再利用しない。
期日が未設定または不正なら `dueDifference` は `null` とし、不正な期日は診断に残す。
`iterationOverflow` は終了日を超える場合の `{ days, display }`、超えない場合は `null` とする。

Milestoneの `remainingPoints` は前提を含む未完了作業を一度ずつ足した値とする。
対象または前提が未確定なら `null`、全作業完了なら0を返す。
既存のリリース集計の値としては使わない。
数値の公開値はJavaScriptのnumberであり、判定は変換前の整数係数で確定する。

## 受入例との対応

採用済みの条件と期待値は[要件の受入条件](milestone-gantt.md#受入条件)を使う。
次の表は、その例で照合する計算結果を示す。

| 要件の受入例 | 照合する結果 |
| --- | --- |
| 直列のA・Bと独立したC | 最早・最遅日程、Cの余裕、クリティカルな作業と辺 |
| 期日に余裕がある／期日を超える | 同じ日程・余裕を保持し、期日差の符号と値だけを変える |
| Cも最長となる | 分岐した両経路を、作業と辺の集合から復元できる |
| 進捗率から残量を求める／小数作業をつなぐ | 残量、途中で丸めない日程 |
| 金曜の開始／土曜が基準日 | 座標の原点と日付への変換 |
| 将来のIteration／土曜開始のIteration | 開始条件による空き期間と平日への変換 |
| 小数の日数／丸めるとゼロになる超過 | 計算値と超過判定を保持し、表示へ丸め前の結果を渡す |
| 期日なし／閉じたMilestone | 期日差だけ未算出となる場合と、計算対象外の区別 |
| 同じ担当の独立した作業 | 日程を変更せず重複区間を返す |
| 実装の残量がなく承認が残る | 未完了の点と後続期間を保持する |
| 別Milestoneの前提 | 対象外の前提を含む最早日程と、対象Milestoneの終点 |
| 親Pを待つ／PがClosed／中間の集約Issueがある | 同じ末端グラフ、親の見積を含まない計算、展開根拠 |
| P自身がQを待つ | Qから末端への継承辺と元のblocked byの参照 |
| PはOpenだが配下がすべて完了 | 親による日程上の待ちがなく、既存の分類を更新しない |
| 配下の不足／展開後の循環 | 不足箇所または循環群と後続への原因参照 |
| 見積などの不足／A・Bの循環 | 計算不能の伝播と、影響しない作業の最早日程 |
| 進捗率の更新後の再取得 | 入力の差による再計算。関数からの書込みがないこと |
| 新規作業の初期入力／初期値を確認できない既存作業 | 取得済みの値と未入力の区別。初期入力自体は更新側で確認する |

次は内部契約の境界を確認する追加例であり、画面機能の追加ではない。

| 境界 | 入力例と照合内容 |
| --- | --- |
| 辺の間に空きがある | Aの期間が2、Aを待つDが5、Aを待つBが2でBの開始条件が座標5の場合、B・Dの完了は7となる。A・B・Dはクリティカルでも、A→Bはクリティカルな辺ではない |
| Milestoneごとの余裕 | 同じ前提が複数Milestoneへ分岐する場合、他のMilestoneの後続で余裕を制限しない |
| 区間の境界 | 一方の完了と他方の開始が一致する場合、重複区間を返さない。期間のない未完了作業も重複に含めない |
| 完了と取得不足 | 完了と確定した末端の進捗率が未取得でも後続を止めない。集約か末端か不明なIssueは、Closedだけで配下を省略しない |
| 複数ProjectのStatus不一致 | Openの末端がProject AでDone、BでTodoなら、既存分類に従い `not-done` を渡す。出典をAへ絞っても完了に変えない |
| Closedと出典不足 | Closedの末端が既存分類で完了なら、出典未確定でも `done` とし、将来日程に不要なフィールド不足で後続を止めない |
| 完了判定の情報不足 | Openの末端について分類に必要なProject情報を取得できず `unknown` なら、理由を保持して後続へ計算不能を伝播させる |
| 進捗率だけが100% | 既存分類で未完了なら `not-done` のまま、残量0の点として開始条件と依存辺を保持する |
| 原因を示す経路 | Closedの親の配下に未完了の子がある場合、元の親、展開経路、待つ子、その日程または不足原因をキーでたどれる |
| 入力順と非破壊 | Issueや辺の配列順を変えても計算値は変わらず、呼出し前後で入力が変化しない |

## 実装と検証の範囲

計算処理は `dist/milestone-schedule.mjs`、十進演算と平日の座標変換は `dist/milestone-schedule-math.mjs` に置く。
現行の `release.mjs` にある「最長の流れ」の関数は流用せず、画面への接続は別の作業で行う。
取得側はこの内部入力へのadapterを、画面側は出力を使う表示と操作を担当する。

受入例と上の境界は `tests/milestone-schedule.test.mjs` で検証する。
時刻の固定、入力順の変更、元入力の比較も含め、ブラウザや実GitHubへの接続なしで再現できるようにする。
取得・保存・画面を含む確認は、各担当の検証と[リポジトリの検証手順](development.md#検証手順)へ接続する。
