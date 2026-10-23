/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 语义色：全部走 CSS 变量，暗色 / 亮色主题只切换变量值
        app: 'rgb(var(--c-app) / <alpha-value>)',
        panel: 'rgb(var(--c-panel) / <alpha-value>)',
        raised: 'rgb(var(--c-raised) / <alpha-value>)',
        hover: 'rgb(var(--c-hover) / <alpha-value>)',
        edge: 'rgb(var(--c-edge) / <alpha-value>)',
        'edge-soft': 'rgb(var(--c-edge-soft) / <alpha-value>)',
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        'ink-2': 'rgb(var(--c-ink-2) / <alpha-value>)',
        'ink-3': 'rgb(var(--c-ink-3) / <alpha-value>)',
        // 品牌绿 #27c93f：只给标题栏底色、活动栏指示线、终端成功信息
        brand: 'rgb(var(--c-brand) / <alpha-value>)',
        'on-brand': 'rgb(var(--c-on-brand) / <alpha-value>)',
        // 选中行底色（文件树 #e0f2fe）
        select: 'rgb(var(--c-select) / <alpha-value>)',
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        success: 'rgb(var(--c-success) / <alpha-value>)',
        warning: 'rgb(var(--c-warning) / <alpha-value>)',
        danger: 'rgb(var(--c-danger) / <alpha-value>)'
      },
      /**
       * UI 用系统无衬线、代码用等宽。
       *
       * mono 栈必须与主进程 DEFAULT_SETTINGS.terminal.fontFamily 保持同序：
       * 侧栏里的命令行预览（`font-mono`）与终端里的实际输出要看起来是同一套字，
       * 否则同一串命令在预览里和在终端里字宽不同，视觉上像两种字体。
       * 这里不放 Cascadia / Menlo —— JetBrains Mono 与 Fira Code 覆盖了
       * Windows 和 macOS 的常见安装，再加只会让兜底链变长。
       */
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'PingFang SC',
          'Microsoft YaHei',
          'sans-serif'
        ],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace']
      },
      /**
       * 字号阶梯（严格五档，别再随手写 text-[13px]）
       *
       * 之前散落着 9px / 10px / 10.5px / 11px / 11.5px / 12.5px / 13px / 15px
       * 八种尺寸，同一屏里相邻文字差 0.5px —— 单看每一处都合理，并排就显脏。
       * 现在统一成：10 / 11 / 12 / 13 / 15，行高按 1.33~1.54 配平。
       */
      fontSize: {
        '3xs': ['10px', '14px'],
        '2xs': ['11px', '16px'],
        xs: ['12px', '16px'],
        sm: ['13px', '20px'],
        base: ['15px', '22px']
      },
      boxShadow: {
        /* 投影走 CSS 变量：浅色主题要轻（45% 黑在 #ffffff 上糊成脏灰），
           暗色主题要重（不够深就完全看不出浮层）。见 styles/index.css。 */
        pop: 'var(--shadow-pop)',
        'pop-lg': 'var(--shadow-pop-lg)',
        glow: '0 0 0 1px rgb(var(--c-accent) / 0.35), 0 0 18px -4px rgb(var(--c-accent) / 0.5)'
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        'pop-in': {
          from: { opacity: '0', transform: 'scale(0.96) translateY(4px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' }
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' }
        },
        'flash-ok': {
          '0%': { backgroundColor: 'rgb(var(--c-success) / 0.25)' },
          '100%': { backgroundColor: 'transparent' }
        }
      },
      animation: {
        'fade-in': 'fade-in 0.15s ease-out',
        'pop-in': 'pop-in 0.16s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slide-up 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
        'flash-ok': 'flash-ok 0.6s ease-out'
      }
    }
  },
  plugins: []
}
