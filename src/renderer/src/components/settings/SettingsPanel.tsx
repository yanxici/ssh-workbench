import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  FolderOpen,
  Info,
  Keyboard,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare
} from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUpdateStore } from '@/stores/updateStore'
import { call } from '@/lib/ipc'
import { BrandMark, Modal } from '@/components/ui'
import { useI18n, type I18nKey, type Lang } from '@/i18n'
import { cn } from '@/lib/utils'
import { AppearanceSection } from './AppearanceSection'
import { BehaviorSection } from './BehaviorSection'
import { DangerSection } from './DangerSection'
import { ErrorLogSection } from './ErrorLogSection'
import { ExperimentalSection } from './ExperimentalSection'
import { KnownHostsSection } from './KnownHostsSection'
import { LayoutSection } from './LayoutSection'
import { NotifySection } from './NotifySection'
import { OutputHighlightSection } from './OutputHighlightSection'
import { Row, Segmented, SettingsCard } from './sectionUi'
import { ShortcutSection } from './ShortcutSection'
import { TerminalSection } from './TerminalSection'
import { TransferSection } from './TransferSection'
import { UpdateSection } from './UpdateSection'

type SettingsTabId = 'general' | 'terminal' | 'workflow' | 'shortcuts' | 'security' | 'system'

interface SettingsTabDef {
  id: SettingsTabId
  labelKey: I18nKey
  descKey: I18nKey
  icon: typeof Palette
}

const SETTINGS_TABS: SettingsTabDef[] = [
  {
    id: 'general',
    labelKey: 'settings.tab.general',
    descKey: 'settings.tab.general.desc',
    icon: Palette
  },
  {
    id: 'terminal',
    labelKey: 'settings.tab.terminal',
    descKey: 'settings.tab.terminal.desc',
    icon: TerminalSquare
  },
  {
    id: 'workflow',
    labelKey: 'settings.tab.workflow',
    descKey: 'settings.tab.workflow.desc',
    icon: SlidersHorizontal
  },
  {
    id: 'shortcuts',
    labelKey: 'settings.tab.shortcuts',
    descKey: 'settings.tab.shortcuts.desc',
    icon: Keyboard
  },
  {
    id: 'security',
    labelKey: 'settings.tab.security',
    descKey: 'settings.tab.security.desc',
    icon: ShieldCheck
  },
  {
    id: 'system',
    labelKey: 'settings.tab.system',
    descKey: 'settings.tab.system.desc',
    icon: Info
  }
]

/**
 * Portix 设置面板：左侧 6 选项卡分类导航 + 右侧卡片式详情区。
 */
export function SettingsPanel({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.update)
  const version = useUpdateStore((s) => s.status?.currentVersion)
  const { lang, t } = useI18n()
  const [activeTab, setActiveTab] = useState<SettingsTabId>('general')
  const [paths, setPaths] = useState<{ dataDir: string; userData: string } | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    setActiveTab('general')
    void call(window.api.settings.paths(), { silent: true }).then((p) => setPaths(p))
  }, [open])

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [activeTab])

  const setLang = (next: Lang): void => {
    if (next === lang) return
    void updateSettings({ language: next })
  }

  const currentTab = SETTINGS_TABS.find((item) => item.id === activeTab) ?? SETTINGS_TABS[0]

  return (
    <Modal
      open={open}
      title={t('settings.title')}
      onClose={onClose}
      width="max-w-3xl"
      bodyClassName="flex h-[540px] min-h-0 overflow-hidden p-0"
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          {t('settings.done')}
        </button>
      }
    >
      {/* Left category rail */}
      <aside className="flex w-[176px] shrink-0 flex-col justify-between border-r border-edge bg-chrome p-2">
        <div role="tablist" aria-label={t('settings.tab.navLabel')} className="space-y-0.5">
          {SETTINGS_TABS.map((tab) => {
            const Icon = tab.icon
            const active = tab.id === activeTab
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-settings-tab={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'relative flex h-8 w-full cursor-default items-center gap-2 rounded-md border px-2.5 text-left text-xs transition-colors duration-150',
                  active
                    ? 'border-edge bg-app font-medium text-ink shadow-card dark:bg-raised'
                    : 'border-transparent text-ink-2 hover:bg-hover hover:text-ink'
                )}
              >
                {active && (
                  <span className="pointer-events-none absolute bottom-1.5 left-0 top-1.5 w-[2px] rounded-r-full bg-brand" />
                )}
                <Icon size={14} className={cn('shrink-0', active ? 'text-accent' : 'text-ink-3')} />
                <span className="truncate">{t(tab.labelKey)}</span>
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-2 border-t border-edge-soft px-2 pt-2.5 text-2xs text-ink-3">
          <BrandMark size={18} className="shrink-0" />
          <span className="font-medium text-ink-2">Portix</span>
          {version && <span className="ml-auto font-mono text-3xs">v{version}</span>}
        </div>
      </aside>

      {/* Right content pane */}
      <div
        ref={contentRef}
        role="tabpanel"
        className="min-w-0 flex-1 overflow-y-auto bg-panel px-5 py-4 scroll-thin"
      >
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-ink">{t(currentTab.labelKey)}</h3>
          <p className="mt-0.5 text-2xs text-ink-3">{t(currentTab.descKey)}</p>
        </div>

        <div className="space-y-3">
          {activeTab === 'general' && (
            <>
              <SettingsCard id="language">
                <Row label={t('settings.language')} hint={t('settings.language.hint')}>
                  <Segmented<Lang>
                    value={lang}
                    options={[
                      { value: 'zh-CN', label: '中文' },
                      { value: 'en', label: 'English' }
                    ]}
                    onChange={setLang}
                  />
                </Row>
              </SettingsCard>

              <SettingsCard id="appearance" title={t('section.appearance')}>
                <AppearanceSection />
              </SettingsCard>

              <SettingsCard id="layout" title={t('section.layout')} hint={t('section.layout.hint')}>
                <LayoutSection />
              </SettingsCard>
            </>
          )}

          {activeTab === 'terminal' && (
            <>
              <SettingsCard id="terminal" title={t('section.terminal')}>
                <TerminalSection />
              </SettingsCard>

              <SettingsCard
                id="highlight"
                title={t('section.highlight')}
                hint={t('section.highlight.hint')}
              >
                <OutputHighlightSection />
              </SettingsCard>

              <SettingsCard id="notify" title={t('section.notify')} hint={t('section.notify.hint')}>
                <NotifySection />
              </SettingsCard>
            </>
          )}

          {activeTab === 'workflow' && (
            <>
              <SettingsCard
                id="behavior"
                title={t('section.behavior')}
                hint={t('section.behavior.hint')}
              >
                <BehaviorSection />
              </SettingsCard>

              <SettingsCard
                id="transfer"
                title={t('section.transfer')}
                hint={t('section.transfer.hint')}
              >
                <TransferSection />
              </SettingsCard>
            </>
          )}

          {activeTab === 'shortcuts' && (
            <SettingsCard
              id="shortcuts"
              title={t('section.shortcuts')}
              hint={t('section.shortcuts.hint')}
            >
              <ShortcutSection />
            </SettingsCard>
          )}

          {activeTab === 'security' && (
            <>
              <SettingsCard
                id="danger"
                title={t('section.danger')}
                hint={t('section.danger.hint', { count: settings.dangerPatterns.length })}
              >
                <DangerSection />
              </SettingsCard>

              <SettingsCard
                id="knownhosts"
                title={t('section.knownhosts')}
                hint={t(
                  settings.strictHostKey
                    ? 'section.knownhosts.hint.on'
                    : 'section.knownhosts.hint.off'
                )}
              >
                <KnownHostsSection />
              </SettingsCard>

              <SettingsCard
                id="privacy"
                title={t('section.privacy')}
                hint={t('section.privacy.hint')}
              >
                <div className="flex items-start gap-2 text-2xs leading-relaxed text-ink-3">
                  <ShieldCheck size={12} className="mt-0.5 shrink-0 text-success" />
                  <span>{t('privacy.noTelemetry')}</span>
                </div>
                <div className="pl-5 text-2xs leading-relaxed text-ink-3">
                  {t('privacy.egress')}
                </div>
                <div className="selectable pl-5 text-2xs leading-relaxed text-ink-3/80">
                  {t('privacy.verify')}
                </div>
              </SettingsCard>
            </>
          )}

          {activeTab === 'system' && (
            <>
              <SettingsCard id="update" title={t('section.update')} hint={t('section.update.hint')}>
                <UpdateSection />
              </SettingsCard>

              <SettingsCard
                id="experimental"
                title={t('section.experimental')}
                hint={t('section.experimental.hint')}
              >
                <ExperimentalSection />
              </SettingsCard>

              <SettingsCard
                id="errorlog"
                title={t('section.errorlog')}
                hint={t('section.errorlog.hint')}
              >
                <ErrorLogSection />
              </SettingsCard>

              <SettingsCard id="datadir" title={t('section.datadir')}>
                <div className="flex items-center gap-2 text-2xs text-ink-3">
                  <FolderOpen size={12} className="shrink-0" />
                  <span className="selectable break-all font-mono">{paths?.dataDir ?? '…'}</span>
                </div>
                <div className="text-2xs leading-relaxed text-ink-3">
                  {t('section.datadir.hint')}
                </div>
              </SettingsCard>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
