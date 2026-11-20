import { join } from 'node:path'
import type { AppSettings, TerminalPrefs } from '@shared/types'
import { JsonStore, dataDir } from '../jsonStore'

/** 应用设置 + 一次性外观迁移 */

const settingsStore = new JsonStore<Partial<AppSettings>>(
  join(dataDir(), 'settings.json'),
  () => ({})
)

/**
 * 外观外壳版本号。
 *
 * 每次「外壳整体换一版设计」就 +1，用于把老用户的设置一次性迁移到新默认值：
 * 老版本（没有这个字段）存的是 dark + workbench 配色 + 旧字体链，
 * 而这些值恰好就是旧默认值 —— 分不清「用户主动选的」和「安装时写进去的」。
 * 用版本号一刀切做一次性迁移，比猜用户意图可靠；迁移只发生一次，
 * 之后用户再改成什么都由他自己说了算。
 */
const UI_SHELL_VERSION = 2

/** 旧版默认字体链，仅用于迁移时判断「用户没改过」 */
const LEGACY_FONT_FAMILY =
  "'JetBrains Mono', 'Cascadia Code', Consolas, 'Microsoft YaHei Mono', monospace"
const NEW_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', Consolas, monospace"

/**
 * 一次性外观迁移。
 *
 * 只在这三种情况下改值：
 * - 完全没有 uiShellVersion（老配置）：外壳整体换代，主题/配色/字体直接对齐新规范；
 * - uiShellVersion 小于当前值：逐版补丁；
 * - 字体仍旧等于旧默认值：说明用户没自定义过，跟着换。
 * 用户自己改过的字体、以及迁移过一次之后的任何设置，一律不动。
 */
function migrateShell(stored: Partial<AppSettings>): Partial<AppSettings> {
  const from = stored.uiShellVersion ?? 0
  if (from >= UI_SHELL_VERSION) return stored

  const next: Partial<AppSettings> = { ...stored, uiShellVersion: UI_SHELL_VERSION }

  // v1 → v2：绿色标题栏外壳上线，默认切到浅色 + VS Code 配色
  if (from < 2) {
    next.theme = 'light'
    next.colorTheme = 'vscode'
    if (!stored.terminal?.fontFamily || stored.terminal.fontFamily === LEGACY_FONT_FAMILY) {
      next.terminal = { ...stored.terminal, fontFamily: NEW_FONT_FAMILY } as TerminalPrefs
    }
    /*
     * 侧栏默认宽度 250 → 280。250 是旧三栏外壳的默认值，那时侧栏里只放连接
     * 列表；新外壳的侧栏要放文件树、命令按钮墙、日志表格，250 会把
     * `root@192.168.100.120` 截断成 `root@192.168.100.…`。
     * 用户真正拖过的其它宽度保持不动 —— 只认「等于旧默认值」这一种情况。
     */
    if (stored.layout?.sidebar === undefined || stored.layout.sidebar === 250) {
      next.layout = { ...stored.layout, sidebar: 280 }
    }
  }

  return next
}

export const DEFAULT_SETTINGS: AppSettings = {
  // 新外观外壳（绿色标题栏 / 浅色工作区）是按浅色规范设计的，
  // 所以首装默认走 light + vscode 配色；老用户存了别的值就继续用他的。
  theme: 'light',
  colorTheme: 'vscode',
  terminal: {
    // 与设计规范一致：JetBrains Mono → Fira Code → Consolas 兜底。
    // 去掉了 'Cascadia Code' 与 'Microsoft YaHei Mono' —— 前者与 JetBrains Mono
    // 字形宽度接近但大写字高不同，混排时中英混排基线会跳；后者是中文等宽，
    // 只在没有前两者时才有意义，写上反而让 font-family 匹配链变长。
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    fontSize: 13.5,
    lineHeight: 1.35,
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 5000,
    copyOnSelect: false,
    rightClickPaste: false
  },
  uiShellVersion: UI_SHELL_VERSION,
  /*
   * 实验性开关默认全部关闭：新 token 必须先让用户/我在设置里显式打开，
   * 才不会出现「升级后视觉突然变了但不知道是哪一步」的情况。
   *
   * 缺省值写在这里而不是渲染层 FALLBACK：主进程是 settings.json 的唯一写入方，
   * 两边各写一份必然漂移（阶段 0 审计里就有 FALLBACK 与 DEFAULT_SETTINGS 不一致的先例）。
   */
  experimental: { tokens: {}, terminalRenderer: 'dom', motion: true },
  commandPanelPosition: 'right',
  latencyProbe: true,
  autoLog: true,
  // 纯文本日志 + 时间戳默认都开：现场排查要的是能 grep、能与设备日志对表的那一份
  logPlainText: true,
  logTimestamp: true,
  dangerPatterns: [
    'rm -rf',
    'mkfs',
    'dd if=',
    'dd of=/dev/',
    'shutdown',
    'reboot',
    'poweroff',
    '> /dev/sd',
    'chmod -R 777 /',
    'kill -9 1'
  ],
  strictHostKey: true,
  // 终端 cd 之后侧栏文件面板跟过去 —— 这是「我以为它本来就会这样」的行为，
  // 所以默认开。注意渲染层用 `!== false` 判定，老配置（没有这个键）同样是开。
  filesFollowTerminalCwd: true,
  // 现场设备网络抖动频繁，默认开启自动重连；仍可在设置里关掉
  autoReconnect: true,
  autoReconnectMax: 5,
  /*
   * 更新默认值。
   *
   * autoCheck 开、autoDownload 关 —— 这是现场网络下的最优组合：
   * 启动几秒后静默查一次（代价只是几 KB 的 latest.yml），有新版本仅在
   * 标题栏亮一个「更新」小按钮；78MB 的安装包等用户自己点才下。
   * 反过来（自动下载）会在用户毫无预期时吃掉几百兆流量，漫游卡尤其致命。
   */
  update: {
    autoCheck: true,
    autoDownload: false,
    proxyUrl: ''
  },
  /*
   * 任务完成通知。
   *
   * enabled/system 默认开：跑完一条三分钟的固件升级、或者 20 台设备的批量
   * 巡检，用户早就切去干别的了，回来才发现跑完了 —— 这类"结果需要知道但
   * 不需要盯"的任务，通知是唯一有用的形态。
   *
   * heuristic 默认关：见 TaskNotifyPrefs 里的注释，猜错的代价比漏报高。
   * sound 默认关：现场办公室一排人都在用，默认响会被要求关掉。
   */
  taskNotify: {
    enabled: true,
    system: true,
    sound: false,
    heuristic: false,
    mutedConnectionIds: []
  },
  /*
   * 分屏布局默认空表。
   * 不预置任何树 —— 没有树的连接就是单格标签，
   * 这比「每个连接都预置一棵单叶树」少一整类「树里只有一个叶子」的边界情况。
   */
  splitLayout: {}
}

function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...patch,
    terminal: { ...base.terminal, ...(patch.terminal ?? {}) },
    /*
     * experimental 必须逐键合并。
     * 老配置里存的是 `{ tokens: {} }`（没有 terminalRenderer），整段覆盖会把
     * 默认后端抹掉，之后每次读设置都要靠调用点自己 `?? 'dom'` 兜底 —— 一处漏写
     * 就回到 WebGL 字形变小的老问题上。合并后缺省值始终在。
     */
    experimental: { ...base.experimental, ...(patch.experimental ?? {}) },
    /*
     * taskNotify 同样逐键合并。mutedConnectionIds 是数组，合并时整体覆盖 ——
     * 但正因为是数组，patch 里只要出现这个键就必须是**完整**的静音列表
     * （渲染层每次都是把新数组整个传上来），否则会被默认的空数组清掉。
     */
    taskNotify: { ...base.taskNotify, ...(patch.taskNotify ?? {}) } as AppSettings['taskNotify'],
    splitLayout: patch.splitLayout ?? base.splitLayout,
    dangerPatterns: patch.dangerPatterns ?? base.dangerPatterns
  }
}

export async function getSettings(): Promise<AppSettings> {
  const stored = await settingsStore.read()
  const migrated = migrateShell(stored)
  return mergeSettings(DEFAULT_SETTINGS, migrated)
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  // 走 update 串行读改写：并发修改（如新建分组的同时切主题）不会互相覆盖
  const next = await settingsStore.update((stored) =>
    mergeSettings(mergeSettings(DEFAULT_SETTINGS, migrateShell(stored)), patch)
  )
  return next as AppSettings
}
