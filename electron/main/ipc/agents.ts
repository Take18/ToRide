import { ipcMain } from 'electron'
import type { AgentRegistry } from '../agents/AgentRegistry'
import type { CodexProvider } from '../agents/CodexProvider'
import type { CodexConfigService } from '../services/CodexConfigService'
import type { CodexStatus } from '../../../src/types/ipc'

export function registerAgentHandlers(
  agentRegistry: AgentRegistry,
  codexProvider: CodexProvider,
  codexConfigService: CodexConfigService
): void {
  ipcMain.handle('agents:list', () => agentRegistry.list())

  ipcMain.handle('codex:status', async (_, opts?: { refresh?: boolean }): Promise<CodexStatus> => {
    const [auth, panes] = await Promise.all([
      codexProvider.getAuthStatus(opts?.refresh ?? false),
      codexConfigService.listPanes(),
    ])
    return { ...auth, panes }
  })

  ipcMain.handle('codex:trust-panes', () => codexConfigService.trustPanes())
}
