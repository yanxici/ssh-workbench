/**
 * Pure text helpers for RemoteEditorDialog (zero external dependencies).
 */

export interface TextRange {
  start: number
  end: number
}

export function countLines(text: string): number {
  let count = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++
  }
  return count
}

export function getLineCol(text: string, offset: number): { line: number; col: number } {
  const clamped = Math.max(0, Math.min(offset, text.length))
  let line = 1
  let lastNl = -1
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      lastNl = i
    }
  }
  return { line, col: clamped - lastNl }
}

export function findMatches(text: string, query: string, caseSensitive: boolean): TextRange[] {
  if (!query) return []
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const step = needle.length
  const out: TextRange[] = []
  let idx = 0
  while (idx <= hay.length - step) {
    const found = hay.indexOf(needle, idx)
    if (found === -1) break
    out.push({ start: found, end: found + step })
    idx = found + step
  }
  return out
}

export function stepMatchIndex(
  matches: TextRange[],
  cursorPos: number,
  direction: 'next' | 'prev'
): number {
  if (matches.length === 0) return -1
  if (direction === 'next') {
    const idx = matches.findIndex((m) => m.start >= cursorPos)
    return idx === -1 ? 0 : idx
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].start < cursorPos) return i
  }
  return matches.length - 1
}

export function replaceMatch(
  text: string,
  match: TextRange,
  replacement: string
): { text: string; caret: number } {
  const next = text.slice(0, match.start) + replacement + text.slice(match.end)
  return { text: next, caret: match.start + replacement.length }
}

export function replaceAllMatches(
  text: string,
  query: string,
  replacement: string,
  caseSensitive: boolean
): { text: string; count: number } {
  const matches = findMatches(text, query, caseSensitive)
  if (matches.length === 0) return { text, count: 0 }
  let out = ''
  let prev = 0
  for (const m of matches) {
    out += text.slice(prev, m.start) + replacement
    prev = m.end
  }
  out += text.slice(prev)
  return { text: out, count: matches.length }
}

function removeLeadingIndent(line: string, unit: string): { line: string; removed: number } {
  if (line.startsWith(unit)) return { line: line.slice(unit.length), removed: unit.length }
  if (line.startsWith('\t')) return { line: line.slice(1), removed: 1 }
  let spaces = 0
  while (spaces < unit.length && line[spaces] === ' ') spaces++
  if (spaces > 0) return { line: line.slice(spaces), removed: spaces }
  return { line, removed: 0 }
}

export function applyTabIndent(
  text: string,
  start: number,
  end: number,
  outdent: boolean,
  unit = '  '
): { text: string; start: number; end: number } {
  if (start === end) {
    if (!outdent) {
      return {
        text: text.slice(0, start) + unit + text.slice(end),
        start: start + unit.length,
        end: end + unit.length
      }
    }
    const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1
    const lineEndIdx = text.indexOf('\n', lineStart)
    const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx
    const line = text.slice(lineStart, lineEnd)
    const { line: nextLine, removed } = removeLeadingIndent(line, unit)
    if (removed === 0) return { text, start, end }
    const nextPos = Math.max(lineStart, start - removed)
    return {
      text: text.slice(0, lineStart) + nextLine + text.slice(lineEnd),
      start: nextPos,
      end: nextPos
    }
  }

  const blockStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1
  const effectiveEnd = end > start && text[end - 1] === '\n' ? end - 1 : end
  const blockEndIdx = text.indexOf('\n', effectiveEnd)
  const blockEnd = blockEndIdx === -1 ? text.length : blockEndIdx

  const lines = text.slice(blockStart, blockEnd).split('\n')
  let firstDelta = 0
  let totalDelta = 0
  const nextLines = lines.map((line, i) => {
    if (!outdent) {
      if (i === 0) firstDelta = unit.length
      totalDelta += unit.length
      return unit + line
    }
    const { line: stripped, removed } = removeLeadingIndent(line, unit)
    if (i === 0) firstDelta = -removed
    totalDelta -= removed
    return stripped
  })

  const nextStart = Math.max(blockStart, start + firstDelta)
  const nextEnd = Math.max(nextStart, end + totalDelta)
  return {
    text: text.slice(0, blockStart) + nextLines.join('\n') + text.slice(blockEnd),
    start: nextStart,
    end: nextEnd
  }
}
