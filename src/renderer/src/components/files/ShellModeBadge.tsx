import type * as React from 'react'
import { useI18n } from '@/i18n'
import { useSftpStore } from '@/stores/sftpStore'

/**
 * 「Shell 兼容」角标。
 *
 * 它只解释一件事：这个会话的文件操作没走 SFTP。远端没装 sftp-server（嵌入式
 * 设备里极常见）时，主进程已经自动切到普通命令通道 —— 不标出来，用户只会
 * 觉得「这机器的文件面板怎么特别慢」，而不是知道这是降级后的正常表现。
 *
 * 模式数据只有主进程才知道，这里纯粹是镜像；没降级就什么都不渲染。
 */
export function ShellModeBadge({
  sessionId
}: {
  sessionId: string | null
}): React.JSX.Element | null {
  const { t } = useI18n()
  const mode = useSftpStore((s) => (sessionId ? s.modeBySession[sessionId] : undefined))
  if (!sessionId || mode !== 'shell') return null
  return (
    <span
      className="shrink-0 rounded-sm border border-edge-soft px-1 py-px text-3xs text-warning"
      title={t('files.shellMode.hint')}
    >
      {t('files.shellMode.badge')}
    </span>
  )
}
