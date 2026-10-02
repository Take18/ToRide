import type { AgentId } from '../../../src/types/ipc'
import type { AgentProvider } from './types'

export const DEFAULT_AGENT_ID: AgentId = 'claude'

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
}
