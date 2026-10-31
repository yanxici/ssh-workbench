import { ipcMain } from 'electron'
import { recordError } from '../store/errorLog'

/**
 * IPC 注册包装：主进程异常统一转成 { ok:false, error }，渲染层不感知异常。
 *
 * 放在独立文件而不是 index.ts，是因为拆分之后每个域文件都要用它；
 * 留在入口文件里会让 20 个 ipc/*.ts 全部反过来依赖入口（循环 import）。
 */

/** 把 IPC 通道名翻成人话标题，用户在错误日志面板里能直接看懂 */
function channelTitle(channel: string): string {
  const map: Record<string, string> = {
    'conn:save': '保存连接失败',
    'conn:delete': '删除连接失败',
    'conn:rename-group': '重命名连接分组失败',
    'conn:delete-group': '删除连接分组失败',
    'conn:delete-many': '批量删除连接失败',
    'conn:test': '测试连接失败',
    'session:open': '打开会话失败',
    'session:write': '终端写入失败',
    'sftp:list': '读取远程目录失败',
    'sftp:upload': '上传失败',
    'sftp:upload-folder-dialog': '上传文件夹失败',
    'sftp:scan-folders': '扫描本地文件夹失败',
    'sftp:download': '下载失败',
    'sftp:remove': '删除远程文件失败',
    'sftp:mkdir': '新建远程目录失败',
    'sftp:rename': '重命名远程文件失败',
    'sftp:chmod': '修改远程权限失败',
    'sftp:readText': '读取远程文件失败',
    'sftp:writeText': '写入远程文件失败',
    'tunnel:start': '启动端口转发失败',
    'diag:run': '诊断巡检失败',
    'batch:run': '批量执行失败'
  }
  return map[channel] ?? `操作失败（${channel}）`
}

/**
 * 注册一个 IPC 处理器，失败自动写错误日志。
 *
 * 在统一出口处记录的好处：不用每个 handler 各写一遍 try/catch，
 * 新增通道自动获得错误记录能力，也不会有人忘记加。
 *
 * 泛型签名的意义（原来是 `fn: (...args: never[]) => unknown`）：
 * never[] 让实参类型信息彻底丢失，handler 内部把 args 当 unknown[] 强转，
 * 于是「preload 传 arity/类型」与「主进程 handler 声明」之间没有任何类型关联 ——
 * 改错一个参数类型，typecheck 也不会报。现在用 A 把实参元组透传下去：
 * 声明 `handle<[string, string]>(CH, (a, b) => ...)` 时参数名与类型都会被检查。
 */
export function handle<A extends unknown[] = never[], R = unknown>(
  channel: string,
  fn: (...args: A) => R | Promise<R>
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      const data = await fn(...(args as unknown as A))
      return { ok: true, data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 错误日志自身失败不影响返回值（recordError 内部已兜底，这里再保险一次）
      void recordError({
        level: 'error',
        source: `ipc:${channel}`,
        title: channelTitle(channel),
        detail: message
      })
      return { ok: false, error: message }
    }
  })
}
