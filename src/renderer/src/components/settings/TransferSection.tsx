import type * as React from 'react'
import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import { call } from '@/lib/ipc'
import { useToastStore } from '@/stores/toastStore'
import { useI18n } from '@/i18n'
import { Row } from './sectionUi'

/**
 * 设置 → 文件传输。
 *
 * 目前只有「默认下载目录」一项，但它值得占一个分组：现场笔记本的系统盘
 * 往往很小，客户资料必须落到 D 盘或移动硬盘。没有这一项时，用户每下
 * 一次都要在系统对话框里重新点三次目录；有了一次设置，右键「下载」和
 * 侧栏「下载到下载文件夹」都直接落到那儿。
 *
 * 失效自动回退：路径可能指向已拔掉的移动硬盘。主进程 SFTP_DOWNLOADS_DIR
 * 会校验并回退系统「下载」，这里只负责展示当前生效值，不重复实现回退。
 */
export function TransferSection(): React.JSX.Element {
  const { t } = useI18n()
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const [effective, setEffective] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void call(window.api.sftp.downloadsDir(), { silent: true }).then((d) => {
      if (d) setEffective(d)
    })
  }, [settings.downloadDir])

  const pick = async (): Promise<void> => {
    setBusy(true)
    const res = await call(window.api.sftp.pickDownloadDir(), {
      errorTitle: t('settings.ext.transfer.pickError')
    })
    setBusy(false)
    if (!res || res.canceled) return
    /*
     * 选完要落盘。
     * 原来只 setEffective，settings.downloadDir 一直为空 ——
     * 提示写「已更改」、当前会话也确实生效，但重启就回去，
     * 而「恢复默认」按钮（按 settings.downloadDir 是否为空渲染）永远不出现。
     */
    await update({ downloadDir: res.dir })
    setEffective(res.dir)
    useToastStore.getState().push({
      kind: 'success',
      title: t('settings.ext.transfer.changed'),
      detail: res.dir
    })
  }

  const reset = async (): Promise<void> => {
    await update({ downloadDir: '' })
    const d = await call(window.api.sftp.downloadsDir(), { silent: true })
    if (d) setEffective(d)
  }

  return (
    <Row
      label={t('settings.ext.transfer.label')}
      hint={
        settings.downloadDir
          ? t('settings.ext.transfer.customHint', { dir: settings.downloadDir })
          : t('settings.ext.transfer.defaultHint')
      }
    >
      <span
        className="max-w-[180px] truncate text-2xs text-ink-3"
        title={effective || undefined}
      >
        {effective || t('settings.ext.transfer.loading')}
      </span>
      <button
        className="btn btn-ghost h-7 px-2 text-2xs"
        disabled={busy}
        onClick={() => void pick()}
      >
        <FolderOpen size={12} />
        {t('settings.ext.transfer.choose')}
      </button>
      {settings.downloadDir ? (
        <button className="btn btn-ghost h-7 px-2 text-2xs" onClick={() => void reset()}>
          {t('settings.ext.transfer.reset')}
        </button>
      ) : null}
    </Row>
  )
}
