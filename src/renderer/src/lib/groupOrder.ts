/**
 * 常用命令分组的自定义排序（纯函数，便于单测）。
 * 顺序以分组名数组保存在设置 commandGroupOrder 中；
 * 不在数组里的分组（如新建 / 新导入的）排在已排序分组之后，按名称排列。
 */

/** 按自定义顺序排列分组名 */
export function sortGroupNames(names: string[], order: string[]): string[] {
  const rank = new Map(order.map((g, i) => [g, i]))
  return [...names].sort((a, b) => {
    const ra = rank.get(a)
    const rb = rank.get(b)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.localeCompare(b, 'zh-CN')
  })
}

/** 把 list[from] 移到结果中的 to 位置（越界自动收拢），返回新数组 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item)
  return next
}

/** 拖拽放置：把 src 放到 target 之前（after=false）或之后（after=true） */
export function placeRelative(names: string[], src: string, target: string, after: boolean): string[] {
  if (src === target || !names.includes(src)) return names
  const rest = names.filter((n) => n !== src)
  const ti = rest.indexOf(target)
  if (ti < 0) return names
  rest.splice(after ? ti + 1 : ti, 0, src)
  return rest
}
