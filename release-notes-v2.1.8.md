## 修复

### 并发上传断线续传会留下零洞（数据损坏，务必升级）

上传大文件时应用会并发写 6 个 256KB 的块。这些块的完成顺序不确定，连接在批次中途断掉时，可能只有靠后的块真的落盘。SFTP 按偏移写，没写到的区域就是零洞，但远端文件长度已经写到批次末尾 —— 于是 `fstat` 的远端大小、以及尾部 64KB 指纹比对，**双双给出「已经传到 pos」的假象**。续传从 pos 往后接着写，那个零洞就永久留在文件中间。

结果是最坏的一种：**远端文件大小完全正确，内容 sha256 全错**。不报错、不提示、进度条一路走到 100%。本次实测在 16MB 文件的 3.2MB–4.25MB 区间留下了 318881 字节的 `0x00`。

修复方式：引入「连续确认前缀」`acked`，与逻辑游标 `pos` 分离。批次内逐块回报完成标记，只推进从 `acked` 开始**连续**完成的块；断链后从 `acked` 重发，宁可多传几块，绝不让缺口留在中间。

### 标签栏所有按钮点了没反应

右键菜单原本直接渲染在标题栏里，而标题栏挂着 `-webkit-app-region: drag`。Chromium 把 drag 区域的鼠标消息交给窗口管理器做拖窗，`position: fixed` 只改绘制、不改 DOM 归属，所以菜单看着飞出来了，按钮的 mouseup 仍被窗口吞掉 —— hover 有反馈、点击零效果。

修复方式：菜单 `createPortal` 到 `document.body`，脱离 drag 子树；`blur` 监听器的拼写错误一并修正（原来是 `'blur-sm'`，导致监听器泄漏）。

## 新增回归

- `scripts/verify-resume-ui.cjs`：真 lab SSH 在 4MB 处拉断连接 + 真 Electron 窗口 + CDP 点真实上传按钮，断言远端内容 sha256 一致、UI 上「连接中断，正在重连后续传…」提示行**真的可见**（不是 title 属性）、传输结束提示消失。原有的网络级 e2e 对零洞不敏感，这条补上渲染层。
- `scripts/verify-tabmenu-os.cjs` / `scripts/verify-tabbar-os.cjs` 稳定化：每次点击前用 user32 把目标窗口重新置顶（避免桌面上后出现的窗口吃掉点击），几何校准改成「点击 → 读残差 → 修正原点」的闭环迭代，固定 sleep 全部换成轮询。连跑多轮 17/0 与 23/0；把 portal 修复退回后分别变 9 通过/8 失败 与 17 通过/6 失败，区分度成立。

## 校验

- `npm run typecheck` 干净，`npm run build` 成功
- 4 份 SFTP 回归全绿：`verify-sftp-resume`（R1–R9）、`verify-transfer-progress`、`verify-sftp-overwrite`、`verify-upload-folder`
- 真网络 24MB 断链续传 e2e：10 条全绿，上传 6.0 MB/s、下载 6.0 MB/s
- `verify-resume-ui`：12 条全绿（9.0s）