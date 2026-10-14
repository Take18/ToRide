# 開発ドキュメント

## 資料一覧

| ファイル | 内容 |
|---|---|
| [architecture.md](architecture.md) | 技術スタック、ディレクトリ構成、プロセス間の境界 |
| [features.md](features.md) | タスク管理、Claude / Codex 連携、MCP、ローテーションなどの機能一覧 |
| [settings.md](settings.md) | AppSettings の項目、hook・サービスの設定先 |
| [design-decisions.md](design-decisions.md) | 設計上の制約、過去に問題になった挙動、実装の理由 |

利用者向けのセットアップ・操作手順は [ルートの README](../README.md)、エージェント向けの共通ルールは [AGENTS.md](../AGENTS.md) と [CLAUDE.md](../CLAUDE.md) にある。

## 更新方針

- `CLAUDE.md` と `AGENTS.md` は同一内容にする。常時必要なルール・検証コマンド・重要な設計制約を短く保つ。
- 詳細資料は必要な作業で参照する。機能や設定を変更したときは該当資料も更新する。
- このディレクトリには旧 `CLAUDE.md` の技術情報を移している。記述と実装が異なる場合はコードと型定義を確認し、資料を修正する。
- CLI の実測結果にはバージョンや確認時点を残す。アプリ内で管理する Claude / Codex の起動設定は、開発エージェントへの作業指示と区別する。
- 同じ詳細説明を複数の指示ファイルへ複製せず、`docs/` 内の該当資料への Markdown リンクを使う。

## 整理の参考にした公式ガイド

2026-10-14 に以下を確認。短い常設指示に作業ルール・検証方法・プロジェクト固有の制約を置き、詳細資料は参照に分ける構成とした。両エージェントの本文はこのリポジトリの運用方針として揃えている。

- [Claude Code: Best practices](https://code.claude.com/docs/en/best-practices)
- [Claude Code: Memory](https://code.claude.com/docs/en/memory)
- [OpenAI: Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
