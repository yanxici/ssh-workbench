/**
 * Adaptive output coalescing state machine for terminal sessions.
 *
 * Interactive keystrokes stay on the 8ms baseline so echo feels instant.
 * Sustained bursts (e.g. `cat` big files or `dmesg` floods) smoothly widen the
 * flush window up to 32ms to cut IPC/xterm thrashing, while a 256KB hard cap
 * guarantees immediate flushing so memory never balloons.
 */

export const BASE_FLUSH_MS = 8
export const MID_FLUSH_MS = 20
export const MAX_FLUSH_MS = 32

export const HIGH_WATER_BYTES = 16 * 1024
export const LOW_WATER_BYTES = 4 * 1024
export const IMMEDIATE_FLUSH_BYTES = 256 * 1024
export const IDLE_RESET_MS = 80

export interface AdaptiveFlushState {
  delayMs: number
  pendingBytes: number
  lastFlushAt: number
  hotStreak: number
}

export function createAdaptiveFlushState(): AdaptiveFlushState {
  return {
    delayMs: BASE_FLUSH_MS,
    pendingBytes: 0,
    lastFlushAt: 0,
    hotStreak: 0
  }
}

export function onAdaptiveFeed(
  state: AdaptiveFlushState,
  bytes: number,
  now = Date.now()
): { flushNow: boolean; delayMs: number } {
  if (state.pendingBytes === 0 && state.lastFlushAt > 0 && now - state.lastFlushAt >= IDLE_RESET_MS) {
    state.delayMs = BASE_FLUSH_MS
    state.hotStreak = 0
  }
  state.pendingBytes += Math.max(0, bytes)
  return {
    flushNow: state.pendingBytes >= IMMEDIATE_FLUSH_BYTES,
    delayMs: state.delayMs
  }
}

export function onAdaptiveFlush(
  state: AdaptiveFlushState,
  flushedBytes: number,
  now = Date.now()
): void {
  state.pendingBytes = 0
  state.lastFlushAt = now
  if (flushedBytes >= HIGH_WATER_BYTES) {
    state.hotStreak += 1
    state.delayMs = state.hotStreak >= 2 ? MAX_FLUSH_MS : MID_FLUSH_MS
    return
  }
  if (flushedBytes <= LOW_WATER_BYTES) {
    state.hotStreak = 0
    state.delayMs = BASE_FLUSH_MS
    return
  }
  state.hotStreak = Math.max(0, state.hotStreak - 1)
  if (state.delayMs === MAX_FLUSH_MS) {
    state.delayMs = MID_FLUSH_MS
  }
}
