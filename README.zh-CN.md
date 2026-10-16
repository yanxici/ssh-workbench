# SSH Workbench

[English](./README.md) | 简体中文

轻量级桌面 SSH 客户端，内置面向嵌入式设备技术支持的工作台。基于 Electron + React + TypeScript。

## 功能

**连接与终端**
- 连接管理：分组、标签、颜色；支持密码、私钥（PEM / OpenSSH / PuTTY `.ppk`）、SSH Agent、keyboard-interactive 认证
- ProxyJump 跳板链、SOCKS5 / HTTP CONNECT 代理
- 从剪贴板识别 `ssh user@host -p 22` 命令，一键新建连接
- 多标签终端（xterm.js），支持搜索、主题、自定义快捷键、ZMODEM（`rz` / `sz`）
- 连接加密导出 / 导入，可在电脑之间迁移

**常用命令面板**
- 单击执行，支持 `{{变量}}`、危险命令二次确认、分组、拖拽、搜索、收藏、历史
- JSON 导入导出

**文件与隧道**
- 终端旁的 SFTP 文件树、双栏传输模式、传输队列、远程编辑（自动 `.bak` 备份）
- 端口转发：本地（`-L`）、远程（`-R`）、动态 SOCKS5（`-D`）

**技术支持工作台**
- 会话录制（asciinema `.cast` 格式）及回放器（变速、导出）
- 一键诊断巡检：31 项内置检查（兼容 BusyBox）+ 自定义项，导出 Markdown / 单文件 HTML
- 多设备批量执行，卡片视图与对比视图
- 客户 / 设备档案，实时资源仪表盘（CPU、内存、磁盘、温度、网络）
- 固件升级助手：上传、SHA-256 双端校验、升级、等待重启上线
- 设备发现：网段 TCP 扫描、ARP 厂商识别、反向 DNS、mDNS
- 配置备份，行级 diff 对比与还原
- 报告、日志、历史、备份一键打包为 zip

**安全**
- 凭据使用系统密钥加密（Electron `safeStorage`）
- 主机指纹校验

## 快速开始

需要 Node.js 18+。

```bash
npm install --omit=optional   # 跳过 ssh2 的可选原生加速模块（无需 C++ 编译环境，不影响功能）
npm run dev                   # 开发模式（热更新）
```

`.npmrc` 已把 Electron 二进制下载指向 npmmirror 国内镜像，能直连 GitHub 的话可以删掉这一行。

## 常用脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式（F12 打开 DevTools） |
| `npm run typecheck` | 主进程 + 渲染层类型检查 |
| `npm run smoke` | 冒烟自检：构建、启动、截图、退出 |
| `npm run build:win` | 打包 Windows 安装包 |
| `npm run build:mac` / `build:linux` | 打包 macOS / Linux 版本 |
| `node scripts/verify-*.cjs` | 各模块的独立测试脚本 |

## 数据位置

Windows 下为 `%APPDATA%/ssh-workbench/data/`（设置面板里可以看到具体路径）。

## 文档

整体方案、目录结构、分期路线：[DESIGN.md](./DESIGN.md)
