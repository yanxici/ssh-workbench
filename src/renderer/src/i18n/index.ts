import { useSettingsStore } from '@/stores/settingsStore'
import type { UiLanguage } from '@shared/types'

/**
 * 外壳文案的 i18n 基座。
 *
 * 只做这一件事：把「界面上写死的中文」变成可替换的键值。**不做**语言包懒加载、
 * 不做 ICU 复数、不做运行时热替换 —— 这个应用只有两种语言、没有复数规则，
 * 上一堆基建的收益不如把面板文案搬完。
 *
 * 词典是编译期常量，类型从 zh 推导：新增键却忘了补英文时
 * `const en: Record<I18nKey, string>` 会当场报错，而不是运行时悄悄 fallback 成中文。
 * 这是本文件唯一一处显得"费劲"的地方，因为它也是唯一能防住
 * 「加了中文、忘了英文」的机制。
 *
 * 覆盖范围：设置面板全部标题与说明。其余区域（侧栏、终端右键菜单等）仍是
 * 中文硬编码，由 scripts/verify-i18n.cjs 的基线记数，只减不增。
 */
export type Lang = UiLanguage

const zh = {
  'settings.title': '设置',
  'settings.done': '完成',
  'settings.language': '界面语言',
  'settings.language.hint': '只影响界面文案，不影响终端输出',
  'section.appearance': '外观',
  'section.terminal': '终端',
  'section.highlight': '输出高亮',
  'section.highlight.hint': '按关键词给终端输出染色（行级）',
  'section.notify': '通知',
  'section.notify.hint': '任务完成提示 / 系统通知 / 提示音 / 疑似完成',
  'section.behavior': '行为',
  'section.behavior.hint': '延迟探测 / 自动录像 / 跟随终端 / 指纹校验 / 面板位置',
  'section.transfer': '文件传输',
  'section.transfer.hint': '默认下载目录 / 重传跳过未变化文件',
  'section.layout': '侧栏宽度',
  'section.layout.hint': '拖动侧栏右侧的分隔条即可调整；双击分隔条恢复默认',
  'section.experimental': '实验性（设计 token 灰度）',
  'section.experimental.hint': '逐个面板启用新的间距 / 行高 / 动效规范，可随时全部关闭回到旧视觉',
  'section.shortcuts': '快捷键',
  'section.shortcuts.hint': '点击键位进入录制',
  'section.danger': '危险命令关键词',
  'section.danger.hint': '{count} 条',
  'section.knownhosts': '已知主机指纹',
  'section.knownhosts.hint.on': '严格校验已开启',
  'section.knownhosts.hint.off': '严格校验已关闭',
  'section.errorlog': '错误日志',
  'section.errorlog.hint': '运行期异常自动收集，可搜索、复制、导出给同事排查',
  'section.update': '软件更新',
  'section.update.hint': '检查更新 / 自动下载 / 更新源 / 更新代理',
  'section.datadir': '数据目录',
  'section.datadir.hint':
    '连接、常用命令、历史、设置均以 JSON 保存在该目录；密码 / 私钥口令单独加密存储（系统凭据保护），永不落明文。',
  'section.privacy': '隐私与诊断',
  'section.privacy.hint': '零遥测 / 零崩溃上报 / 出站域名可查',
  'privacy.noTelemetry': '不含任何遥测与崩溃上报：没有统计 SDK，崩溃日志只写本地文件，不会上传。',
  'privacy.egress': '应用只主动连接两类地址：更新源（Gitee 国内源 / GitHub 官方，或你在上面填的镜像）和你自己的 SSH 主机。',
  'privacy.verify': '可自查：scripts/verify-privacy.cjs 会静态扫描依赖与源码里的所有出站域名。',
  'terminal.copyOnSelect': '选中即复制',
  'terminal.copyOnSelect.hint': '鼠标拖选终端文字后自动写入剪贴板',
  'terminal.rightClickPaste': '右键快速复制粘贴',
  'terminal.rightClickPaste.hint': '有选区时右键复制、无选区时直接粘贴；按住 Shift+右键 仍可唤出菜单',
  'terminal.exportBuffer': '导出终端输出…',
  'terminal.exportBuffer.empty': '当前终端缓冲为空',
  'terminal.exportBuffer.done': '已导出终端输出',
  'terminal.exportBuffer.error': '导出终端输出失败',
  'editor.find': '查找',
  'editor.findPlaceholder': '查找内容…',
  'editor.replacePlaceholder': '替换为…',
  'editor.caseSensitive': '区分大小写',
  'editor.prevMatch': '上一个 (Shift+Enter)',
  'editor.nextMatch': '下一个 (Enter)',
  'editor.replaceOne': '替换',
  'editor.replaceAll': '全部替换',
  'editor.noMatch': '无匹配',
  'editor.matchOf': '{current}/{total}',
  'editor.closeFind': '关闭查找 (Esc)',
  'editor.lineCol': '行 {line}, 列 {col}',
  'editor.linesTotal': '共 {count} 行',
  'editor.encoding': '编码',
  'editor.saving': '保存中…',
  'editor.saved': '已保存',
  'editor.save': '保存',
  'editor.saveAndClose': '保存并关闭',
  'editor.close': '关闭',
  'editor.dirtyPrompt': '当前有未保存修改，关闭将丢失变更。',
  'editor.keepEditing': '继续编辑',
  'editor.discardClose': '放弃修改',
  'update.download': '下载更新',
  'update.restartInstall': '重启并安装',
  'update.checking': '检查中…',
  'update.checkNow': '立即检查',
  'update.openRelease': '打开发布页',
  'update.openGitee': '从 Gitee 下载',
  'update.openGitee.title': '国内镜像（Gitee）：GitHub 拉不动时从这里手动下载',
  'update.autoCheck': '启动时自动检查',
  'update.autoCheck.hint': '启动几秒后静默查一次（只读几 KB 的版本文件），有新版会在标题栏亮出「更新」',
  'update.autoDownload': '自动下载安装包',
  'update.autoDownload.hint': '默认关闭。现场网络按流量计费，几十兆的包在下之前应该由你点头',
  'update.channel': '更新通道',
  'update.channel.placeholder': '留空 = 自动（优先 Gitee 国内源，不通自动回退）',
  'update.channel.hint': '默认「自动」免代理优先走 Gitee 国内同源镜像，失败自动切换 GitHub 与公共加速站；也可指定单个通道，或填镜像前缀 / 内网 …/releases/latest/download 目录。',
  'update.channel.auto': '自动（优先国内）',
  'update.channel.gitee': 'Gitee 国内源',
  'update.channel.github': 'GitHub 官方',
  'update.proxy': '更新专用代理',
  'update.proxy.placeholder': 'http://127.0.0.1:7897（留空跟随系统代理）',
  'update.proxy.hint': '只影响更新包的下载，不影响 SSH 连接。填上本地代理后，「自动」模式会优先走 GitHub 官方源以享差量更新；改完对下一次检查即生效。',
  'update.meta.current': '当前版本 v{version}',
  'update.meta.latest': ' ｜ 发布源最新 v{version}',
  'update.meta.source': ' ｜ 通道：{source}',
  'update.status.unchecked': '尚未检查更新',
  'update.status.checking': '正在检查更新…',
  'update.status.available': '发现新版本 v{version}',
  'update.status.downloading': '正在下载 v{version}…',
  'update.status.downloaded': 'v{version} 已下载，重启即可完成更新',
  'update.status.error': '检查更新失败',
  'update.status.latest': '已是最新版本 v{version}'
} as const

export type I18nKey = keyof typeof zh

const en: Record<I18nKey, string> = {
  'settings.title': 'Settings',
  'settings.done': 'Done',
  'settings.language': 'Language',
  'settings.language.hint': 'Affects UI text only, never terminal output',
  'section.appearance': 'Appearance',
  'section.terminal': 'Terminal',
  'section.highlight': 'Output highlighting',
  'section.highlight.hint': 'Colour terminal output per line by keyword',
  'section.notify': 'Notifications',
  'section.notify.hint': 'Task finished / system toast / sound / heuristic',
  'section.behavior': 'Behaviour',
  'section.behavior.hint': 'Latency probe / auto record / follow cwd / host keys / panel side',
  'section.transfer': 'File transfer',
  'section.transfer.hint': 'Download folder / skip unchanged files on retry',
  'section.layout': 'Sidebar width',
  'section.layout.hint': 'Drag the splitter next to the sidebar; double-click it to reset',
  'section.experimental': 'Experimental (design tokens)',
  'section.experimental.hint': 'Opt in per panel to the new spacing / line-height / motion rules',
  'section.shortcuts': 'Shortcuts',
  'section.shortcuts.hint': 'Click a key combo to record a new one',
  'section.danger': 'Dangerous commands',
  'section.danger.hint': '{count} patterns',
  'section.knownhosts': 'Known host keys',
  'section.knownhosts.hint.on': 'Strict checking on',
  'section.knownhosts.hint.off': 'Strict checking off',
  'section.errorlog': 'Error log',
  'section.errorlog.hint': 'Runtime errors collected locally; searchable, copyable, exportable',
  'section.update': 'Updates',
  'section.update.hint': 'Check / auto-download / feed mirror / proxy',
  'section.datadir': 'Data folder',
  'section.datadir.hint':
    'Connections, snippets, history and settings are plain JSON here; passwords and key passphrases are encrypted by the OS credential store and never written in clear text.',
  'section.privacy': 'Privacy & diagnostics',
  'section.privacy.hint': 'No telemetry / no crash upload / auditable egress',
  'privacy.noTelemetry':
    'No telemetry and no crash upload. There is no analytics SDK; crash logs stay on disk.',
  'privacy.egress':
    'The app only ever contacts the update feed (Gitee mirror / GitHub, or the mirror you set above) and your own SSH hosts.',
  'privacy.verify':
    'Verify it yourself: scripts/verify-privacy.cjs statically scans dependencies and every URL in the source.',
  'terminal.copyOnSelect': 'Copy on select',
  'terminal.copyOnSelect.hint': 'Automatically copy selected terminal text to clipboard',
  'terminal.rightClickPaste': 'Right-click quick copy/paste',
  'terminal.rightClickPaste.hint':
    'Right-click copies when selected or pastes otherwise; hold Shift + right-click for menu',
  'terminal.exportBuffer': 'Export terminal output…',
  'terminal.exportBuffer.empty': 'Terminal buffer is empty',
  'terminal.exportBuffer.done': 'Terminal output exported',
  'terminal.exportBuffer.error': 'Failed to export terminal output',
  'editor.find': 'Find',
  'editor.findPlaceholder': 'Find…',
  'editor.replacePlaceholder': 'Replace with…',
  'editor.caseSensitive': 'Match case',
  'editor.prevMatch': 'Previous (Shift+Enter)',
  'editor.nextMatch': 'Next (Enter)',
  'editor.replaceOne': 'Replace',
  'editor.replaceAll': 'Replace all',
  'editor.noMatch': 'No match',
  'editor.matchOf': '{current}/{total}',
  'editor.closeFind': 'Close find (Esc)',
  'editor.lineCol': 'Ln {line}, Col {col}',
  'editor.linesTotal': '{count} lines',
  'editor.encoding': 'Encoding',
  'editor.saving': 'Saving…',
  'editor.saved': 'Saved',
  'editor.save': 'Save',
  'editor.saveAndClose': 'Save & Close',
  'editor.close': 'Close',
  'editor.dirtyPrompt': 'You have unsaved changes. Closing will discard them.',
  'editor.keepEditing': 'Keep editing',
  'editor.discardClose': 'Discard',
  'update.download': 'Download update',
  'update.restartInstall': 'Restart & install',
  'update.checking': 'Checking…',
  'update.checkNow': 'Check now',
  'update.openRelease': 'Release page',
  'update.openGitee': 'Download from Gitee',
  'update.openGitee.title': 'China mirror (Gitee): manual download fallback when GitHub is slow',
  'update.autoCheck': 'Check automatically on startup',
  'update.autoCheck.hint': 'Silently checks a few KB manifest after launch and lights up an Update chip in the title bar',
  'update.autoDownload': 'Auto-download installer',
  'update.autoDownload.hint': 'Off by default so metered field networks never pull tens of MB without confirmation',
  'update.channel': 'Update channel',
  'update.channel.placeholder': 'Empty = Auto (Gitee first in China, automatic fallback)',
  'update.channel.hint': 'Auto tries Gitee first without a proxy and falls back to GitHub / public mirrors; you can also pin one channel or enter a mirror prefix / intranet …/releases/latest/download URL.',
  'update.channel.auto': 'Auto (China first)',
  'update.channel.gitee': 'Gitee mirror',
  'update.channel.github': 'GitHub official',
  'update.proxy': 'Update proxy',
  'update.proxy.placeholder': 'http://127.0.0.1:7897 (empty = follow system proxy)',
  'update.proxy.hint': 'Applies to updates only, never SSH sessions. With a proxy set, Auto prefers GitHub first for differential updates; takes effect on the next check.',
  'update.meta.current': 'Current v{version}',
  'update.meta.latest': ' | Latest v{version}',
  'update.meta.source': ' | Channel: {source}',
  'update.status.unchecked': 'Not checked yet',
  'update.status.checking': 'Checking for updates…',
  'update.status.available': 'Update available: v{version}',
  'update.status.downloading': 'Downloading v{version}…',
  'update.status.downloaded': 'v{version} downloaded — restart to install',
  'update.status.error': 'Update check failed',
  'update.status.latest': 'Up to date (v{version})'
}

const DICTS: Record<Lang, Record<I18nKey, string>> = { 'zh-CN': zh, en }

/**
 * 取一条文案。
 *
 * `{name}` 占位符用最朴素的正则替换：外壳文案里没有复数、没有日期格式化，
 * 引 `Intl.MessageFormat` 是纯亏。
 */
export function translate(
  key: I18nKey,
  lang: Lang,
  vars?: Record<string, string | number>
): string {
  const raw = DICTS[lang]?.[key] ?? zh[key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole
  )
}

/** 组件里用这个：它订阅设置里的 language，切换语言即时重渲染 */
export function useI18n(): {
  lang: Lang
  t: (key: I18nKey, vars?: Record<string, string | number>) => string
} {
  const lang: Lang = useSettingsStore((s) => s.settings.language) ?? 'zh-CN'
  return { lang, t: (key, vars) => translate(key, lang, vars) }
}
