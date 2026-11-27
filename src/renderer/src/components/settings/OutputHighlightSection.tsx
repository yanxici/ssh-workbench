import type * as React from 'react'
import { useMemo, useState } from 'react'
import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { HighlightRule } from '@shared/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { Toggle } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  MAX_RULES,
  assessPattern,
  compileRules,
  defaultHighlightPrefs,
  matchRule,
  normalizeHighlight,
  sanitizeColor,
  sanitizeFlags,
  type CompiledRule
} from '@/lib/highlight'
import { Row } from './sectionUi'
import { useI18n } from '@/i18n'

/**
 * 设置 → 终端输出高亮。
 *
 * 这一版只做行级染色（见 lib/highlight.ts 顶部注释），所以颜色只有两个：
 * 整行底色 + 文字前景色。两者都可以留空 —— 留空表示「不动那一项」，
 * 想让规则只染底不盖字，就把前景色清掉。
 *
 * 三个刻意的设计取舍：
 *   1. 规则编辑是**即时生效**的，没有「保存」按钮。改一个字就落盘看起来激进，
 *      但这里的每一条改动都能在下面的试匹配框里立刻看到结果，比「改完点保存
 *      才发现整批规则都错了」友好得多。
 *   2. 正则写错不会阻断其它规则：compileRules 把坏规则单独挑出来，
 *      这里就地标红显示错误信息，剩下的照常工作。
 *   3. 回溯风险（ReDoS）只警告不阻断 —— 这是用户自己写的规则，
 *      本地个人工具，拒绝保存比卡顿更让人火大。标黄 + 显示实测耗时。
 */
export function OutputHighlightSection(): React.JSX.Element {
  const { t } = useI18n()
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)

  const prefs = useMemo(() => normalizeHighlight(settings.outputHighlight), [settings.outputHighlight])
  const { compiled, errors } = useMemo(() => compileRules(prefs.rules), [prefs.rules])
  const errorById = useMemo(() => new Map(errors.map((e) => [e.id, e.message])), [errors])

  const commit = (rules: HighlightRule[]): void => {
    void update({ outputHighlight: { enabled: prefs.enabled, rules } })
  }

  const patchRule = (id: string, patch: Partial<HighlightRule>): void => {
    commit(prefs.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  const removeRule = (id: string): void => {
    commit(prefs.rules.filter((r) => r.id !== id))
  }

  const addRule = (): void => {
    if (prefs.rules.length >= MAX_RULES) return
    const id = 'rule-' + Date.now().toString(36)
    commit([
      ...prefs.rules,
      {
        id,
        name: t('settings.ext.highlight.newRuleName'),
        pattern: '',
        flags: 'i',
        enabled: true,
        background: '#2b3a55',
        foreground: '#cfe3ff'
      }
    ])
  }

  return (
    <>
      <div className="text-2xs leading-relaxed text-ink-3">
        {t('settings.ext.highlight.introPrefix')}
        <span className="font-mono">e&#123;ESC&#125;rror</span>
        {t('settings.ext.highlight.introSuffix')}
      </div>

      <Row
        label={t('settings.ext.highlight.enable')}
        hint={t('settings.ext.highlight.enableHint')}
      >
        <Toggle
          checked={prefs.enabled}
          onChange={(v) => void update({ outputHighlight: { enabled: v, rules: prefs.rules } })}
        />
      </Row>

      {prefs.enabled && (
        <>
          <div className="space-y-1.5">
            {prefs.rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                error={errorById.get(rule.id)}
                onPatch={(patch) => patchRule(rule.id, patch)}
                onRemove={() => removeRule(rule.id)}
              />
            ))}
            {prefs.rules.length === 0 && (
              <div className="rounded-md border border-dashed border-edge px-2 py-3 text-center text-2xs text-ink-3">
                {t('settings.ext.highlight.empty')}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              className="btn h-7 px-2.5 text-xs"
              onClick={addRule}
              disabled={prefs.rules.length >= MAX_RULES}
              title={
                prefs.rules.length >= MAX_RULES
                  ? t('settings.ext.highlight.maxReached', { max: MAX_RULES })
                  : t('settings.ext.highlight.addTitle')
              }
            >
              <Plus size={12} />
              {t('settings.ext.highlight.add')}
            </button>
            <button
              className="btn h-7 px-2.5 text-xs"
              onClick={() => void update({ outputHighlight: defaultHighlightPrefs() })}
              title={t('settings.ext.highlight.resetTitle')}
            >
              <RotateCcw size={12} />
              {t('settings.ext.highlight.reset')}
            </button>
            <span className="ml-auto text-2xs text-ink-3">
              {t('settings.ext.highlight.stats', {
                total: prefs.rules.length,
                max: MAX_RULES,
                active: compiled.length
              })}
              {errors.length > 0 && (
                <span className="ml-1 text-danger">
                  {t('settings.ext.highlight.invalidCount', { count: errors.length })}
                </span>
              )}
            </span>
          </div>

          <PreviewPane compiled={compiled} />
        </>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ *
 *  单条规则
 * ------------------------------------------------------------------ */

function RuleRow({
  rule,
  error,
  onPatch,
  onRemove
}: {
  rule: HighlightRule
  error?: string
  onPatch: (patch: Partial<HighlightRule>) => void
  onRemove: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  /*
   * 正则体检只对「合法」的正则做：编译不过的规则谈不上回溯风险，
   * 把它同时标红又标黄只会让人以为有两个问题。
   */
  const risk = error ? { level: 'ok' as const, reasons: [] } : assessPattern(rule.pattern)

  return (
    <div
      className={cn(
        'rounded-md border px-2 py-1.5 transition-colors',
        error ? 'border-danger/50 bg-danger/5' : 'border-edge bg-app/40'
      )}
    >
      <div className="flex items-center gap-1.5">
        <Toggle checked={rule.enabled} onChange={(v) => onPatch({ enabled: v })} />
        <input
          className="input h-7 min-w-0 flex-1 px-2 text-xs"
          value={rule.name}
          placeholder={t('settings.ext.highlight.namePlaceholder')}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <ColorPicker
          value={rule.background}
          title={t('settings.ext.highlight.bgTitle')}
          onChange={(v) => onPatch({ background: v })}
        />
        <ColorPicker
          value={rule.foreground}
          title={t('settings.ext.highlight.fgTitle')}
          onChange={(v) => onPatch({ foreground: v })}
        />
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-hover hover:text-danger"
          title={t('settings.ext.highlight.deleteTitle')}
          onClick={onRemove}
        >
          <Trash2 size={12} />
        </button>
      </div>

      <div className="mt-1 flex items-center gap-1.5">
        <span className="shrink-0 text-2xs text-ink-3">/</span>
        <input
          className={cn('input h-7 min-w-0 flex-1 px-2 font-mono text-xs', error && 'border-danger/60')}
          value={rule.pattern}
          placeholder={t('settings.ext.highlight.patternPlaceholder')}
          spellCheck={false}
          onChange={(e) => onPatch({ pattern: e.target.value })}
        />
        <span className="shrink-0 text-2xs text-ink-3">/</span>
        <input
          className="input h-7 w-14 shrink-0 px-2 font-mono text-xs"
          value={rule.flags ?? ''}
          placeholder="i"
          spellCheck={false}
          title={t('settings.ext.highlight.flagsTitle')}
          onChange={(e) => onPatch({ flags: sanitizeFlags(e.target.value) })}
        />
      </div>

      {error && (
        <div className="mt-1 text-2xs leading-snug text-danger">
          {t('settings.ext.highlight.invalidRegex', { error })}
        </div>
      )}
      {risk.level === 'warn' && (
        <div className="mt-1 text-2xs leading-snug text-warning">
          {t('settings.ext.highlight.riskWarn', {
            reasons: risk.reasons.join(t('settings.ext.shortcuts.listSep'))
          })}
        </div>
      )}
    </div>
  )
}

/** 颜色选择器：留空 = 不改这一项；清空按钮把值删掉（undefined），而不是写成黑色 */
function ColorPicker({
  value,
  title,
  onChange
}: {
  value: string | undefined
  title: string
  onChange: (v: string | undefined) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const valid = sanitizeColor(value)
  return (
    <label
      className="relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-edge"
      title={
        valid
          ? t('settings.ext.highlight.colorSet', { title, color: valid })
          : t('settings.ext.highlight.colorUnset', { title })
      }
      onContextMenu={(e) => {
        e.preventDefault()
        onChange(undefined)
      }}
      style={valid ? { backgroundColor: valid } : undefined}
    >
      {!valid && <span className="text-2xs text-ink-3">–</span>}
      <input
        type="color"
        className="absolute inset-0 cursor-pointer opacity-0"
        value={valid ?? '#808080'}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

/* ------------------------------------------------------------------ *
 *  试匹配
 * ------------------------------------------------------------------ */

/** 默认样本：现场最常贴进来看的三类行 —— 报错、告警、正常输出 */
const SAMPLE = [
  'root@device:~# tar -xzf fw.tar.gz',
  'tar: fw.bin: Cannot open: Permission denied',
  'WARNING: low memory, swap disabled',
  'systemd[1]: Started Session 3 of user root.',
  'ping: connect: Network is unreachable',
  'compile finished ok',
  'ERROR 1045 (28000): Access denied for user',
  'up 3 days, load average: 0.08, 0.12, 0.09'
].join('\n')

/**
 * 试匹配框。
 *
 * 为什么必须有：规则写对写错在设置页里完全看不出差别 —— 用户只能「改完回去
 * 等一条报错出现」，那是最糟糕的验证回路。这里给一段可编辑样本，
 * 实时显示每条规则命中几行、以及 8 行样本跑一遍的耗时（超过阈值标黄，
 * 用来暴露回溯风险 —— 静态体检抓不到的，这里能量出来）。
 */
function PreviewPane({ compiled }: { compiled: CompiledRule[] }): React.JSX.Element {
  const { t } = useI18n()
  const [sample, setSample] = useState(SAMPLE)

  const result = useMemo(() => {
    const lines = sample.split('\n')
    const counts = new Map<string, number>()
    const t0 = performance.now()
    let matched = 0
    for (const line of lines) {
      const rule = matchRule(compiled, line)
      if (rule) {
        matched++
        counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1)
      }
    }
    return { lines: lines.length, matched, counts, ms: performance.now() - t0 }
  }, [sample, compiled])

  const slow = result.ms > 5

  return (
    <div className="space-y-1.5 rounded-md border border-edge bg-app/40 p-2">
      <div className="flex items-center justify-between">
        <span className="text-2xs font-semibold uppercase tracking-wider text-ink-2">
          {t('settings.ext.highlight.previewTitle')}
        </span>
        <span className={cn('text-2xs', slow ? 'text-warning' : 'text-ink-3')}>
          {t('settings.ext.highlight.previewStats', {
            matched: result.matched,
            total: result.lines,
            ms: result.ms.toFixed(2)
          })}
          {slow && t('settings.ext.highlight.previewSlow')}
        </span>
      </div>
      <textarea
        className="input scroll-thin h-28 resize-none selectable py-1.5 font-mono text-2xs leading-relaxed"
        value={sample}
        spellCheck={false}
        onChange={(e) => setSample(e.target.value)}
      />
      {compiled.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {compiled.map((rule) => (
            <span
              key={rule.id}
              className="rounded px-1.5 py-0.5 text-2xs"
              style={{
                backgroundColor: rule.background ?? 'transparent',
                color: rule.foreground ?? undefined,
                border: '1px solid rgb(var(--c-edge-soft))'
              }}
            >
              {rule.name || rule.pattern} · {result.counts.get(rule.id) ?? 0}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
