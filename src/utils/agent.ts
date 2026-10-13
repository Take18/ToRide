import type { AgentCapabilities, AgentId, AppSettings } from '../types/ipc'
import type { TaskType } from '../types/task'

export const DEFAULT_AGENT_ID: AgentId = 'claude'

/** タスク作成時の既定エージェント。タスクタイプ別の設定 → 全体の設定 → claude の順に引く */
export function resolveDefaultAgent(
  settings: Pick<AppSettings, 'defaultAgentId' | 'agentDefaults'>,
  type: TaskType
): AgentId {
  return settings.agentDefaults?.[type] ?? settings.defaultAgentId ?? DEFAULT_AGENT_ID
}

/** 能力が足りないために使えない機能の一覧（カードのバッジ・設定画面に出す） */
export function listMissingFeatures(capabilities: AgentCapabilities): string[] {
  const missing: string[] = []
  if (capabilities.contextSource !== 'statusline') missing.push('コンテキスト表示（#77 で対応予定）')
  if (!capabilities.prDetection) missing.push('PR URL の自動検知')
  if (!capabilities.rotation) missing.push('セッションローテーション（#78 で対応予定）')
  return missing
}
