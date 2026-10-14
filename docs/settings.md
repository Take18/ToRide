# 設定リファレンス

型定義は [`src/types/ipc.ts`](../src/types/ipc.ts) の `AppSettings`、保存・既定値・マイグレーションは [`electron/main/index.ts`](../electron/main/index.ts) の `getSettings()` / `saveSettings()` と settings IPC を参照。以下は旧 `CLAUDE.md` の設定一覧を移した資料。

## AppSettings

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
| `defaultAgentId` | タスク作成時の既定エージェント（未設定は `claude`） |
| `agentDefaults` | タスクタイプ別の既定エージェント。`defaultAgentId` より優先 |
| `rotationDefaults` | セッションローテーションのグローバル既定値（enabled / threshold / handoffPath / bootPrompt）。タスク側が未指定のキーだけフォールバック |
| `rotationHandoffInstruction` | handoffを書かせる指示文のテンプレート（変数: `{used}` `{handoffPath}`） |
| `residentOrchestrator` | 常駐オーケストレータの内容（repoId / title / prompt は設定画面にUIあり。autoStart / rotation は設定のみ。title・prompt・rotation.bootPromptで `{date}` を展開）。`rotation.enabled` は無視され常に true |
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
| Stop Hook | `~/.claude/hooks/stop.sh` | タスク完了時にHTTP通知を送信。受信箱にメッセージがあれば応答で受け取って claude に渡す |
| Status Line Hook | `~/.claude/statusline.sh` | 各APIレスポンス後にコンテキスト使用量を更新 |
| MCP Server | `~/.claude/settings.json` の `mcpServers` | Claude Codeからタスク操作を可能にする |
