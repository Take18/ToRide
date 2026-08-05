# ToRide

Claude Code の並列開発を管理するElectronデスクトップダッシュボード。

---

## 開発ルール

- **作業完了後は必ずコミットする**: ファイルを変更・追加したら、作業の最後に `git add` + `git commit` を実行する。コミットメッセージは変更内容を端的に表す日本語または英語で記述する。
- **バグ修正・機能追加・改善の実装依頼を受けたときは、必ず `/implement` のワークフローに従う**: mainからブランチを切る → 不明点を質問する → 実装してコミット → 動作確認を依頼する → OKをもらったらPRを作成する、の順で進める。

---

## 技術スタック

| 用途 | 技術 |
|---|---|
| デスクトップシェル | Electron 28 + electron-vite |
| UI | React 18 + TypeScript |
| スタイリング | Tailwind CSS |
| 状態管理 | Zustand |
| ローカルDB | better-sqlite3 (SQLite) |
| ターミナル | node-pty + @xterm/xterm |
| Git操作 | simple-git |
| ルーティング | react-router-dom v6 |

---

## ディレクトリ構造

```
electron/
  main/
    index.ts              # Electronエントリ・bg://プロトコル・settings/shell/dialog IPC
    db/schema.ts          # DB初期化・マイグレーション
    services/
      TaskService.ts      # タスクCRUD・アーカイブ
      TerminalService.ts  # node-pty管理 (Map<taskId, IPty>)
      GitService.ts       # simple-git ラッパー
      ClaudeService.ts    # claude起動・コンテキスト解析・通知
      DevServerService.ts # 開発サーバーspawn管理
      GitHubService.ts    # GitHub API（レビュー依頼PR取得）
      LocalHttpServer.ts  # 共有HTTPサーバー（addRoute()で複数エンドポイント登録）
      StopHookService.ts  # Stop Hook管理・/task-doneエンドポイント
      ContextLineService.ts # Status Line Hook管理・/context-updateエンドポイント
      McpServerService.ts # MCPサーバー（タスクCRUD・タスク起動・開発サーバー制御ツールを公開）
      ModelListService.ts # /v1/models からのモデル一覧取得
      McpHookService.ts   # ~/.claude/settings.json のmcpServers自動管理
    plugins/
      PluginRegistry.ts   # プラグインレジストリ
      catalog.ts          # プラグイン一覧（Wrike・GitHub Issue）
      ticket/             # チケットプラグイン（WrikeTicketPlugin・GitHubIssueTicketPlugin）
    ipc/
      tasks.ts / terminal.ts / git.ts / claude.ts / devServer.ts / github.ts
    utils/path.ts         # パスユーティリティ
  preload/index.ts        # contextBridge でwindow.api公開
src/
  types/
    task.ts               # Task, RuntimeTask, ArchiveEntry 型
    ipc.ts                # AppSettings, WindowApi, IpcChannels 型
    window.d.ts           # window.api の型宣言
  stores/
    taskStore.ts          # Zustand (tasks, filteredTasks, CRUD actions)
    terminalStore.ts      # Zustand (isOpen, activeTaskId)
  components/
    BackgroundSlideshow/  # 背景スライドショー（bg://プロトコル使用）
    BranchStatus/         # ブランチ状態表示（5秒ポーリング）
    Common/               # ConfirmDialog, ConflictWarningModal, BranchCombobox
    ContextMeter/         # コンテキスト使用量プログレスバー
    FilterBar/            # 検索・タイプフィルタ・新規タスクボタン
    PaneStatusSidebar/    # ペイン状態・開発サーバー起動停止
    TaskCard/             # タスクカード (PRStatusBadge含む)
    TaskForm/             # タスク作成・編集モーダル
    Terminal/             # xterm.jsターミナルパネル
  pages/
    DashboardPage.tsx     # 3カラムKanbanボード
    ArchivePage.tsx       # アーカイブ一覧
    SettingsPage.tsx      # 設定画面
  App.tsx / main.tsx
```

---

## 実装済み機能

### タスク管理

- **7タイプのタスク作成・編集**
  - `feat`: タイトル / リポジトリ / ブランチ* / 分岐元ブランチ / Wrikeチケット* / プロンプト*
  - `design`: タイトル / リポジトリ / 出力パス* / プロンプト
  - `review`: タイトル / リポジトリ / PR URL* / プロンプト
  - `bugfix`: タイトル / リポジトリ / ブランチ* / 分岐元ブランチ / Wrikeチケット* / プロンプト
  - `research`: タイトル / リポジトリ / ブランチ* / プロンプト*
  - `chore`: タイトル / ディレクトリ* / プロンプト（repoId不要）
  - `orchestrate`: タイトル / ディレクトリ（省略可） / プロンプト（repoId不要・ペイン非占有のコーディネーター役）
- **ブランチオートコンプリート**: ブランチ入力を Combobox に変更、既存ブランチをプレフィックス一致順に候補表示
- **チケットプラグイン**: Wrike（デフォルト）と GitHub Issue をサポート（PluginRegistry架）
- **プロンプト変数チップ**: タスクフォームの変数チップをクリックするとカーソル位置に挿入
- **フォルダ選択**: choreタスクのDirectory入力にフォルダ選択ダイアログボタン
- **編集**: タイプ以外の全フィールドを編集可能
- **削除**: タスクの完全削除
- **アーカイブ**: 完了タスクをアーカイブへ移動
- **3カラムKanban**: `will_do` / `doing` / `done`
- **依存タスク**: 依存先が未完了なら開始をブロック（ホバーでツールチップ）
- **完了タイムスタンプ**: doneタスクに完了日時を表示
- **即時完了ボタン**: will_doカードでも「完了」ボタンで実行なしに完了へ移行可能

### タスク実行・ターミナル

- **タスク開始**:
  - タスクの `repoId` に対応するリポジトリ内の空きペインを自動割り当て
  - 対象ブランチへの自動チェックアウト（feat / bugfix / research）
  - Claude Code の自動起動（TUI起動検知後にプロンプト注入・自動送信）
  - モデル選択プルダウン（起動モードとは独立）で実行モデルを指定可能
  - 依存タスク未完了・対象リポジトリに空きペインなしの場合はボタン無効化
- **orchestrateタスク**: 複数タスクを統括するコーディネーター役として起動
  - ペインを占有しない（workdirはリポジトリの先頭ペインのパスを借用、なければhomedir）
  - 起動時にシステムプロンプト（`orchestrateSystemPrompt` 設定、デフォルトあり）+ メモリディレクトリ + ミッション説明を結合して注入
  - プロンプトはテンプレート変数展開の対象外
- **ペイン競合検出**: 同一ペインに実行中タスクがあれば警告モーダル（強制起動も可）
- **タスク完了**: 完了ボタンでステータス変更 + ターミナルセッション自動クローズ
- **再起動時自動リセット**: 起動時にdoingタスクをwill_doに戻し、task_runtimeをクリア
- **セッション再開**: 完了タスクカードの「再開」ボタンで `claude --resume <uuid>` による前セッション継続
  - タスク起動時にUUIDを生成し `--session-id` フラグでClaudeに渡して保存
  - 別ペインでも再開可能（Claudeセッションはグローバル保存）
- **インタラクティブターミナル**: 右スライドパネル（幅はドラッグで変更可能）
  - xterm.jsによる個別PTYセッション
  - パネルを閉じてもPTYプロセスは維持（バックグラウンド継続）
  - ResizeObserverによる自動リサイズ追従
  - スリープ復帰・ウィンドウフォーカス時に自動再描画

### Claude Code 連携

- **起動モード切り替え**（`normal` / `auto` / `bypass` / `plan`）:
  - 通常: `claude`
  - 自動許可モード: `claude --permission-mode auto`（設定 `useAutoMode` で有効化）
  - 危険モード: `claude --dangerously-skip-permissions`（設定 `useDangerouslySkipPermissions` で有効化）
  - researchタスクはデフォルトで `plan` モード起動
  - 起動ボタンのドロップダウンからタスクごとに上書き可能
- **モデル選択**: 起動モードとは独立したプルダウンで実行モデルを指定（`--model` フラグ）
  - モデル一覧は `/v1/models` から動的取得、失敗時は opus/sonnet/haiku にフォールバック（ModelListService）
- **プロンプト注入**: タスク固有prompt → 設定テンプレート の優先順で適用。TUI起動検知後に注入して自動送信
- **プロンプトテンプレート変数**: `{title}` は全タイプ共通、各タイプ固有変数あり
  - feat: `{branch}` `{ticket}` `{prompt}`
  - design: `{output}`
  - review: `{pr-url}`
  - bugfix: `{branch}` `{ticket}`
  - research: `{branch}` `{prompt}`
  - chore: `{directory}`
- **Stop Hook**: `~/.claude/hooks/stop.sh` でタスク完了を検知・HTTP通知（設定画面からインストール）
- **Status Line Hook**: `~/.claude/statusline.sh` で各APIレスポンス後にコンテキスト使用量をリアルタイム更新（設定画面からインストール）
- **MCP サーバー**: `create_task` / `list_tasks` / `list_repos` / `update_task` / `delete_task` / `start_task` / `list_dev_servers` / `start_dev_server` / `stop_dev_server` ツールを公開（設定画面からインストール、`~/.claude/settings.json` に自動登録）
  - `start_task` は `launchMode` パラメータで起動モードを指定可能
  - `list_dev_servers` は workdir・実行中タスク情報を含めて返却

### Git 連携

- **ブランチ状態表示**（5秒ポーリング）: ブランチ名 / ahead(↑緑) / behind(↓赤) / 未コミット変更数(黄)
- **自動ブランチチェックアウト**: タスク開始時に指定ブランチを作成/切り替え
- **PRステータスバッジ**: review タスクで `open` / `merged` / `closed` をリアルタイム表示
- **PR URL自動検出**: Status Line Hookペイロード経由でセッション中に作成されたGitHub PR URLを検出し、実行中タスクに自動紐付け（reviewタスクは対象外）。PRボタンは `PR#番号` 形式で表示
- **外部リンク**: WrikeチケットおよびGitHub PRをブラウザで開く

### コンテキストウィンドウ管理

- **トークン使用量表示**: `75,234 / 200,000 tokens` 形式
- **プログレスバー**: 緑(0〜80%) / 黄(80〜90%) / 赤(90%〜)
- **デスクトップ通知**: 80%到達時 / 90%到達時 / タスク完了時（通知クリックで関連画面へジャンプ）
- **リアルタイム更新**: Status Line Hook 経由で各APIレスポンス後に即時反映（stdout パースはフォールバック）
  - used_percentageベースで計算、セッション最大値を追跡して逆行防止

### ペイン・開発サーバー・複数リポジトリ

- **ペインステータスサイドバー（左192px）**: リポジトリ名ヘッダーつきグループ表示 / ペインID / パス / 占有状況
- **開発サーバー制御**: ペインごとに複数サーバーを起動/停止
  - ●実行中（緑）/ ○停止中（灰）のステータス表示
  - ターミナルパネルでリアルタイムログ閲覧（1秒ポーリング）
  - 設定画面でドラッグ＆ドロップ並べ替え（青線インジケータで挿入位置表示）
  - 異常終了時にデスクトップ通知
- **複数リポジトリ対応**:
  - 設定は `repos: RepoConfig[]` の階層構造（リポジトリ > ペイン）
  - タスク開始時はタスクの `repoId` が指すリポジトリ内のペインにのみ割り当て
  - 旧 `panes` 形式は起動時に `repos[0]（id:repo1, name:default）` として自動マイグレーション
  - `chore` タスクは `repoId` 不要（`directory` を workdir として使用）

### 検索・フィルタ

- **全文検索**: タイトル / ブランチ / チケット / URL / PR URL（PR番号含む）を横断検索
- **検索クリアボタン**: 検索ボックスの×ボタンでキーワードを一括クリア
- **タイプフィルタ**: チェックボックスで絞り込み
- **カラム件数表示**: 各ステータスのタスク数を表示

### アーカイブ

- **一括アーカイブ**: doneカラムのタスクをまとめてアーカイブ（フィルタ適用中は表示中のタスクのみ対象）
- アーカイブページ（`/archive`）で過去のタスクを時系列表示
- 展開してタイプ・ブランチ・チケット・プロンプト・日時を確認
- 確認ダイアログ付きで個別削除

### GitHub PR 自動同期

- **レビュー依頼PR自動取得**: GitHub API (`review-requested:<username>`) でオープンなレビュー依頼PRを取得
- **タスク自動作成**: 既存タスク・アーカイブに存在しないPRを `review` タスクとして自動登録
- **重複防止**: `url` フィールドで既存・アーカイブ済みを突き合わせて重複を排除
- **repoId自動解決**: PRのリポジトリをgitリモートURLと突き合わせて対応する `repoId` をマッピング
- **自動同期タイマー**: アプリ起動中1分ごとにチェック、設定間隔（デフォルト5分）で同期実行
- **手動同期**: 設定画面の「今すぐ同期」ボタンでオンデマンド実行
- **デスクトップ通知**: 新規タスク作成時に件数を通知
- **マルチトークン検索**: 登録トークンごとに `review-requested` 検索を実行し、PRのURLで結果をマージ（fine-grained token はアクセス可能リポジトリしか検索できないため）
- **認証エラー通知**: 401 / 403（権限不足）を握り潰さず集約してデスクトップ通知。失敗スコープの面子が変わるまで再通知しない（403 はレート制限と区別）

### GitHub トークン管理（fine-grained PAT 対応）

- **owner / owner/repo 単位で複数トークンを登録**: `githubTokens: GitHubTokenEntry[]`
- **解決順序**: `owner/repo` → `owner` → 共通フォールバック `githubPat`
- **疎通確認**: 設定画面の「疎通確認」ボタンで `GET /user`（有効期限取得）＋スコープ対象への実アクセスまで確認
  - `owner/repo` スコープ: `GET /repos/{owner}/{repo}` を直接叩く
  - `owner` スコープ: `GET /user/repos` を列挙して owner 配下のアクセス可能リポジトリを確認（最大3ページで打ち切り）
- **有効期限表示**: `github-authentication-token-expiration` ヘッダから取得し、残7日以内は黄・期限切れは赤で表示
- **未登録owner警告**: 設定済みリポジトリのgitリモートから owner を集め、トークン未登録の owner を設定画面に表示

### 背景画像スライドショー

- 指定ディレクトリ内の画像（jpg/jpeg/png/gif/webp/avif/bmp）をランダムにクロスフェード表示
- `bg://local?path=...` カスタムElectronプロトコルでローカル画像を安全に配信
- 切替間隔（秒）を設定画面で変更可能（デフォルト30秒）
- 設定画面のフォルダ選択ダイアログで画像ディレクトリを選択

---

## 設定項目（AppSettings）

| フィールド | 説明 |
|---|---|
| `repos` | RepoConfig[] - リポジトリ単位でペインをグループ管理（id / name / panes[]） |
| `githubPat` | GitHub PAT（全owner共通のフォールバック・safeStorageで暗号化保存） |
| `githubTokens` | GitHubTokenEntry[] - owner / owner/repo 単位のfine-grained token（scope / token / expiresAt / lastCheck。tokenはsafeStorageで暗号化保存） |
| `githubUsername` | GitHubユーザー名（PR自動同期用） |
| `githubPrSyncIntervalMin` | PR自動同期間隔（分、デフォルト5） |
| `useDangerouslySkipPermissions` | claude起動時に`--dangerously-skip-permissions`を付加 |
| `useAutoMode` | claude起動時に`--permission-mode auto`を付加 |
| `promptTemplates` | タスクタイプ別プロンプトテンプレート |
| `orchestrateSystemPrompt` | orchestrateタスク起動時に先頭に付与するシステムプロンプト（未設定時はデフォルト） |
| `notificationsEnabled` | デスクトップ通知の有効/無効（デフォルトtrue） |
| `stopHookPort` | ローカルHTTPサーバーのポート（デフォルト39457） |
| `pluginSettings` | チケットプラグイン設定（暗号化フィールドはsafeStorage管理） |
| `enabledPlugins` | 有効なプラグインIDの一覧 |
| `extraPaths` | 子プロセス（git hooks等）に追加するPATHエントリ |
| `backgroundImageDir` | 背景スライドショー画像ディレクトリ |
| `backgroundIntervalSec` | スライドショー切替間隔（秒） |

設定画面からインストール可能なフック・サービス：

| 項目 | ファイル | 説明 |
|---|---|---|
| Stop Hook | `~/.claude/hooks/stop.sh` | タスク完了時にHTTP通知を送信 |
| Status Line Hook | `~/.claude/statusline.sh` | 各APIレスポンス後にコンテキスト使用量を更新 |
| MCP Server | `~/.claude/settings.json` の `mcpServers` | Claude Codeからタスク操作を可能にする |

---

## 重要な設計決定

- **pane競合**: 同一paneのdoingタスク存在時はIPCエラーコード `PANE_CONFLICT` を返却
- **リポジトリ別ペイン割り当て**: タスクの `repoId` に対応するリポジトリ内の空きペインのみ使用（`NO_REPO_ASSIGNED` / `NO_FREE_PANE` エラーコードあり）
- **設定マイグレーション**: 旧 `panes` フラットリストは `getSettings()` 内で `repos[{id:'repo1',name:'default',panes:[...]}]` に自動変換
- **repoId の保存**: `BaseTask.repoId` はタスクの `data` JSON カラムに保存（専用DBカラムなし）
- **worktree対応**: 同一リポジトリの複数ワークツリーを別paneにマッピング可能（`git checkout` でブランチ切り替え）
- **DBファイル**: `app.getPath('userData')` に保存
- **GitHub PAT**: `safeStorage.encryptString` で暗号化してDB保存。`githubTokens[].token` も同様（復号失敗時は空にして再入力を促す）
- **GitHubトークンの解決**: `utils/githubToken.ts` の `resolveGitHubToken(settings, owner, repo)` に集約。`owner/repo` → `owner` → `githubPat` の順に引く
- **チケットプラグインへのトークン受け渡し**: URLの owner/repo に対応するトークンのみ `pluginSettings.githubPat` に注入（GitHub以外のURLでは渡さない）
- **設定エクスポート**: `githubPat` / `githubTokens` は除外
- **PTY管理**: `Map<taskId, IPty>` でセッションをライフサイクル全体で維持
- **コンテキスト解析**: Status Line Hook 経由が主系、stdout/stderrパースはフォールバック。`used_percentage` ベースで計算し、セッション最大値を追跡して逆行防止
- **bg://プロトコル**: `protocol.registerSchemesAsPrivileged` で`app.whenReady`より前に登録必要
- **再起動時クリーンアップ**: 起動直後にdoing→will_do変換 + task_runtimeテーブル全削除
- **LocalHttpServer**: Stop Hook・Status Line Hook・MCP SSEを共有する単一HTTPサーバー（`addRoute()` / `addRawRoute()` でエンドポイント追加）
- **MCPトランスポート**: SSEトランスポートを使用。ポートは `~/.toride/port` と同一のLocalHttpServer上で動作
- **セッションID**: タスク起動時にUUIDを生成し `--session-id` でClaudeに渡す。`claude --resume <uuid>` で完了後も再開可能
- **pane占有判定**: 同一リポジトリ内のみに限定（別リポジトリの同名paneは除外）
- **resume時のworkdir**: `claude --resume` はcwdでセッションを検索するため、元のpaneのworkdirを使用
- **orchestrateのpane非占有**: orchestrateタスクは `pane` を空文字にして起動し、ペイン占有判定の対象外（workdirはリポジトリ先頭ペインのパスを借用）
- **プロンプト注入タイミング**: 固定遅延ではなくTUI起動検知ベースで注入し自動送信
- **PR URL検出**: ターミナル出力スキャンではなくStatus Line Hookのペイロードから検出
- **モデル一覧**: `/v1/models` から動的取得し、失敗時は opus/sonnet/haiku にフォールバック（ModelListService）
