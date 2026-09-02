import { ipcMain } from 'electron'
import type { NotificationService } from '../services/NotificationService'

export function registerNotificationHandlers(service: NotificationService): void {
  ipcMain.handle('notifications:list', async () => service.list())

  ipcMain.handle('notifications:markRead', async (_, id: string) => {
    service.markRead(id)
    service.emitUpdated()
  })

  ipcMain.handle('notifications:markAllRead', async () => {
    service.markAllRead()
    service.emitUpdated()
  })

  ipcMain.handle('notifications:clear', async () => {
    service.clear()
    service.emitUpdated()
  })
}
