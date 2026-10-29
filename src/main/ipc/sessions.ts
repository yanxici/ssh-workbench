import { IPC } from '@shared/ipc'
import { handle } from './handle'
import { sessionManager } from '../ssh/sessionManager'

/** 会话 / 终端：开连接、开会话内新终端、输入、尺寸、广播、列表 */
export function registerSessionIpc(): void {
  handle(
    IPC.SESSION_OPEN,
    (input: { sessionId: string; connectionId: string; cols: number; rows: number }) =>
      sessionManager.open(input.sessionId, input.connectionId, input.cols, input.rows)
  )
  handle(
    IPC.SESSION_OPEN_SHELL,
    (input: {
      sessionId: string
      connectionId: string
      hostSessionId: string
      cols: number
      rows: number
    }) =>
      sessionManager.openShell(
        input.sessionId,
        input.connectionId,
        input.hostSessionId,
        input.cols,
        input.rows
      )
  )
  handle(IPC.SESSION_CLOSE, (sessionId: string) => sessionManager.close(sessionId))
  handle(IPC.SESSION_WRITE, (sessionId: string, data: string) =>
    sessionManager.write(sessionId, data)
  )
  handle(IPC.SESSION_RESIZE, (sessionId: string, cols: number, rows: number) =>
    sessionManager.resize(sessionId, cols, rows)
  )
  handle(IPC.SESSION_BROADCAST, (sessionIds: string[], data: string) =>
    sessionManager.broadcast(sessionIds, data)
  )
  handle(IPC.SESSION_LIST, () => sessionManager.list())
}
