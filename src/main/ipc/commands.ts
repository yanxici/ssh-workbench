import { BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import { IPC } from '@shared/ipc'
import type { CommandInput, HistoryFilter } from '@shared/types'
import { dialogParent } from '../windowRef'
import { handle } from './handle'
import {
  addHistory,
  clearHistory,
  deleteCommand,
  deleteCommandGroup,
  exportCommands,
  importCommands,
  listCommands,
  listHistory,
  renameCommandGroup,
  reorderCommands,
  saveCommand,
  touchCommand
} from '../store/repository'

/** 常用命令 + 命令历史（含导入导出） */
export function registerCommandIpc(): void {
  handle(IPC.CMD_LIST, () => listCommands())
  handle(IPC.CMD_SAVE, (input: CommandInput) => saveCommand(input))
  handle(IPC.CMD_DELETE, (id: string) => deleteCommand(id))
  handle(IPC.CMD_REORDER, (ids: string[]) => reorderCommands(ids))
  handle(IPC.CMD_RENAME_GROUP, (from: string, to: string) => renameCommandGroup(from, to))
  handle(IPC.CMD_DELETE_GROUP, (group: string) => deleteCommandGroup(group))
  handle(IPC.CMD_TOUCH, (id: string) => touchCommand(id))

  handle(IPC.CMD_IMPORT, async (mode: 'merge' | 'replace' = 'merge') => {
    const res = await dialog.showOpenDialog(dialogParent() as BrowserWindow, {
      title: '导入常用命令',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (res.canceled || res.filePaths.length === 0) {
      return { canceled: true, imported: 0, skipped: 0 }
    }
    const raw = await fs.readFile(res.filePaths[0], 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    const list = Array.isArray(parsed) ? parsed : (parsed as { commands?: unknown })?.commands
    const result = await importCommands(list, mode)
    return { canceled: false, ...result, path: res.filePaths[0] }
  })

  handle(IPC.CMD_EXPORT, async () => {
    const cmds = await exportCommands()
    const stamp = new Date().toISOString().slice(0, 10)
    const res = await dialog.showSaveDialog(dialogParent() as BrowserWindow, {
      title: '导出常用命令',
      defaultPath: `ssh-workbench-commands-${stamp}.json`,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true, count: 0 }
    await fs.writeFile(
      res.filePath,
      JSON.stringify({ version: 1, exportedAt: Date.now(), commands: cmds }, null, 2),
      'utf-8'
    )
    return { canceled: false, path: res.filePath, count: cmds.length }
  })

  handle(IPC.HIST_LIST, (filter: HistoryFilter) => listHistory(filter))
  handle(IPC.HIST_ADD, (entry: Parameters<typeof addHistory>[0]) => addHistory(entry))
  handle(IPC.HIST_CLEAR, (connectionId?: string) => clearHistory(connectionId))
}
