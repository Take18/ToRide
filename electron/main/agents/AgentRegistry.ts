import type { AgentId, AgentInfo } from '../../../src/types/ipc'
import { DEFAULT_AGENT_ID } from '../../../src/utils/agent'
import type { AgentProvider } from './types'

export { DEFAULT_AGENT_ID }

export class AgentRegistry {
  private providers = new Map<AgentId, AgentProvider>()

  constructor(providers: AgentProvider[]) {
    for (const p of providers) this.providers.set(p.id, p)
  }

  /** タスクの agent から provider を引く。未指定のタスク（既存タスク）は claude */
  get(id: AgentId | undefined): AgentProvider {
    const resolved = id ?? DEFAULT_AGENT_ID
    const provider = this.providers.get(resolved)
    if (!provider) throw new Error(`UNKNOWN_AGENT: ${resolved}`)
    return provider
  }

  /** 画面に出す一覧（タスクフォームの選択肢・設定画面の能力一覧） */
  list(): AgentInfo[] {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      displayName: p.displayName,
      capabilities: p.capabilities,
      launchModes: p.launchModes,
    }))
  }
}
