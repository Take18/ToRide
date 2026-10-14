# アーキテクチャ

ToRide は Claude Code / Codex CLI の並列開発を管理する Electron デスクトップダッシュボード。

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
      TranscriptContextService.ts # Codex の rollout ファイルを tail してコンテキスト使用量を取り出す
      SessionRotationService.ts # セッションローテーション（閾値検知・handoff完了検知・再起動）
      McpServerService.ts # MCPサーバー（タスクCRUD・タスク起動・開発サーバー制御ツールを公開）
      NotificationService.ts # デスクトップ通知の発行と通知履歴の保存
      ModelListService.ts # /v1/models からのモデル一覧取得
      SlashCommandService.ts # スラッシュコマンド・スキルの列挙（補完候補）
      McpHookService.ts   # ~/.claude/settings.json のmcpServers自動管理
      ResidentOrchestratorService.ts # 常駐オーケストレータの起票・起動
      AgentSessionService.ts # /agent-session エンドポイント（Codex の SessionStart hook からセッションIDを受け取る）
      CodexConfigService.ts # ~/.codex/config.toml の trust_level 読み書き
      DismissedPrService.ts # レビュー依頼PRのdismiss・URL正規化
      ImageStore.ts       # タスクに添付した画像の保存
      TaskMessageService.ts # タスク間メッセージ（send_to_task）の受信箱と配送
    agents/
      types.ts            # AgentProvider・AgentCapabilities の型
      ClaudeProvider.ts   # claude の起動コマンド組み立て・能力宣言・モデル一覧
      CodexProvider.ts    # codex の起動コマンド組み立て・hook スクリプト・起動前チェック・モデル一覧
      codexCli.ts         # ログインシェルの PATH で codex を実行するヘルパー
      AgentRegistry.ts    # task.agent から provider を引く（未指定は claude）
    plugins/
      PluginRegistry.ts   # プラグインレジストリ
      catalog.ts          # プラグイン一覧（Wrike・GitHub Issue）
      ticket/             # チケットプラグイン（WrikeTicketPlugin・GitHubIssueTicketPlugin）
    ipc/
      tasks.ts / terminal.ts / git.ts / claude.ts / devServer.ts / github.ts / notifications.ts / agents.ts
    utils/path.ts         # パスユーティリティ
  preload/index.ts        # contextBridge でwindow.api公開
src/
  types/
    task.ts               # Task, RuntimeTask, ArchiveEntry 型
    ipc.ts                # AppSettings, WindowApi, IpcChannels 型
    window.d.ts           # window.api の型宣言
  utils/
    agent.ts              # 既定エージェントの解決（resolveDefaultAgent）・未対応機能の一覧
  stores/
    taskStore.ts          # Zustand (tasks, filteredTasks, CRUD actions)
    terminalStore.ts      # Zustand (isOpen, activeTaskId)
  components/
    BackgroundSlideshow/  # 背景スライドショー（bg://プロトコル使用）
    BranchStatus/         # ブランチ状態表示（5秒ポーリング）
    Common/               # ConfirmDialog, ConflictWarningModal, BranchCombobox
    ContextMeter/         # コンテキスト使用量プログレスバー
    FilterBar/            # 検索・タイプフィルタ・新規タスクボタン
    NotificationBell/     # 通知履歴のベルアイコン・一覧パネル
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

## プロセス間の境界

- main（`electron/main/`）が DB・PTY・Git・HTTP・エージェント起動を管理する。
- preload（`electron/preload/index.ts`）が `contextBridge` で `window.api` を公開する。
- renderer（`src/`）が React UI と Zustand ストアを持つ。IPC の型契約は `src/types/ipc.ts`、タスクの型は `src/types/task.ts` にある。
- UI・MCP・ローテーションの起動経路は `createStartTaskFn` を共用する。詳しい制約と理由は [設計判断](design-decisions.md) を参照。
