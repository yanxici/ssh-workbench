/**
 * 命中字符高亮：把 fuzzy 匹配出的下标包成 <mark>。
 * 命令中心与侧栏面板共用，避免两处各写一份走样。
 */
export function Highlight({
  text,
  indices
}: {
  text: string
  indices: number[]
}): JSX.Element {
  if (indices.length === 0) return <>{text}</>
  const set = new Set(indices)
  const out: JSX.Element[] = []
  let buf = ''
  let bufHit = false
  const flush = (): void => {
    if (!buf) return
    out.push(
      bufHit ? (
        <mark key={out.length} className="rounded-sm bg-accent/25 text-ink">
          {buf}
        </mark>
      ) : (
        <span key={out.length}>{buf}</span>
      )
    )
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i)
    if (hit !== bufHit) {
      flush()
      bufHit = hit
    }
    buf += text[i]
  }
  flush()
  return <>{out}</>
}
