import type { Terminal } from '@xterm/xterm'
import { matchShortcut, parseShortcut } from './shortcuts'

export const TEMP_FONT_MIN = 10
export const TEMP_FONT_MAX = 28

export type CopyDecision = 'copy' | 'passthrough' | 'noop' | 'unmatched'

/**
 * Decide how a terminal copy shortcut keydown should behave:
 * - When selection exists: copy (without clearing selection) and consume key.
 * - When no selection AND the active binding is plain Ctrl+C: passthrough to xterm (SIGINT).
 * - When no selection AND the user rebound copy to another combo: consume as no-op.
 */
export function decideTerminalCopy(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  combo: string,
  hasSelection: boolean
): CopyDecision {
  if (!matchShortcut(e as KeyboardEvent, combo)) return 'unmatched'
  if (hasSelection) return 'copy'
  const parsed = parseShortcut(combo)
  if (parsed && parsed.ctrl && !parsed.shift && !parsed.alt && parsed.key === 'c') {
    return 'passthrough'
  }
  return 'noop'
}

export type RightClickAction = 'menu' | 'copy' | 'paste'

/**
 * Decide terminal right-click behavior:
 * - Setting off or Shift held -> open full context menu.
 * - Setting on + selection -> copy selection.
 * - Setting on + no selection -> paste clipboard.
 */
export function decideRightClickAction(
  rightClickPaste: boolean,
  shiftKey: boolean,
  hasSelection: boolean
): RightClickAction {
  if (!rightClickPaste || shiftKey) return 'menu'
  return hasSelection ? 'copy' : 'paste'
}

/** Step temporary per-terminal font size via Ctrl+wheel within [10, 28]. */
export function stepTempFontSize(current: number, deltaY: number): number {
  if (deltaY === 0) return current
  const next = current + (deltaY < 0 ? 1 : -1)
  return Math.max(TEMP_FONT_MIN, Math.min(TEMP_FONT_MAX, Math.round(next * 2) / 2))
}

export interface BufferLineLike {
  text: string
  isWrapped: boolean
}

/** Join wrapped lines from xterm buffer and strip trailing whitespace-only lines. */
export function extractTerminalLines(lines: BufferLineLike[]): string {
  const out: string[] = []
  for (const line of lines) {
    if (line.isWrapped && out.length > 0) {
      out[out.length - 1] += line.text
    } else {
      out.push(line.text)
    }
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') {
    out.pop()
  }
  return out.join('\n')
}

/** Extract full plain-text content from an xterm Terminal's active buffer. */
export function extractTerminalBuffer(term: Terminal): string {
  const buf = term.buffer.active
  const lines: BufferLineLike[] = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (!line) continue
    const nextWrapped = i + 1 < buf.length && buf.getLine(i + 1)?.isWrapped === true
    lines.push({
      text: line.translateToString(!nextWrapped),
      isWrapped: line.isWrapped
    })
  }
  return extractTerminalLines(lines)
}
