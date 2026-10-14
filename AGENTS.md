# ToRide — エージェント作業ガイド

Claude Code / Codex CLI の並列開発を管理する Electron デスクトップダッシュボード。
このファイルのルールはリポジトリ全体に適用する。

## 作業の進め方

- 作業開始時に `git status --short` と現在のブランチを確認し、既存の変更を保持する。
- バグ修正・機能追加・改善の実装依頼では、[implement ワークフロー](.claude/skills/implement/SKILL.md) に従う。Claude Code では `/implement`、他のエージェントでは同じファイルを読んで進める。
- 実装の流れは main から作業ブランチを作成 → 不明点の確認 → 実装・検証・コミット → ユーザーによる動作確認 → OK 後に PR 作成。既存の作業ブランチを使うよう指定された場合はその指示を優先する。
- ドキュメントのみの整理は現在のブランチで行い、アプリの実装ワークフローと区別する。
- ファイルを変更・追加したら作業完了時に必ずコミットする。対象ファイルを明示して `git add` し、無関係な変更を含めない。コミットメッセージは変更内容を端的に表す日本語または英語で記述する。

## 開発・検証コマンド

npm を使う。コマンドの定義は `package.json` を参照。

| コマンド | 用途 |
|---|---|
| `npm ci` | ロックファイルに基づく依存インストール |
| `npm run dev` | Electron 開発環境を起動 |
| `npm run typecheck` | main / preload と renderer の型チェック |
| `npm run build` | main / preload / renderer のビルド |
| `npm run rebuild` | better-sqlite3 / node-pty の Electron 向け再ビルド |

- コード変更後は `npm run typecheck` と `npm run build` を実行する。現時点で `test` / `lint` スクリプトはない。
- UI・PTY・hook・セッション管理の変更は、関連する起動・完了・再開の挙動も確認する。未確認の項目は報告する。
- ドキュメントのみの変更は、差分・参照先・移動時の情報保持を確認する。

## 実装時に守る境界

- main は `electron/main/`、preload は `electron/preload/index.ts`、renderer は `src/`。renderer からの操作は `window.api` を通し、IPC 変更時はハンドラ・preload・`src/types/ipc.ts` を揃える。
- エージェント固有の起動・再開・能力差は `electron/main/agents/` の `AgentProvider` に置く。未対応の能力は UI に理由を表示する。
- タスク起動は `createStartTaskFn`、完了・削除時のセッション終了は `TaskService` のイベントから共通処理へ集約する。UI / MCP / ローテーションごとに別処理を増やさない。
- ペインの割り当て・競合判定は同一リポジトリ内に限定し、`orchestrate` はペインを占有させない。
- GitHub PAT とプラグインの認証情報は既存の `safeStorage` による保存経路を使う。設定エクスポートに `githubPat` / `githubTokens` を含めない。
- TUI の信頼確認・承認待ちにプロンプトや Enter を注入しない。タスク間メッセージは相手のターン終了後に届ける。

## 必要に応じて読む資料

| 作業対象 | 参照先 |
|---|---|
| セットアップ・利用手順 | [README.md](README.md) |
| 技術スタック・ディレクトリ構成 | [docs/architecture.md](docs/architecture.md) |
| タスク・エージェント・MCP などの機能仕様 | [docs/features.md](docs/features.md) |
| 設定・hook の保存先 | [docs/settings.md](docs/settings.md) |
| セッション・コンテキスト・通知などの制約と理由 | [docs/design-decisions.md](docs/design-decisions.md) |
| ドキュメントの構成・更新方針 | [docs/README.md](docs/README.md) |

関連する詳細資料を読んでから変更する。CLI の挙動に関する記述は実装と使用バージョンで確認する。

## このガイドの更新

- `CLAUDE.md` と `AGENTS.md` は同一内容を保ち、更新時は両方に反映する。
- 常時必要な作業ルール・コマンド・重要な制約だけをここに置く。機能一覧・設定一覧・背景・詳細な手順は `docs/` または該当スキルに置き、参照を追加する。
