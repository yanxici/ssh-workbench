import ReactDOM from 'react-dom/client'
import { App } from './App'
import { installCanvasFontShim } from './lib/canvasFont'
import './styles/index.css'
import '@xterm/xterm/css/xterm.css'

/*
 * 必须在任何 canvas 绘制之前打上字体串补丁：
 * WebGL 终端（@xterm/addon-webgl）拼字体串时会多出一个前导空格，
 * Chromium 的 canvas font 解析器不 trim，整串被判非法而静默退回
 * 10px sans-serif —— 表现就是「字被画小、笔画变细、字距看着变宽」。
 * 详见 lib/canvasFont.ts 的注释。
 */
installCanvasFontShim()

/**
 * 刻意不启用 StrictMode：
 * 其在开发模式下会对 effect 双调用，xterm 这类命令式 DOM 组件的
 * 创建/销毁会被执行两遍，容易出现重复实例与尺寸计算异常。
 */
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
