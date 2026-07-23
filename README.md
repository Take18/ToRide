# ToRide

Claude Code の並列開発を効率的に管理するデスクトップダッシュボード。

> **ToRide** は2つの意味を持つ名前です。  
> - **to ride** — Claude Code セッションを「乗せる」台座。タスクにセッションを乗せて走らせる  
> - **砦（とりで）** — 並列開発の拠点・前線基地

## 概要

複数の Claude Code セッションを同時に管理し、タスクの進捗をリアルタイムで把握するための Electron アプリ。

### 解決する課題

- 複数の Claude Code セッションを同時に管理する煩雑さ
- タスクの進捗をリアルタイムで把握する難しさ
- コンテキストウィンドウの枯渇による作業中断
- ブランチ・作業ディレクトリの状態把握
- 複数リポジトリを跨ぐ並列開発でのペイン競合

## 技術スタック

| 用途 | 技術 |
|---|---|
| デスクトップシェル | Electron 28 |
| UI | React 18 + TypeScript |
| ビルド | electron-vite |
| スタイリング | Tailwind CSS |
| 状態管理 | Zustand |
| ローカル DB | better-sqlite3 |
| ターミナル | node-pty + @xterm/xterm |
| Git 操作 | simple-git |
| 通知 | Electron Notification API |

## インストール（ビルド済みバイナリ）

[GitHub Releases](https://github.com/Take18/ToRide/releases) からお使いの OS に合ったファイルをダウンロードしてください。

| OS | ファイル |
|---|---|
| macOS Apple Silicon | `ToRide-*-arm64.dmg` |
| macOS Intel | `ToRide-*-x64.dmg` |
| Windows x64 | `ToRide-*-x64-Setup.exe` |

### macOS: Gatekeeper の回避

コード署名がないため、初回起動時に「開発元を確認できない」と表示されます。

1. `ToRide.app` を右クリック（または Control + クリック）
2. 「開く」を選択
3. 確認ダイアログで「開く」をクリック

以降は通常どおり起動できます。

### macOS: キーチェーンアクセスダイアログ

GitHub PAT を安全に保存するためにキーチェーンを使用しています。コード署名がないため「ToRide の真正性を確認できません」と表示されますが、**「常に許可」** をクリックしてください。

> 「常に許可」を選ぶと以降は表示されなくなります。「許可」（1回のみ）だと起動のたびに表示されます。  
> GitHub PAT を設定していない場合はこのダイアログは表示されません。

### Windows: SmartScreen の回避

「Windows によって PC が保護されました」と表示された場合：

1. 「詳細情報」をクリック
2. 「実行」をクリック

---

## 開発者向けセットアップ

```bash
# 依存関係インストール
npm install

# ネイティブモジュールのリビルド（必須）
# better-sqlite3 / node-pty をElectronのNode.jsバージョン向けに再コンパイル
npm run rebuild
```

## 開発

```bash
npm run dev
```

## ビルド（開発用）

```bash
npm run build
npm run start
```

## 配布用ビルド

```bash
# macOS Apple Silicon
npm run dist:mac-arm64

# macOS Intel
npm run dist:mac-x64

# Windows x64（要Windows環境 or GitHub Actions）
npm run dist:win

# 全プラットフォーム
npm run dist
```

成果物は `dist-electron/` に出力されます。

## 機能

### タスク管理

7種類のタスクタイプに対応した起票フォーム：

| タイプ | 用途 | フィールド |
|---|---|---|
| `feat` | 機能開発 | branch, 分岐元ブランチ, チケット URL, prompt |
| `design` | 設計 | output 先パス |
| `review` | PR レビュー | GitHub PR URL |
| `bugfix` | バグ修正 | branch, 分岐元ブランチ, チケット URL |
| `research` | 調査 | branch, prompt |
| `chore` | 雑務 | 作業ディレクトリ |
| `orchestrate` | 複数タスクの統括 | prompt（ミッション） |

ブランチ入力はオートコンプリート Combobox に対応。既存ブランチをプレフィックス一致順に候補表示します。プロンプト入力では変数チップをクリックしてカーソル位置に挿入できます。

チケット連携プラグインとして外部チケットシステム（Wrike / GitHub Issue など）をサポート。

タスクは `will_do → doing → done` の 3 ステータスで管理。

### タスク実行

「開始」ボタンで Claude Code を自動起動：

1. タスクの `repoId` に対応するリポジトリ内の空き pane を自動割り当て
2. `git checkout <branch>` で対象ブランチに切り替え
3. 割り当てた pane のパスで `claude` コマンドを起動
4. prompt があれば TUI 起動を検知して初期メッセージを自動入力・送信

起動ボタン横のプルダウンで起動モード（通常 / 自動許可 / 危険 / プラン）と実行モデルをタスクごとに指定できます。モデル一覧は `/v1/models` から動的取得します。

同一 pane で他のタスクが実行中の場合は競合警告を表示。chore タスクは pane を使わず `directory` を直接作業ディレクトリとして使用。orchestrate タスクは複数タスクを統括するコーディネーター役として起動し、pane を占有しません。

### ターミナル統合

実行中タスクの「対話を開く」から右スライドパネルで Claude Code セッションに接続。パネル幅は左端をドラッグして変更可能。複数タスクを切り替えてもセッションはバックグラウンドで維持。スリープ復帰・ウィンドウフォーカス時に自動再描画。

### キーボード操作

マウスを使わずにダッシュボードを操作できます。

#### カード間ナビゲーション

| キー | 動作 |
|---|---|
| `Tab` | 次のカード / ボタンへ移動 |
| `↑` / `↓` | 同じカラム内で上下のカードへ移動 |
| `←` / `→` | 左右のカラムへ移動 |
| `Space`（カードフォーカス時） | カード内の最初のボタンへ入る |
| `Tab`（ボタンフォーカス時） | 次のボタンへ移動 |
| `Esc`（ボタンフォーカス時） | カードに戻る |

#### ターミナル操作

| キー | 動作 |
|---|---|
| `t`（doing カードフォーカス時） | そのタスクのターミナルを開く |
| `Ctrl+\`` | ターミナルパネルを閉じる（対応カードにフォーカス戻し） |

#### ダイアログ

| キー | 動作 |
|---|---|
| `Esc` | 確認ダイアログを閉じる（キャンセル） |
| `Tab` | キャンセル / 確認ボタンを切り替え |
| `Enter` | フォーカス中のボタンを実行 |

### コンテキスト監視

Status Line Hook 経由（フォールバックは stdout パース）でコンテキスト使用量をリアルタイム表示：

- ～79%: 緑
- 80～89%: 黄（デスクトップ通知）
- 90%～: 赤（デスクトップ通知）

デスクトップ通知はクリックすると関連画面へジャンプします。

### ブランチステータス

5 秒間隔でポーリングし、実行中タスクの作業ディレクトリの git 状態を表示：

```
feature-name  ↑2 ↓0  (未コミット: 3ファイル)
```

### 複数リポジトリ対応

リポジトリ単位でペインをグループ管理：

- タスク作成時にリポジトリを選択（`feat` / `design` / `review` / `bugfix` / `research`）
- タスク開始時は選択リポジトリ内の空き pane にのみ割り当て（他リポジトリの pane は使用しない）
- 同一リポジトリの複数ワークツリーを別 pane にマッピングして並列実行が可能
- 左サイドバーでリポジトリ名ヘッダーつきのグループ表示（リポジトリが 2 つ以上の場合）
- 旧設定（`panes` 形式）は起動時に自動マイグレーション

### 開発サーバー管理

左サイドバーから pane ごとの開発サーバーを起動・停止。クリック 1 回でトグル。

- 設定画面でサーバーをドラッグ＆ドロップで並べ替え可能（青線インジケータで挿入位置を表示）
- 開発サーバーが異常終了した際にデスクトップ通知を表示

### GitHub PR 自動同期

GitHub API でレビュー依頼されている PR を定期取得し、未起票のものを `review` タスクとして自動作成。

- 同期間隔は設定画面で変更可能（デフォルト 5 分）
- 手動で「今すぐ同期」ボタンから即時実行も可能
- 重複タスク・アーカイブ済みのものは自動スキップ
- PR のリポジトリを git リモート URL と突き合わせて `repoId` を自動解決

### PR URL 自動検出

セッション中に作成された GitHub PR の URL を Status Line Hook のペイロードから検出し、実行中タスクに自動で紐付けます。タスクカードには `PR#番号` 形式のボタンが表示され、クリックでブラウザから PR を開けます。PR URL（PR 番号含む）は全文検索の対象にもなります。

### タスク完了通知・承認（Stop Hook 連携）

Claude Code が作業を終えると、タスクカードに承認バナーが表示されます。ユーザーが「承認」を押したときに `done` 列へ移動します。

**仕組み：**

1. アプリ起動時にローカル HTTP サーバーを立ち上げる（ポートは `stopHookPort` 設定、デフォルト 39457）
2. `~/.toride/port` にポートを書き込む
3. タスク開始時に `CLAUDE_TASK_ID` 環境変数を注入
4. Claude Code の Stop Hook が完了を検知して HTTP 通知を送信
5. タスクカードに「Claude が完了しました。承認しますか？」バナーを表示＋デスクトップ通知
6. ユーザーが「承認」→ `done` に遷移 / 「無視」→ バナーを消してセッション継続

**Stop Hook のインストール方法：**

設定画面（Settings > Claude Code Stop Hook）から「インストール」ボタンを押すだけ。`~/.claude/hooks/stop.sh` が自動作成されます。

### コンテキスト使用量リアルタイム更新（Status Line Hook 連携）

Claude Code の Status Line 機能を使い、各 API レスポンス後にコンテキスト使用量を正確にリアルタイム更新します。

**仕組み：**

1. 設定画面（Settings > Status Line Hook）から「インストール」をクリック
2. `~/.claude/statusline.sh` と `~/.claude/settings.json` の statusLine 設定が自動作成
3. Claude Code が API を呼び出すたびに statusline.sh が HTTP サーバーへ使用量を送信
4. コンテキストメーターが即時更新（stdout パースはフォールバック）

### セッション再開機能

完了（`done`）タスクを以前の Claude Code セッションから続けて再開できます。

- タスク起動時に UUID を生成し `--session-id` フラグで Claude に渡して保存
- 完了タスクカードに「再開」ボタンを表示（`sessionId` がある場合のみ）
- 「再開」を押すと `claude --resume <uuid>` で前のセッションを継続
- 別ペインでも再開可能（Claude セッションはグローバル保存）

### MCP サーバー統合（Claude Code からタスク操作）

Claude Code のセッション内から直接タスクを作成・参照・更新できます。

**インストール方法：**

設定画面（Settings > MCP Server）から「インストール」ボタンを押すだけ。`~/.claude/settings.json` の `mcpServers` に自動登録されます。

**利用可能な MCP ツール：**

| ツール | 説明 |
|---|---|
| `create_task` | タスクマネージャーに新しいタスクを登録 |
| `list_tasks` | タスク一覧を取得（ステータスフィルタ対応） |
| `list_repos` | 登録済みリポジトリの一覧を取得 |
| `update_task` | タスクのステータス・プロンプトを更新 |
| `delete_task` | タスクを削除 |
| `start_task` | タスクを起動（`launchMode` で起動モード指定可） |
| `list_dev_servers` | 開発サーバー一覧を取得（workdir・実行中タスク情報つき） |
| `start_dev_server` | 開発サーバーを起動 |
| `stop_dev_server` | 開発サーバーを停止 |

Claude Code のプロンプトから「タスク作成して」と指示するだけでダッシュボードにタスクが追加されます。

### アーカイブ

完了タスクをアーカイブしてダッシュボードを整理。「一括アーカイブ」ボタンで done 列のタスクをまとめてアーカイブできます（フィルタ適用中は表示中のタスクのみ対象）。`/archive` 画面で過去のタスクを参照・削除。

## 設定

### GUI から設定する

初回起動後、右上の「設定」から各項目を入力：

1. **リポジトリ / pane マッピング**：リポジトリを追加し、その中に pane（作業ディレクトリ）を登録
   ```
   リポジトリ: my-app
     p1  →  /Users/yourname/projects/my-app
     p2  →  /Users/yourname/projects/my-app-wt2  (ワークツリー)

   リポジトリ: my-backend
     p3  →  /Users/yourname/projects/my-backend
   ```
2. **開発サーバー**：各 pane で起動可能なサーバーコマンドを設定
3. **GitHub PAT**：PR ステータスバッジ表示・PR 自動同期用（`safeStorage` で暗号化保存）

   **必要なスコープ（Classic PAT）**

   | スコープ | 用途 | 必要条件 |
   |---|---|---|
   | `repo` | プライベートリポジトリの PR 取得 | プライベートリポジトリを使う場合 |
   | `public_repo` | パブリックリポジトリの PR 取得 | パブリックリポジトリのみの場合 |

   > ほとんどの場合は **`repo`** スコープひとつで十分です。`read:user` は不要。

   **Fine-grained PAT を使う場合**

   | Permission | Level |
   |---|---|
   | Repository: **Pull requests** | Read-only |
   | Repository: **Metadata** | Read-only |

   Fine-grained PAT はリポジトリを個別に指定するか "All repositories" を選択してください。

   > **PR が取得できない場合 — SAML SSO の確認**
   >
   > 組織が SAML SSO を強制している場合、PAT を組織に対して個別に認可する必要があります。認可されていないと Search API が対象組織の結果を返さず、PRが取得されません。
   >
   > **認可手順：**
   > 1. GitHub → Settings → Developer settings → Personal access tokens
   > 2. 使用中の PAT の横にある **「Configure SSO」** をクリック
   > 3. 対象組織の横の **「Authorize」** をクリックして SAML 認証を完了
   >
   > 認可後に「今すぐ同期」を押して取得できるか確認してください。

4. **GitHub ユーザー名 + 同期間隔**：PR 自動同期の設定
5. **Stop Hook**：「インストール」ボタンを押して `~/.claude/hooks/stop.sh` を設置。Claude Code がタスクを完了した際に自動でステータスを更新します。
6. **Status Line Hook**：「インストール」ボタンを押して `~/.claude/statusline.sh` を設置。各 API 呼び出し後にコンテキスト使用量をリアルタイム更新します。
7. **MCP Server**：「インストール」ボタンを押して `~/.claude/settings.json` に MCP サーバーを登録。Claude Code のセッション内からタスクを操作できるようになります。

### 設定ファイル（JSON）でまとめて設定する

設定画面の **「JSONをインポート」** ボタンから `settings.example.json` を参考に作成した JSON ファイルを読み込むことで、全設定を一括適用できます。

**① `settings.example.json` をコピーして編集**

```bash
cp settings.example.json my-settings.json
```

```json
{
  "repos": [
    {
      "id": "repo1",
      "name": "my-app",
      "panes": [
        {
          "id": "p1",
          "path": "/Users/yourname/projects/my-app",
          "devServers": [
            {
              "label": "Dev",
              "command": "npm",
              "args": ["run", "dev"],
              "url": "3000"
            },
            {
              "label": "Storybook",
              "command": "npm",
              "args": ["run", "storybook"],
              "url": "https://localhost.example.test:6006"
            }
          ]
        },
        {
          "id": "p2",
          "path": "/Users/yourname/projects/my-app-wt2",
          "devServers": []
        }
      ]
    },
    {
      "id": "repo2",
      "name": "my-backend",
      "panes": [
        {
          "id": "p3",
          "path": "/Users/yourname/projects/my-backend",
          "devServers": []
        }
      ]
    }
  ],
  "githubPat": "ghp_xxxxxxxxxxxxxxxxxxxx",
  "githubUsername": "your-github-username",
  "githubPrSyncIntervalMin": 5,
  "useDangerouslySkipPermissions": false,
  "promptTemplates": {
    "feat": "以下のタスクを実装してください。\n\nタイトル: {title}\nブランチ: {branch}\nチケット: {ticket}\n\n{prompt}",
    "design": "以下の設計書を作成してください。\n\nタイトル: {title}\n出力先: {output}",
    "review": "以下のPRをレビューしてください。\n\nタイトル: {title}\nPR URL: {pr-url}\n\nコードの品質・バグ・セキュリティの観点でレビューしてください。",
    "bugfix": "以下のバグを修正してください。\n\nタイトル: {title}\nブランチ: {branch}\nチケット: {ticket}",
    "research": "以下のテーマを調査してください。\n\nタイトル: {title}\nブランチ: {branch}\n\n{prompt}",
    "chore": "以下の作業を実施してください。\n\nタイトル: {title}\nディレクトリ: {directory}"
  },
  "backgroundImageDir": "/Users/yourname/Pictures/wallpapers",
  "backgroundIntervalSec": 30
}
```

**② 設定画面でインポート**

設定画面右上の「JSONをインポート」ボタンをクリック → 作成した JSON ファイルを選択 → 「保存」で完了。

**③ 設定のエクスポート（バックアップ）**

「JSONをエクスポート」ボタンから現在の設定を JSON ファイルとして書き出せます（GitHub PAT はセキュリティのため除外されます）。

### 設定項目一覧

| フィールド | 型 | 説明 |
|---|---|---|
| `repos` | `RepoConfig[]` | リポジトリ設定の配列 |
| `repos[].id` | `string` | リポジトリ識別子（例: `"repo1"`） |
| `repos[].name` | `string` | 表示名（例: `"my-app"`） |
| `repos[].panes` | `PaneConfig[]` | このリポジトリに属する pane の配列 |
| `repos[].panes[].id` | `string` | pane 識別子（例: `"p1"`） |
| `repos[].panes[].path` | `string` | 作業ディレクトリの絶対パス（ワークツリーパス可） |
| `repos[].panes[].devServers` | `DevServer[]` | 開発サーバー定義（label / command / args / url）。`url` はポート番号（`"3000"` → `http://localhost:3000`）またはローカル環境のURL（`https://localhost.example.test:3000` など）を指定 |
| `githubPat` | `string` | GitHub Personal Access Token（暗号化保存）。Classic PAT なら `repo` スコープ、Fine-grained PAT なら Pull requests / Metadata の Read-only が必要 |
| `githubUsername` | `string` | GitHub ユーザー名（PR 自動同期用） |
| `githubPrSyncIntervalMin` | `number` | PR 自動同期間隔（分、デフォルト `5`） |
| `useDangerouslySkipPermissions` | `boolean` | `claude --dangerously-skip-permissions` で起動（デフォルト `false`） |
| `useAutoMode` | `boolean` | `claude --permission-mode auto` で起動（デフォルト `false`） |
| `promptTemplates` | `object` | タスクタイプ別の初期プロンプトテンプレート |
| `orchestrateSystemPrompt` | `string` | orchestrate タスク起動時に付与するシステムプロンプト（未設定時はデフォルト） |
| `notificationsEnabled` | `boolean` | デスクトップ通知の有効/無効（デフォルト `true`） |
| `stopHookPort` | `number` | ローカル HTTP サーバーのポート（デフォルト `39457`） |
| `extraPaths` | `string[]` | 子プロセス（git hooks 等）に追加する PATH エントリ |
| `backgroundImageDir` | `string` | 背景スライドショー用の画像ディレクトリ絶対パス |
| `backgroundIntervalSec` | `number` | スライドショー切替間隔（秒、デフォルト `30`） |

### Claude Code 側の設定（Stop Hook）

Stop Hook を使うには、Claude Code 側に hook スクリプトが必要です。**設定画面からインストールするのが最も簡単です**（上記手順 5）。

手動でインストールする場合は `~/.claude/hooks/stop.sh` を以下の内容で作成し、実行権限（`chmod 755`）を付与してください：

```sh
#!/bin/sh
# ToRide - Stop Hook
PORT_FILE="$HOME/.toride/port"
if [ -z "$CLAUDE_TASK_ID" ] || [ ! -f "$PORT_FILE" ]; then
  exit 0
fi
PORT=$(cat "$PORT_FILE")
curl -s -X POST "http://127.0.0.1:$PORT/task-done" \
  -H "Content-Type: application/json" \
  -d "{\"taskId\":\"$CLAUDE_TASK_ID\"}" || true
```

**動作仕様：**

- `CLAUDE_TASK_ID` が未設定（アプリ管理外のセッション）の場合は何もしない
- アプリが未起動でポートファイルが存在しない場合はスキップ（Claude Code の動作に影響しない）
- curl が失敗しても `|| true` で hook は常に `exit 0` を返す
- グローバルインストール（`~/.claude/hooks/stop.sh`）なので全プロジェクトで機能する

### プロンプトテンプレート変数

`promptTemplates` 内で使用できる変数：

| 変数 | 対応タイプ | 内容 |
|---|---|---|
| `{title}` | 全タイプ | タスクタイトル |
| `{branch}` | feat / bugfix / research | ブランチ名 |
| `{ticket}` | feat / bugfix | チケット URL |
| `{prompt}` | feat / research | タスク固有のプロンプト |
| `{output}` | design | 出力先パス |
| `{pr-url}` | review | GitHub PR URL |
| `{directory}` | chore | 作業ディレクトリ |

## ディレクトリ構造

```
├── electron/
│   ├── main/
│   │   ├── index.ts              # Electron エントリポイント
│   │   ├── db/schema.ts          # SQLite スキーマ
│   │   ├── services/             # ビジネスロジック
│   │   └── ipc/                  # IPC ハンドラ
│   └── preload/index.ts          # contextBridge API 公開
└── src/
    ├── components/               # UI コンポーネント
    ├── stores/                   # Zustand ストア
    ├── pages/                    # ページコンポーネント
    └── types/                    # 型定義
```
