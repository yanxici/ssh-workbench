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
  'privacy.egress': '应用只主动连接两类地址：更新源（GitHub 或你在上面填的镜像）和你自己的 SSH 主机。',
  'privacy.verify': '可自查：scripts/verify-privacy.cjs 会静态扫描依赖与源码里的所有出站域名。'
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
    'The app only ever contacts the update feed (GitHub or the mirror you set above) and your own SSH hosts.',
  'privacy.verify':
    'Verify it yourself: scripts/verify-privacy.cjs statically scans dependencies and every URL in the source.'
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
