# SSH Workbench v2.0.0

这一版补上了 v1.x 一直标着「明确不做」的那件事：**串口**。

理由不是「功能列表里缺一项」，而是现场的动作对不上工具。真实场景是插上 USB 转串口线，敲 `dmesg` 看设备起没起来 —— 连接管理、命令库、会话录制、日志归档全都在这个工具里，唯独最救急的那条通道在外面，必须切到另一个串口工具。当时不做的理由是开发效率：传输层与会话层是照 ssh2 的形状写的，塞一个串口进去等于把两层都翻一遍。现在翻完了。

## 范围：只做 Console 救急

先把「不做什么」写清楚，否则下一版会被当成协议调试器用：

- **不做**十六进制收发
- **不做**协议调试器（Modbus / AT 帧解析之类）
- **不做** XMODEM / YMODEM 传文件
- **不做**断线期间的串口输出缓冲与回放

成功标准只有一条：**Console 里敲命令，不用另开工具。**

## 做了什么

### 传输层抽象（这次重构的真正收获）

新增 `src/main/transport/`，`Transport` 接口只有六个方法（`open` / `write` / `writeBytes` / `resize` / `close` + `onData(raw, text)` / `onClose`），三个实现：

| 实现 | 说明 |
|---|---|
| `sshTransport.ts` | 接管原先散在会话管理器里的解码：`StringDecoder('utf-8')`，stderr 混流 |
| `serialTransport.ts` | 换行归一、流式 iconv 解码（UTF-8 / GBK / GB18030）、DTR 脉冲 |
| `memoryTransport.ts` | 内存假实现，验证脚本用 |

会话管理器不再直接抱着 ssh2 —— 它只认 `Transport`。顺带把待写缓冲改成按字节合帧（`pendingRaw`），主进程不再假设「收到的都是 UTF-8」。

### 设备身份：宁可报错，也不连错设备

Windows 的 COM 号按枚举顺序分配，拔掉再插、或者换到另一个 USB 口，COM3 可能变成 COM7；更糟的是另一台同型号设备可能正好占了 COM3。按 `serialNumber` → `pnpId` → 保存的 COM 号 三级匹配，其中：

> **存了 USB 身份却对不上时，绝不退化到 COM 号。**

那说明现在插在这个端口上的不是当初那台设备，静默连上去就是往陌生板子上敲命令。这种情况返回「找不到」，界面提示重选端口。

唯一例外是平台根本给不出身份 —— Linux 的 `/dev/ttyUSB0` 常常没有 serialNumber / pnpId，整个端口列表都是空身份，此时才按 COM 号判定，否则 Linux 用户永远连不上。

### 拔插恢复：不复用 SSH 的退避

SSH 用 1 / 2 / 4 / 8 / 16 秒退避重连是对的（对端可能只是在重启）。串口不一样：拔线时按退避去重开一个不存在的设备毫无意义，而且插回的瞬间常落在长间隔里，用户会以为功能坏了。

改成把会话停在 `phase: 'waiting-device'`（界面显示「串口已断开，请检查连接线；设备插回后会自动重连」），由 2 秒一次的端口轮询驱动恢复。恢复成功后补发一个 `\r` 唤醒提示符 —— 很多设备的串口控制台在长时间无输入后会停止回显，一个回车能把提示符叫出来。

### DTR 默认关

ESP32 / STM32 / Arduino 的自动下载电路把 DTR 接到 EN 脚，一拉就复位。用户只是想看日志，结果把设备重启了，在现场是事故。所以：

- 自动复位开关**默认关闭**；
- 串口连接里**隐藏「测试连接」按钮** —— 反复开关端口会触发 DTR，等于反复重启设备。

### 串口会话只给终端

指标、诊断、固件、备份、批量、SFTP、隧道全部只对 SSH 会话开放。它们都建立在「远端跑一条命令」上（主进程统一走 `getClient` + `execCollect`），串口没有 `client`，列出来只会拿到一句「该功能仅支持 SSH 会话」。这些面板的会话列表直接过滤掉串口会话，并各自补了空态文案。

### 命令「适用环境」

命令加了 `envs?: ConnKind[]`（缺省 = 两者都适用），命令面板、命令中心、卡片浮层、编辑器全部接上；命令库头部计数改成过滤后的条数。

种子命令只给 5 条只在完整 Linux 上可用的标 `['ssh']`：`nc -zv`、`curl -i`、`top -b -n 1`、`journalctl -b -p err`、`i2cdetect`。其余 36 条不动 —— `uname -a` / `dmesg` / `cat /proc/*` / `reboot` 在 BusyBox 上都很常见，一刀切会误伤。

### 串口连接可导出 / 导入

和 SSH 连接一样能发给同事，USB 身份一起带走。对方机器插上同一台设备时按身份自动找回端口；找不到的标成 `pathPending`，导入对话框直接提示「N 条的端口在本机找不到，导入后需要重新选择端口」—— 而不是等到连接时才报一句原生层的 open failed。

## 打包：没有引入 rebuild

`@serialport/bindings-cpp@13.0.0` 提供的是 **NAPI v8 预编译**，Electron 33.4.11（ABI 130）与 Node 24 都能直接加载，`npmRebuild: false` 保持不动。electron-builder 25.x 会自动解包原生模块，`asarUnpack` 不需要写 `'**/*.node'`（对照实验确认，注释写进了 `electron-builder.yml`）。

原生模块走 `serialLoader.ts` 懒加载，用变量形式 `require` 让 esbuild 无法静态解析 —— 否则打包后在没有对应二进制的环境（CI、裸 node 跑验证脚本）里直接抛 `No native build was found`，连主进程都起不来。懒加载同时解决两件事：只用 SSH 的用户不必付这笔启动开销；原生模块加载失败只影响串口。

## 测试

- **verify-serial.cjs 50 通过 / 0 失败**（新增）—— 内存假实现 + 假端口：换行归一（CR / LF / CRLF）、GBK 流式解码、DTR 脉冲只碰 DTR 不碰 RTS、拔线 → `waiting-device` → 插回自动恢复、Linux 无身份环境按 COM 号退化。
- **verify-serial-native.cjs**、**serial-spike-main.cjs** / **serial-spike-packaged.cjs**（新增）—— 原生模块在裸 node 与打包产物里能否加载；`.github/workflows/serial-spike.yml` 单独跑这一条。
- **verify-conn-transfer.cjs** 补五组用例 —— 串口导出、导入、USB 身份找回端口（COM3 → COM7）、找不到时标待确认、串口参数非法计入 invalid。
- 全量 `node scripts/run-all-verify.cjs` **51 通过 / 0 失败**；主进程与渲染层 tsc 均 0 错误。

## 升级注意

- 串口功能需要系统里有 USB 转串口驱动（CH340 / CP210x / FTDI）。精简版 Windows 可能缺 VC++ 运行库，此时串口加载失败但 SSH 不受影响，界面会给出提示。
- 老版本导出的 `.swconn` 文件没有 `kind` 字段，按 SSH 处理，行为不变。
- 如果你在 v1.x 手动改过 `connections.json`，串口相关字段会在下次保存时按白名单归一化。

## 下载

- **安装版**（推荐，支持自动更新）：ssh-workbench-Setup-2.0.0.exe
- 已安装 v1.x 的用户可直接从应用内「检查更新」升级。
