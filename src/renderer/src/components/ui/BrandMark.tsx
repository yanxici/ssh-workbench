import { useId } from 'react'
import type * as React from 'react'

/**
 * Portix 专属几何品牌徽标（方案 A：端口触点 + 提示符）。
 *
 * 深石墨圆角载体配极细翡翠绿微光描边，确保在浅色与深色界面中均有清晰轮廓；
 * 左侧双纵向端口导轨代表 SSH 网络端口与物理串口，右侧折出提示符 `>` 与信号条 `_`。
 */
export function BrandMark({
  size = 20,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  const uid = useId().replace(/:/g, '')
  const bgId = `portix-bg-${uid}`
  const emId = `portix-em-${uid}`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={bgId} x1="4" y1="2" x2="44" y2="46" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#19212A" />
          <stop offset="100%" stopColor="#0B0F14" />
        </linearGradient>
        <linearGradient id={emId} x1="12" y1="12" x2="38" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3FE8B0" />
          <stop offset="100%" stopColor="#0EA571" />
        </linearGradient>
      </defs>
      <rect
        x="1"
        y="1"
        width="46"
        height="46"
        rx="11"
        fill={`url(#${bgId})`}
        stroke="rgba(46,211,154,0.3)"
        strokeWidth="1.4"
      />
      <rect x="10.5" y="15" width="3.8" height="7" rx="1.9" fill={`url(#${emId})`} opacity="0.65" />
      <rect x="10.5" y="26" width="3.8" height="7" rx="1.9" fill={`url(#${emId})`} opacity="0.65" />
      <path
        d="M19.5 15.5L29.5 24L19.5 32.5"
        stroke={`url(#${emId})`}
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M30.5 32.5H38" stroke="#6EE7B7" strokeWidth="3.8" strokeLinecap="round" />
    </svg>
  )
}
