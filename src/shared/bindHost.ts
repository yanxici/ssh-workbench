/**
 * 监听地址的纯判定逻辑（主进程与渲染层共用）。
 *
 * 为什么必须共用：后端用它决定「允许保存 / 拒绝保存」，前端用它决定
 * 「是否显示『允许局域网访问』开关、是否标红警示」。两处各写一份，
 * 一旦规则漂移就会出现「UI 允许、后端拒绝」或更糟的「UI 没提示、
 * 后端放行」——后者等于把无认证代理悄悄暴露到局域网。
 *
 * 放在 shared/ 下是因为两个端都能 import，且没有运行时依赖（纯字符串判断）。
 */

/**
 * 是否回环地址。
 * 覆盖：127.0.0.1 / ::1 / localhost / 127.x.x.x。
 * 注意 0.0.0.0 与 :: 都不是回环 —— 它们表示「监听所有网卡」。
 */
export function isLoopbackHost(host: string): boolean {
  const h = (host ?? '').trim().toLowerCase()
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** 是否是「监听所有网卡」的通配地址（最危险的一类，UI 要单独强调） */
export function isWildcardHost(host: string): boolean {
  const h = (host ?? '').trim().toLowerCase()
  return h === '0.0.0.0' || h === '::' || h === '*'
}

/**
 * 该监听地址是否需要用户显式授权（allowLan）。
 * 回环地址永远不需要；其余地址（含通配）都需要。
 */
export function needsLanGrant(host: string): boolean {
  return !isLoopbackHost(host)
}
