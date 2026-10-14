# 設計判断と実装上の注意点

旧 `CLAUDE.md` の設計判断を保持した資料。CLI に関する実測結果は記載されたバージョン・時点のものとして扱い、変更時に再確認する。

## タスク・ペイン・永続化

- **pane競合**: 同一paneのdoingタスク存在時はIPCエラーコード `PANE_CONFLICT` を返却
- **リポジトリ別ペイン割り当て**: タスクの `repoId` に対応するリポジトリ内の空きペインのみ使用（`NO_REPO_ASSIGNED` / `NO_FREE_PANE` エラーコードあり）
- **設定マイグレーション**: 旧 `panes` フラットリストは `getSettings()` 内で `repos[{id:'repo1',name:'default',panes:[...]}]` に自動変換
- **repoId の保存**: `BaseTask.repoId` はタスクの `data` JSON カラムに保存（専用DBカラムなし）
- **worktree対応**: 同一リポジトリの複数ワークツリーを別paneにマッピング可能（`git checkout` でブランチ切り替え）
- **DBファイル**: `app.getPath('userData')` に保存
- **再起動時クリーンアップ**: 起動直後にdoing→will_do変換 + task_runtimeテーブル全削除
- **pane占有判定**: 同一リポジトリ内のみに限定（別リポジトリの同名paneは除外）
- **orchestrateのpane非占有**: orchestrateタスクは `pane` を空文字にして起動し、ペイン占有判定の対象外（workdirはリポジトリ先頭ペインのパスを借用）
- **residentOrchestrator は永続状態を持たない**: 人がボタンを押したときだけ動くので、日付スタンプでの打ち切りは不要（判断はタスク一覧だけで完結する）
- **`task_runtime` の upsert**: 起動時に `DELETE FROM task_runtime` するため既存タスクの行が消える。`TaskService.update()` は runtime 更新前に `INSERT OR IGNORE` で行を作る（無いと pid / contextUsed 等の UPDATE が全て空振りする）

## GitHub・チケット・認証情報

- **GitHub PAT**: `safeStorage.encryptString` で暗号化してDB保存。`githubTokens[].token` も同様（復号失敗時は空にして再入力を促す）
- **GitHubトークンの解決**: `utils/githubToken.ts` の `resolveGitHubToken(settings, owner, repo)` に集約。`owner/repo` → `owner` → `githubPat` の順に引く
- **チケットプラグインへのトークン受け渡し**: URLの owner/repo に対応するトークンのみ `pluginSettings.githubPat` に注入（GitHub以外のURLでは渡さない）
- **PR URL自動入力のトークン**: `ticket:fetch` の PR URL 経路も `resolveGitHubTokenForUrl()` で解決（未登録ownerは未認証で取得を試み、privateなら404案内）
- **リポジトリ名の解決**: `utils/repoMap.ts` の `listRepoFullNames()` が基点。`buildRepoFullNameMap()`（repoId解決）と `github:repo-owners`（owner一覧）が共用する
- **設定エクスポート**: `githubPat` / `githubTokens` は除外
- **PR URL検出**: ターミナル出力スキャンではなくStatus Line Hookのペイロードから検出
- **dismiss は `dismissReviewPr()` に集約**: UI（`github:dismiss-pr` IPC）と MCP（`dismiss_pr`）の両方から呼ぶため、`DismissedPrService.ts` の関数1本にまとめている。URLは `normalizePrUrl()` で `html_url` と同じ形（`/files` や `#discussion_r...` を落とす）に正規化してから登録する。正規化しないと同期側の `dismissedUrls.has(pr.html_url)` に一致せずタスクが再作成され、close/merge 判定のAPI呼び出しも失敗してレコードが永久に残る。同じPRを指す review タスクは複数あってもまとめて削除する

## エージェント・起動・PTY

- **エージェントの抽象化**: 起動コマンド・再開コマンド・起動前チェック・モデル一覧は `AgentProvider`（`electron/main/agents/`）に置き、`ClaudeService.start()` は provider を受け取って PTY を動かすだけにしている。エージェントはタスク作成時に決める属性（`BaseTask.agent`、未指定は `claude`）で、起動ボタンで選ぶのはモードとモデルだけ。能力差は `AgentCapabilities` で宣言し、足りない機能は黙って消さずに画面へ理由を出す前提で使う。provider は `ClaudeProvider` と `CodexProvider`。起動後に TUI へ送る入力は `buildInitialInput()` が `InjectStep[]`（write / delay / waitFor）で返し、`ClaudeService` はそれを順に実行するだけにしている
- **起動処理は `createStartTaskFn` に1本化**: UI の `claude:start` も MCP の `start_task` もローテーションも同じ関数を通る。完了通知・PID 記録・PTY 出力のレンダラー転送は起動と再開で共通の `attachSession()` にまとめている。コンテキスト使用量の DB 保存とレンダラー送信は index.ts で `claudeService.onContextUpdate` を1本だけ購読して行う（起動のたびに購読すると再起動・再開のたびに積み上がり、同じ更新を回数分だけ流してしまう）
- **タスクIDの env**: PTY には `TORIDE_TASK_ID` を渡し、インストール済みの古い `stop.sh` / `statusline.sh` のために `CLAUDE_TASK_ID` にも同じ値を入れる。新しく生成するスクリプトは `${TORIDE_TASK_ID:-$CLAUDE_TASK_ID}` で読む
- **PTY管理**: `Map<taskId, IPty>` でセッションをライフサイクル全体で維持
- **セッション終了は子孫プロセスまで**: `pty.kill()` はログインシェルにしかシグナルが届かず、claude が起動したバックグラウンドジョブが生き残って完了後も通知を出してくる。`TerminalService.kill()` は kill 前に `ps -eo pid=,ppid=` で子孫PIDを洗い出し（親を先に殺すと reparent されて辿れなくなる）、SIGTERM → 3秒後に生存分へ SIGKILL する。アプリ終了時の `killAll()` は setTimeout が発火しないので猶予なしの SIGKILL
- **完了時のセッション終了フックは `TaskService` に集約**: done にする経路が UI / 通知 / MCP と複数あるため、`TaskService.onStatusChange` / `onDeleted` を index.ts で1本だけ購読して `stopHook.removeTaskCallback` → `rotation.clear` → `resetContextTracking` → `terminal.kill` を実行する。各呼び出し元に散らすと必ず取りこぼす
- **セッションID**: タスク起動時にUUIDを生成し `--session-id` でClaudeに渡す。`claude --resume <uuid>` で完了後も再開可能
- **resume時のworkdir**: `claude --resume` はcwdでセッションを検索するため、元のpaneのworkdirを使用
- **プロンプト注入タイミング**: 固定遅延ではなくTUI起動検知ベースで注入し自動送信
- **注入を止める画面（injectGuard）**: 初めて開くフォルダでは claude がフォルダ信頼確認を出し、既定の選択肢が「No, exit」になっている。ここに注入の Enter が届くと claude が終了し、タスクが doing のまま止まる。`ClaudeProvider.injectGuard` でダイアログ（`trust this folder`）を検出したら、ウェルカムバナー（`Claude Code vX.Y.Z`）が出るまで注入を見送り、`session` カテゴリで通知する。12秒のフォールバック注入も見送る。ToRide 側で自動的に信頼を選ぶことはしない（信頼するかは人が決める）。照合は ANSI と空白を除いた出力で行い、解除時にもバッファを空にする（選択を動かしたときの再描画が残ると再ブロックするため）
- **Codex の起動前チェック**: `codex login status` は env の API キーを見ないので、`codex doctor --json` の `checks["auth.credentials"].status` で判定する。doctor は10秒ほどかかるため、通った結果は10分使い回す（通らなかった結果は覚えない）。Codex を使う設定ならアプリ起動直後に一度実行しておく。この間はタスクがまだ will_do なので、`createStartTaskFn` は起動中のタスクIDを覚えて二重起動を `ALREADY_STARTING` で弾く
- **codex の PATH**: GUI から起動した Electron の PATH には asdf などのシムが入っていない。PTY ではログインシェルが PATH を通すので、起動前チェックとモデル一覧も `$SHELL -ilc` で取った PATH で codex を実行する（`codexCli.ts`）
- **Codex の自動起動を止める画面**: 起動時のアップデート確認は `-c check_for_update_on_startup=false` で出さない。信頼されていない hook の確認は `--dangerously-bypass-hook-trust` で飛ばす。フォルダ信頼確認は `-c` では消せないため `injectGuard` で検出して `session` 通知を出し、人が選ぶのを待つ（既定の選択肢は「Yes, continue」）
- **Codex の信頼のキー**: `~/.codex/config.toml` の `projects` は、git 管理下ならメインリポジトリのルート（worktree でもメイン側）を realpath にしたパスがキーになる（実測）。「ペインを信頼済みにする」は無いテーブルを末尾に足すだけで、パースして書き戻さない（コメントと並び順を残すため）。`trust_level` が trusted 以外で書かれているキーは、人が「信頼しない」を選んだ可能性があるので変更しない
- **Codex へのプロンプトの渡し方**: 改行や引用符がシェルで崩れないよう `~/.toride/prompts/<taskId>.md` に書き、`-- "$(cat <file>; rm -f <file>)"` で渡す。`-i` は値を複数取るので `--` で区切る。画像は `-i` で添付し、プロンプトにパスは書かない（`imageInput: 'argument'`）
- **Codex の plan モード**: `/plan <本文>` を一度に送ると起動直後は「'/plan' is disabled while a task is in progress」で弾かれる。`/plan` と Enter で切り替え、`Plan mode` の表示を待ってから本文を bracketed paste で送る（改行で送信されないように）。5秒待っても切り替わらなければ本文は送らずに通知する。入力待ちの判定は `\x1b[?2004h` ではなくウェルカムバナー（`OpenAI Codex (v`）で行う（Codex は画面を描く前に `?2004h` を出すため）
- **Codex の hook のポート**: hook には起動時の env で `TORIDE_PORT` を渡し、無いときだけ `~/.toride/port` を読む。別プロファイルで並走している2号機の hook が普段使いのインスタンスに届くのを防ぐため

## コンテキスト監視・ローテーション

- **コンテキスト解析**: Status Line Hook 経由が主系、stdout/stderrパースはフォールバック。`used_percentage` ベースで計算し、セッション最大値を追跡して逆行防止
- **取得元はすべて `ClaudeService.fireContextUpdate` を通す**: Status Line Hook も rollout の tail も `attachContextSource()` で購読させ、単調増加ゲート・80/90% 通知・DB 保存・レンダラー送信を共用する。Codex 用に別の経路を作ると、通知の重複や再開時のリセット漏れが起きる
- **stdout パースは provider ごとに切り替える**: パターンは Claude Code の表示に合わせてあり、上限 200000 も決め打ちしている。`AgentProvider.parseStdoutContext` が true のエージェント（Claude）だけで使う
- **rollout の tail（`TranscriptContextService`）**: `fs.watch` で変更を受け、読み込み位置を保持して追記分だけ読む。行の途中で切れたチャンクは次回に回し、マルチバイト文字は `StringDecoder` で持ち越す。SessionStart の時点でファイルがまだ無いことと `fs.watch` の取りこぼしに備え、2秒おきにも確認する。まとめて読んだときは最後の `token_count` だけを流す（再開時に頭から読むと過去のターンの数だけ通知判定が走るため）
- **tail を止める場所**: `endTaskSession`（完了・削除）、新規起動の直前、アプリ終了時。新規起動で止めないと、新しいパスが hook で届くまで前のセッションの rollout を読み続ける
- **ローテーション後のコンテキスト追跡リセット**: `ClaudeService.fireContextUpdate` は単調増加ゲート（`used <= prevMax` を捨てる）を持つため、新セッションの小さい値が全て捨てられる。`resetContextTracking()` を呼ばないと閾値判定が二度と発火しない
- **StopHookのコールバックは `Map<taskId, Set<cb>>`**: 1タスクに複数の購読者（タスク完了通知 / ローテーションのidle・handoff検知）がいるため。起動のたびに `removeTaskCallback` してから登録し直す（Set化で積み上がるのを防ぐ）
- **エコー検証の照合対象**: 日本語本文ではなく `handoffPath`（ASCII）の末尾。CJKはTUI上で全角幅として描画され折り返し計算が半角と異なるため。照合前に空白・改行を全除去して正規化する。指示文の最終行を `{handoffPath}` で終わらせているのはこのため
- **ローテーションのバッファ**: `ClaudeService.cleanBuffers` は `resetContextTracking()` でクリアされるため流用せず、`SessionRotationService` が `terminalService.onData` に自前リスナを持つ
- **rotation設定の保存先**: `BaseTask.rotation` は `data` JSON カラム。ランタイム状態（保留・baseline等）は `task_runtime.rotation_state` にJSONで保存（再起動でクリア）

## HTTP・MCP・タスク間メッセージ

- **LocalHttpServer**: Stop Hook・Status Line Hook・MCP SSEを共有する単一HTTPサーバー（`addRoute()` / `addRawRoute()` でエンドポイント追加）
- **ポートファイルの削除条件**: `~/.toride/port` はインスタンス間で共有される1本しかないため、`LocalHttpServer.stop()` は中身が自分のポートと一致するときだけ削除する。無条件に消すと、別プロファイルで並走させた2号機を閉じただけで稼働中インスタンスの `stop.sh` / `statusline.sh` が参照先を失い、通知とコンテキスト更新が黙って止まる
- **MCPトランスポート**: SSEトランスポートを使用。ポートは `~/.toride/port` と同一のLocalHttpServer上で動作
- **MCPのタスクレスポンスは要約に固定**: `RuntimeTask` をそのまま返すと `prompt` 全文・`images`・`rotation.history`（ローテーションのたびに積まれる）・`sessionId` が毎回乗り、status を1つ変えるだけの `update_task` でもコンテキストを大きく食う。`summarizeTask()` で「どのタスクか」と「今どうなっているか」に要るフィールドだけに絞り、`contextUsed`/`contextLimit` は `contextPercent` 1つに畳み、`JSON.stringify` のインデントも付けない。`list_tasks` からプロンプト本文を落とした代わりに `id` 絞り込みと `include_prompt` を用意して、必要なときだけ1件分取れるようにしている
- **開発サーバーログの返却量**: MCPレスポンスがコンテキストを食い潰さないよう `get_dev_server_log` は既定100行・最大1000行に切り詰める。`grep` は先に行フィルタしてから末尾N行を取る
- **タスク間メッセージの届け方**: `send_to_task` はどの経路でも「相手の今のターンが終わってから届く」形にそろえている。ターンの途中に PTY へ書き込むと、承認待ちや `AskUserQuestion` の画面に Enter が届いて誤って確定させるため。届け方は `AgentProvider.queueMessage` の有無で切り替える
  - Codex は `codex queue --thread <sessionId>` で積む。作業中なら今のターンのあとに処理され、入力欄の書きかけも消えない。閉じたセッションにも積めて resume したときに処理される（0.154.0 で実測）。止めたタスクに届くのを防ぐため、宛先は doing に限る
  - Claude は `TaskMessageService` の受信箱にためる。Stop hook が `/task-done` に `deliver: true` で POST してきたら、受信箱の中身を `{"decision":"block","reason":...}` で返す。claude は止まらずに reason を受けて次のターンへ進む（2026-10 の Claude Code で実測）。このときは実際には止まっていないので、完了通知やローテーションの idle 検知の購読者は呼ばない
  - 入力待ちの Claude には Stop hook がもう来ない。Stop hook のあと誰も入力していなければ（`TerminalService.getLastWriteAt`）入力待ちとみなし、`read_messages` を呼ばせる1行の合図を送る。本文を直接書かないのは、長い本文は TUI が `[Pasted text ...]` に畳んでエコーを確かめられないため。合図の末尾に ASCII の目印を置き、エコーを確かめてから Enter を送る。合図のターンで読まれなくても、そのターンの Stop hook で本文が渡る
  - 承認待ちや `AskUserQuestion` の表示中は Stop hook が来ないので、入力待ちとはみなさず受信箱で待たせる
  - 合図と Stop hook の reason には「書かれている依頼に従って対応してください」と書く。「読んでください」だけだと、Claude は `read_messages` の結果を別タスクからのお願いとして扱い、読んで要約するだけで実行しなかった（Haiku で実測）。Codex は `codex queue` の本文をユーザー入力として受け取るので、そのまま従う
  - 本文の末尾に返信方法を書いているため、Codex は「Reply」を `send_to_task` での返信と解釈して送り返してくることがある。往復を止める仕組みは持っていない
  - ローテーションで handoff を書かせている間は届けない。Claude は受信箱を新セッションの Stop hook まで持ち越し、Codex はエラーで返して送り直してもらう（codex queue は旧セッションに積まれるため）
  - 古い `stop.sh` は応答を捨てるので、目印（`toride-mailbox-v1`）が無いときは Claude 宛ての送信をエラーにする。設定画面にも再インストールを促す表示を出す
  - タスクが done になったら受信箱は捨てる（`endTaskSession`）

## 開発サーバー・通知

- **開発サーバーの終了情報**: `DevServerService` が `lastExits: Map<key, DevServerExitInfo>` で直近の終了（code / signal / 時刻 / manual・abnormal / spawn失敗メッセージ）を保持し、`status()` に載せて返す。`start()` 時にクリアするので「今の起動で落ちたか」だけが残る
- **開発サーバーログの保持上限**: `DevServerService` はログを約200万文字（`String.length` 基準＝UTF-16コードユニット数。日本語ログでは実メモリはこれより大きい）まで保持し、超えたら約150万文字まで古い側を行頭で切り落として `[... 古いログは省略されました ...]` を先頭に置く。毎チャンク切り詰めると保持分まるごとのコピーが走るため、切り落とし先を別に設けて頻度を落としている
- **notify_userのタスク解決**: セッションが自分のタスクIDを知らなくても通知できるよう、`taskTitle` からdoingタスク優先で完全一致→部分一致で逆引きする。解決できなければ通知は出しクリック時はウィンドウフォーカスのみ
- **通知履歴は Stop Hook 由来を積まない**: タスク完了は必ずタスクカードに残るので履歴に入れると同じ情報が二重になる。一覧に残すのは「見逃すと困る通知」（コンテキスト警告・ローテーションの異常・Devサーバー異常終了・MCPからの呼びかけ）に絞る
- **通知の発行は `NotificationService.notify()` に集約**: 履歴の記録とデスクトップ通知の生成を1か所にまとめ、クリック時の遷移先（`NavigationPayload`）も同じレコードから復元する。`ClaudeService` / `SessionRotationService` には service ではなく `notify` 関数だけ渡して、DBへの依存を持ち込まない
- **通知クリック時の遷移は `src/utils/navigateToTarget.ts` に共通化**: デスクトップ通知（main → `navigation:goto`）と通知一覧パネルの両方から同じ挙動を再現する必要があるため、App.tsx のハンドラから切り出した

## モデル・コマンド補完

- **モデル一覧**: `/v1/models` から動的取得し、失敗時は opus/sonnet/haiku にフォールバック（ModelListService）
- **スラッシュコマンド候補のスキャン**: `~/.claude/skills` はシンボリックリンクで貼られることが多く `Dirent.isDirectory()` が false になるため、リンクは `stat` で辿り直す。frontmatter の `description` はブロックスカラー（`|` / `>`）もあるので最初の段落だけ取り出す。SKILL.md は大きいので先頭4KBのみ読む
- **補完候補の収集元は provider が持つ**: `AgentProvider.commandSources()` が走査するディレクトリを返し、`SlashCommandService` はそれを順に走査するだけにしている。呼び出す記号は `AgentCapabilities.commandTrigger` で宣言する
- **Codex の補完に組み込みコマンドを出さない理由**: Codex のプロンプトは起動引数で渡し、1通のメッセージとして送られる。このため `/status` などの組み込みコマンドは実行されない。`$スキル名` は起動引数でも展開され、SKILL.md が読み込まれる（0.154.0 で実測）
- **候補の同名解決**: プロジェクト > ユーザー > プラグインの優先で先勝ち。プラグインは `pluginName:` を名前空間に付け、project スコープのものは workdir がその配下のときだけ含める

## 背景画像プロトコル

- **bg://プロトコル**: `protocol.registerSchemesAsPrivileged` で`app.whenReady`より前に登録必要
