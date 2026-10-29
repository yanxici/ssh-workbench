import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import { call } from '@/lib/ipc'
import { Modal } from '@/components/ui'
import { AppearanceSection } from './AppearanceSection'
import { BehaviorSection } from './BehaviorSection'
import { DangerSection } from './DangerSection'
import { ErrorLogSection } from './ErrorLogSection'
import { KnownHostsSection } from './KnownHostsSection'
import { LayoutSection } from './LayoutSection'
import { Section } from './sectionUi'
import { ShortcutSection } from './ShortcutSection'
import { TerminalSection } from './TerminalSection'
import { UpdateSection } from './UpdateSection'

/**
 * 设置面板总装。
 *
 * 原本这个文件 959 行，同时装了：4 个 UI 原子（Section / Row / Segmented /
 * ColorThemeGallery）、7 个业务分区、以及一段完整的指纹探测状态机。
 * 改「已知主机指纹」和改「终端字号」要动同一个文件。
 *
 * 现在按分区拆到 ./{Appearance,Terminal,Behavior,Layout,Shortcut,Danger,
 * KnownHosts}Section.tsx，UI 原子在 ./sectionUi.tsx，
 * 这里只负责布局顺序与 Modal 外壳。
 */
export function SettingsPanel({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const [paths, setPaths] = useState<{ dataDir: string; userData: string } | null>(null)

  useEffect(() => {
    if (!open) return
    void call(window.api.settings.paths(), { silent: true }).then((p) => setPaths(p))
  }, [open])

  return (
    <Modal
      open={open}
      title="设置"
      onClose={onClose}
      width="max-w-xl"
      footer={
        <button className="btn" onClick={onClose}>
          完成
        </button>
      }
    >
      <Section id="appearance" title="外观" defaultOpen>
        <AppearanceSection />
      </Section>

      <Section id="terminal" title="终端" defaultOpen>
        <TerminalSection />
      </Section>

      <Section
        id="behavior"
        title="行为"
        hint="延迟探测 / 自动录像 / 跟随终端 / 指纹校验 / 面板位置"
      >
        <BehaviorSection />
      </Section>

      <Section
        id="layout"
        title="侧栏宽度"
        hint="拖动侧栏右侧的分隔条即可调整；双击分隔条恢复默认"
      >
        <LayoutSection />
      </Section>

      <Section id="shortcuts" title="快捷键" hint="点击键位进入录制">
        <ShortcutSection />
      </Section>

      <Section id="danger" title="危险命令关键词" hint={`${settings.dangerPatterns.length} 条`}>
        <DangerSection />
      </Section>

      <Section
        id="knownhosts"
        title="已知主机指纹"
        hint={settings.strictHostKey ? '严格校验已开启' : '严格校验已关闭'}
      >
        <KnownHostsSection />
      </Section>

      <Section
        id="errorlog"
        title="错误日志"
        hint="运行期异常自动收集，可搜索、复制、导出给同事排查"
      >
        <ErrorLogSection />
      </Section>

      <Section id="update" title="软件更新" hint="检查更新 / 自动下载 / 更新代理">
        <UpdateSection />
      </Section>

      <Section id="datadir" title="数据目录">
        <div className="flex items-center gap-2 text-2xs text-ink-3">
          <FolderOpen size={12} className="shrink-0" />
          <span className="selectable break-all font-mono">{paths?.dataDir ?? '加载中…'}</span>
        </div>
        <div className="text-2xs leading-relaxed text-ink-3">
          连接、常用命令、历史、设置均以 JSON 保存在该目录；密码 / 私钥口令单独加密存储（系统凭据保护），永不落明文。
        </div>
      </Section>
    </Modal>
  )
}
