import { ipcMain, Notification, type BrowserWindow } from 'electron'
import { deleteImages } from '../services/ImageStore'
import type { TaskService } from '../services/TaskService'
import type { AppSettings } from '../../../src/types/ipc'
import type { Task, RuntimeTaskState } from '../../../src/types/task'

export function registerTaskHandlers(
  taskService: TaskService,
  getSettings: () => Pick<AppSettings, 'notificationsEnabled'>,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle('tasks:list', async () => {
    try {
      return taskService.list()
    } catch (error) {
      throw new Error(`Failed to list tasks: ${(error as Error).message}`)
    }
  })

  ipcMain.handle(
    'tasks:create',
    async (_, data: Omit<Task, 'id' | 'created_at'>) => {
      try {
        return taskService.create(data)
      } catch (error) {
        throw new Error(`Failed to create task: ${(error as Error).message}`)
      }
    }
  )

  ipcMain.handle(
    'tasks:update',
    async (_, { id, data }: { id: string; data: Partial<Task & RuntimeTaskState> }) => {
      try {
        const existing = taskService.list().find((t) => t.id === id)
        const result = taskService.update(id, data)

        if (
          existing &&
          existing.status === 'doing' &&
          data.status === 'done'
        ) {
          const { notificationsEnabled = true } = getSettings()
          if (notificationsEnabled) {
            const notification = new Notification({
              title: '完了',
              body: `タスク "${result.title}" が完了しました`
            })
            notification.on('click', () => {
              const win = getWindow()
              win?.show()
              win?.focus()
              win?.webContents.send('navigation:goto', { type: 'task', taskId: id })
            })
            notification.show()
          }
        }

        return result
      } catch (error) {
        throw new Error(`Failed to update task: ${(error as Error).message}`)
      }
    }
  )

  ipcMain.handle('tasks:delete', async (_, id: string) => {
    try {
      const task = taskService.list().find((t) => t.id === id)
      taskService.delete(id)
      if (task?.images?.length) deleteImages(task.images)
    } catch (error) {
      throw new Error(`Failed to delete task: ${(error as Error).message}`)
    }
  })

  ipcMain.handle('tasks:archive', async (_, id: string) => {
    try {
      taskService.archive(id)
    } catch (error) {
      throw new Error(`Failed to archive task: ${(error as Error).message}`)
    }
  })

  ipcMain.handle('tasks:list-archived', async () => {
    try {
      return taskService.listArchived()
    } catch (error) {
      throw new Error(`Failed to list archived tasks: ${(error as Error).message}`)
    }
  })

  ipcMain.handle('tasks:delete-archived', async (_, id: string) => {
    try {
      const entry = taskService.listArchived().find((e) => e.id === id)
      taskService.deleteArchived(id)
      if (entry?.task_data.images?.length) deleteImages(entry.task_data.images)
    } catch (error) {
      throw new Error(`Failed to delete archived task: ${(error as Error).message}`)
    }
  })

  ipcMain.handle('tasks:archive-all-done', async () => {
    try {
      return taskService.archiveAllDone()
    } catch (error) {
      throw new Error(`Failed to archive all done tasks: ${(error as Error).message}`)
    }
  })

  ipcMain.handle('tasks:delete-all-archived', async () => {
    try {
      const images = taskService.listArchived().flatMap((e) => e.task_data.images ?? [])
      const count = taskService.deleteAllArchived()
      if (images.length) deleteImages(images)
      return count
    } catch (error) {
      throw new Error(`Failed to delete all archived tasks: ${(error as Error).message}`)
    }
  })

  ipcMain.handle('tasks:restore-archived', async (_, id: string) => {
    try {
      return taskService.restoreFromArchive(id)
    } catch (error) {
      throw new Error(`Failed to restore archived task: ${(error as Error).message}`)
    }
  })
}
