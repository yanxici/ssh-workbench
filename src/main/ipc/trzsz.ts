import { IPC } from '@shared/ipc'
import { sessionManager } from '../ssh/sessionManager'
import { handle } from './handle'

/**
 * trzsz（trz / tsz）文件传输的 IPC 入口。
 *
 * 与 zmodem.ts 的差别值得记一笔：ZMODEM 那套要做「选文件 → base64 → 渲染层拼帧 →
 * 每帧 base64 传回主进程」，因为 zmodem.js 只能跑在渲染层。trzsz 的过滤器在主进程
 * （见 ssh/trzszBridge.ts），所以这里只有两个动作：
 * - 让主进程按路径把文件推过去（路径由主进程自己弹框选，不经过渲染层）；
 * - 中断当前传输。
 *
 * 下载方向没有入口：远端执行 sz 后握手串出现在输出里，主进程自己会弹目录选择框。
 */
export function registerTrzszIpc(): void {
  /*
   * 主动上传。
   *
   * paths 允许为空 —— 那表示「面板里点的发送文件」，由主进程弹原生文件对话框；
   * 传了 paths 表示拖拽进来的真实路径（渲染层用 webUtils.getPathForFile 取的）。
   * 两条路都在主进程里选/读文件，渲染层永远不会拿到文件内容本身。
   */
  handle(IPC.TRZSZ_UPLOAD, async (sessionId: string, paths?: string[]) => {
    const trzsz = sessionManager.ensureTrzsz(sessionId)
    if (!trzsz) throw new Error('这条会话不能传文件（需要已连接的 SSH 会话）')
    await trzsz.upload(paths)
  })

  handle(IPC.TRZSZ_CANCEL, (sessionId: string) => {
    sessionManager.ensureTrzsz(sessionId)?.cancel()
  })
}
