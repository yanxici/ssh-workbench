# SSH Workbench

[English](./README.md) | 简体中文

轻量级桌面 SSH 客户端，内置面向嵌入式设备技术支持的工作台。基于 Electron + React + TypeScript。

## 功能

**连接与终端**
- 连接管理：分组（新建、重命名、删除、拖拽排序）、标签、颜色；支持密码、私钥（PEM / OpenSSH / PuTTY `.ppk`）、SSH Agent、keyboard-interactive 认证
- ProxyJump 跳板链、SOCKS5 / HTTP CONNECT 代理
- 从剪贴板识别 `ssh user@host -p 22` 命令，一键新建连接
- 多标签终端（xterm.js），支持搜索、自定义快捷键、ZMODEM（`rz` / `sz`，`sz` 下载可选保存目录、分块流式写入）
- 连接加密导出 / 导入，可在电脑之间迁移
- 断线自动重连，可见的错误日志

**常用命令面板**
- 单击执行，支持 `{{变量}}`、危险命令二次确认、分组、拖拽、搜索、收藏、历史
- JSON 导入导出
- 右侧常驻命令栏（固定三列按钮墙，`Ctrl+Alt+B` 开合）
- 命令中心（`Ctrl+K`）：模糊检索、中英同义、按使用热度排序、全键盘操作、范围筛选（全部 / 最近使用 / 最常用 / 收藏）

**文件与隧道**
- 终端旁的 SFTP 文件树、双栏传输模式、远程编辑（自动 `.bak` 备份）
- 传输队列：实时进度与速度，支持暂停 / 继续（从已传位置续传）/ 取消（自动清理半截文件）
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

**界面**
- 标题栏 + 活动栏 + 可拖拽侧栏与命令栏（拖动调宽，双击复位）
- 7 套配色主题（VS Code 浅色、Workbench、Dracula、Nord、Solarized、One Dark、Gruvbox），各含明暗两版，界面与终端联动
- 针对大规模连接列表优化（已测试 2900+ 条连接）：分页、超长分组默认折叠、会话索引加速

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
| `npm run build:win` | 打包 Windows 安装包（NSIS）+ 免安装版 |
| `npm run build:win:portable` | 仅打包免安装版（单 exe，不写注册表） |
| `npm run icon` | 重新生成多尺寸应用图标 |
| `npm run build:mac` / `build:linux` | 打包 macOS / Linux 版本 |
| `node scripts/verify-*.cjs` | 各模块的独立测试脚本 |

## 数据位置

Windows 下为 `%APPDATA%/ssh-workbench/data/`（设置面板里可以看到具体路径）。

## 文档

整体方案、目录结构、分期路线：[DESIGN.md](./DESIGN.md)

## 版本

当前版本：**v1.3.0**

最近更新：
- 断线自动重连
- 大规模连接列表性能优化（已测试 2900+ 条连接）
- 连接分组管理（新建、重命名、删除、拖拽排序）
- SFTP 打开目录性能优化
