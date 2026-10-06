# github-progress-board の作業規則

## 対象と検証

- このリポジトリは汎用の進捗管理ツールを扱う。`samples/` と集計テストのデータは架空のサンプルである。
- 公開リポジトリであるため、非公開のrepositoryの内容、個人の情報、他社サービスの画面をコミットしない。
- 公開対象の条件は [README.md の公開対象](README.md#公開対象) に従う。
- 仕様と実装状況は [README.md](README.md) を読む。
- `dist/` は手書きのアプリ本体であり、Git管理する。
- 検証はリポジトリ直下で `npm test` と `npm run check` を実行する。
- 起動は `npm start`。GitHubを自動取得するrepositoryは `PROGRESS_GITHUB_REPOS` で指定する。
- 実際のGitHubデータを変更する機能は、接続先と操作範囲をユーザーが決めてから実装する。

## UI設計

UIの構造や操作の流れは、観察、行動の整理、設計、試作の順に検討する。

1. 既存ツールの実画面を操作し、操作動画やデモを見て、操作前後の画面を記録する。出典と操作手順、または動画の時刻を添える。
2. 人が何を知りたくて、どの情報から何を判断し、次に何を操作するかを画面に対応させて整理する。観察した事実と推測は分ける。
3. 整理した行動を根拠に、情報のまとまり、表示順、詳細の開き方を設計する。
4. 試作でも同じ作業を行い、操作前後のスクリーンショットで表示と操作を確認する。画面の変更前後の画像は、[docs/screenshots.md](docs/screenshots.md) の規則で圧縮して `docs/screens/` に保存し、PRに貼る。

静止画、操作デモ、実利用者の行動観察は区別する。確認できなかった操作は未確認として残す。他社サービスなどの観察記録は `references/` に保存し、Git管理しない。

## 並行作業とworktree

- 人とClaude・Codexは並行して作業する。エージェントは作業ごとに `git worktree add` で専用のフォルダを作り、その中でブランチを作って作業する。
- worktreeは共有のフォルダの外に作る。共有のフォルダと同じ階層に `github-progress-board-<作業名>` として作るか、エージェントが既定で使うworktreeの場所に作る。共有のフォルダで次のように作成する。

  ```sh
  git fetch origin
  git worktree add -b codex/<作業名> ../github-progress-board-<作業名> origin/main
  ```

- 共有のフォルダ（ユーザーが普段使うclone）では、エージェントはブランチを切り替えず、ファイルも編集しない。
- 作業を始める前に `git worktree list` と `git status` で、他の作業と未コミットの変更を確認する。他の作業の変更を見つけたら編集を止め、ユーザーに報告する。
- worktreeでサーバーを起動するときは、`PORT` で他と重ならないポートを使う。起動方法は [README.md の起動と検証](README.md#起動と検証) に従う。保存したデータはポートごとに分かれる。
- PRのマージ後は、そのworktreeを `git worktree remove` で片付ける。

## IssueとGitHub Project

- 作業は [GitHub Project「github-progress-board 開発」](https://github.com/users/Wakua/projects/3) で管理する。
- 作業を始める前に、対応するIssueを選ぶか作る。Projectで、そのIssueの「担当」「Iteration」「Estimate」を設定する。計画外の急ぎの作業は「優先度」を「緊急」にする。
- Claude・CodexはGitHubのユーザーではないため、担当はAssigneeではなくProjectの「担当」フィールド（Wakua・Claude・Codex）で示す。
- IssueとPRの本文は「目的」から始め、誰が何をできるようになるかを書く。実装の手段は「手段」として分けて書く。
- PRの「目的」の先頭に、対応するIssueを `- #番号` の箇条書きで置く。GitHubがIssueのタイトルを表示する。
- PRの本文では、対応するIssueを `Closes #番号` か `Refs #番号` で示す。対応するIssueのないPRは作らない。
- PRは作業中はDraftにし、作業を終えてユーザーの承認を求めるときにReadyにする。ReadyのPRを「承認待ちのPR」と呼び、2件までとする。
- Readyにする前に `gh pr list --state open --draft=false` で承認待ちの件数を確認し、2件以上ならDraftのまま待つ。待っていることはユーザーに伝える。上限の状態はツールの「承認待ちのPR」で確認できる。
- リリースは2イテレーション（2週間）ごとにMilestoneで区切る。Milestoneの期日までに、そのMilestoneの作業のPRをマージする。期日後にユーザーがmainを確認し、フィードバックする。
- ユーザーがmainを確認して承認したら、リリース用のPRで `package.json` と `package-lock.json` の版と、READMEの変更履歴を更新する。版の規則は [README.md の バージョン](README.md#バージョン) に従う。
- リリース用のPRのマージ後に、ユーザーの承認を得て、タグ `v<版>` とGitHub Releaseを作る。承認なしにタグやReleaseを作らない。Releaseの本文には、完了したIssueの一覧を書く。
- フィードバックはIssueにし、担当・Iteration・Estimateを設定して次のイテレーションに割り当てる。GitHubでClosedにしても、ユーザーの確認が済むまで受入完了としない。

## 文章とGit

- 文章を書く前に [文章の書き方](docs/writing-guidelines.md) を読む。返答、進捗報告、文書、Issue、PRに適用する。
- ブランチ名は `codex/` で始める。コミット対象のファイルを個別に指定し、`git add -A` や `git add .` は使わない。
- PRは、ユーザーが対象PRを承認してからマージする。
- 実装の委任やAIレビューは、ユーザーが明示的に求めた場合だけ行う。
