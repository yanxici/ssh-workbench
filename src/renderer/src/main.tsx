import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles/index.css'
import '@xterm/xterm/css/xterm.css'

/**
 * 刻意不启用 StrictMode：
 * 其在开发模式下会对 effect 双调用，xterm 这类命令式 DOM 组件的
 * 创建/销毁会被执行两遍，容易出现重复实例与尺寸计算异常。
 */
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
