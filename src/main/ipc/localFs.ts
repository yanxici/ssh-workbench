import { app } from 'electron'
import { IPC } from '@shared/ipc'
import { handle } from './handle'
import { listDrives, localDelete, localList, localMkdir, localRename } from '../store/localFs'

/** 本地文件系统（文件管理器左栏） */
export function registerLocalFsIpc(): void {
  handle(IPC.LOCAL_HOME, () => app.getPath('home'))
  handle(IPC.LOCAL_DRIVES, () => listDrives())
  handle(IPC.LOCAL_LIST, (dir: string) => localList(dir))
  handle(IPC.LOCAL_MKDIR, (dir: string, name: string) => localMkdir(dir, name))
  handle(IPC.LOCAL_DELETE, (paths: string[]) => localDelete(paths))
  handle(IPC.LOCAL_RENAME, (from: string, to: string) => localRename(from, to))
}
