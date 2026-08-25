import { ipcMain, type BrowserWindow } from 'electron'
import type { TerminalService } from '../services/TerminalService'
import type { StopHookService } from '../services/StopHookService'
import type { SessionRotationService } from '../services/SessionRotationService'
import type { TerminalDataEvent } from '../../../src/types/ipc'

export function registerTerminalHandlers(
  terminalService: TerminalService,
  getWindow: () => BrowserWindow | null,
  stopHookService?: StopHookService,
  rotationService?: SessionRotationService
): void {
  ipcMain.handle(
    'terminal:start',
    async (_, { taskId, workdir }: { taskId: string; workdir: string }) => {
      try {
        terminalService.start(taskId, workdir)

        terminalService.onData(taskId, (data) => {
          const win = getWindow()
          if (win && !win.isDestroyed()) {
            const event: TerminalDataEvent = { taskId, data }
            win.webContents.send('terminal:data', event)
          }
        })
      } catch (error) {
        throw new Error(`Failed to start terminal: ${(error as Error).message}`)
      }
    }
  )

  ipcMain.handle(
    'terminal:write',
    async (_, { taskId, data }: { taskId: string; data: string }) => {
      try {
        terminalService.write(taskId, data)
      } catch (error) {
        throw new Error(`Failed to write to terminal: ${(error as Error).message}`)
      }
    }
  )

  ipcMain.handle('terminal:kill', async (_, taskId: string) => {
    try {
      terminalService.kill(taskId)
      stopHookService?.removeTaskCallback(taskId)
      rotationService?.clear(taskId)
    } catch (error) {
      throw new Error(`Failed to kill terminal: ${(error as Error).message}`)
    }
  })

  ipcMain.handle(
    'terminal:resize',
    async (
      _,
      { taskId, cols, rows }: { taskId: string; cols: number; rows: number }
    ) => {
      try {
        terminalService.resize(taskId, cols, rows)
      } catch (error) {
        throw new Error(`Failed to resize terminal: ${(error as Error).message}`)
      }
    }
  )
}
