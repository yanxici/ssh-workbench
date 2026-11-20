/**
 * 大流量输出自适应合帧回归（WP4）：
 *   1. 低流量交互保持 8ms（无额外延迟感知）
 *   2. 连续大块输出平滑升档 8ms -> 20ms -> 32ms
 *   3. 累计待发字节达 256KB 硬上限时要求立即 flush（防积压）
 *   4. 流量回落或空闲超过 80ms 后立刻回落 8ms
 *   5. sessionManager.ts 已接入 adaptiveFlush 而非写死 FLUSH_INTERVAL_MS
 *
 * 用法：node scripts/verify-adaptive-flush.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT, { recursive: true })

let failed = 0
function check(name, ok, extra) {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`)
  }
}

async function main() {
  const smSrc = fs.readFileSync(path.join(ROOT, 'src/main/ssh/sessionManager.ts'), 'utf8')
  check(
    'WP4: sessionManager 已接入 adaptiveFlush',
    /onAdaptiveFeed/.test(smSrc) && /onAdaptiveFlush/.test(smSrc)
  )

  const bundle = path.join(OUT, 'adaptive-flush.cjs')
  await esbuild.build({
    stdin: {
      contents: `
        export {
          BASE_FLUSH_MS,
          MID_FLUSH_MS,
          MAX_FLUSH_MS,
          HIGH_WATER_BYTES,
          LOW_WATER_BYTES,
          IMMEDIATE_FLUSH_BYTES,
          IDLE_RESET_MS,
          createAdaptiveFlushState,
          onAdaptiveFeed,
          onAdaptiveFlush
        } from './src/main/util/adaptiveFlush'
      `,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'error'
  })

  const {
    BASE_FLUSH_MS,
    MID_FLUSH_MS,
    MAX_FLUSH_MS,
    HIGH_WATER_BYTES,
    IMMEDIATE_FLUSH_BYTES,
    IDLE_RESET_MS,
    createAdaptiveFlushState,
    onAdaptiveFeed,
    onAdaptiveFlush
  } = require(bundle)

  const s = createAdaptiveFlushState()
  check('初始窗口为 8ms', s.delayMs === BASE_FLUSH_MS && BASE_FLUSH_MS === 8, s)

  // 低流量：保持 8ms
  const f1 = onAdaptiveFeed(s, 64, 1000)
  check('单次小包交互 delayMs=8 且不立即强刷', f1.delayMs === 8 && !f1.flushNow, f1)
  onAdaptiveFlush(s, 64, 1008)
  check('小包 flush 后维持 8ms', s.delayMs === 8, s)

  // 第一次高吞吐：8ms -> 20ms
  const f2 = onAdaptiveFeed(s, HIGH_WATER_BYTES, 1016)
  check('首个高流量包仍按当前 8ms 排程', f2.delayMs === 8 && !f2.flushNow, f2)
  onAdaptiveFlush(s, HIGH_WATER_BYTES, 1024)
  check('首次大包 flush 后升档到 MID (20ms)', s.delayMs === MID_FLUSH_MS, s)

  // 连续第二次高吞吐：20ms -> 32ms
  const f3 = onAdaptiveFeed(s, HIGH_WATER_BYTES + 4096, 1030)
  check('第二次大包使用 MID 档排程', f3.delayMs === MID_FLUSH_MS && !f3.flushNow, f3)
  onAdaptiveFlush(s, HIGH_WATER_BYTES + 4096, 1050)
  check('连续大包 flush 后升档到 MAX (32ms)', s.delayMs === MAX_FLUSH_MS, s)

  // 触发 256KB 硬上限立即 flush
  const fBurst = onAdaptiveFeed(s, IMMEDIATE_FLUSH_BYTES, 1060)
  check('累计达 256KB 硬上限时返回 flushNow=true', fBurst.flushNow === true, fBurst)
  onAdaptiveFlush(s, IMMEDIATE_FLUSH_BYTES, 1060)
  check('硬上限强刷后仍保持 MAX 档', s.delayMs === MAX_FLUSH_MS, s)

  // 空闲超过 IDLE_RESET_MS 后立刻回落 8ms
  const fIdle = onAdaptiveFeed(s, 12, 1060 + IDLE_RESET_MS + 10)
  check('空闲超过 80ms 后新输入立即回落 8ms', fIdle.delayMs === BASE_FLUSH_MS && !fIdle.flushNow, fIdle)
  onAdaptiveFlush(s, 12, 1060 + IDLE_RESET_MS + 18)

  // 流量骤降（低于 LOW_WATER_BYTES）也立即回落 8ms
  onAdaptiveFeed(s, HIGH_WATER_BYTES, 2000)
  onAdaptiveFlush(s, HIGH_WATER_BYTES, 2008)
  onAdaptiveFeed(s, HIGH_WATER_BYTES, 2010)
  onAdaptiveFlush(s, HIGH_WATER_BYTES, 2030)
  check('确认已升至 MAX 档', s.delayMs === MAX_FLUSH_MS, s)
  onAdaptiveFeed(s, 100, 2040)
  onAdaptiveFlush(s, 100, 2072)
  check('单次低流量 flush 后立即回落 8ms', s.delayMs === BASE_FLUSH_MS, s)

  console.log(`\n${failed === 0 ? '自适应合帧回归全部通过' : `${failed} 项失败`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('校验异常:', e)
  process.exit(2)
})
