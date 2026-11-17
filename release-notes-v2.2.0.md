# SSH Workbench v2.2.0 —— 串口能改波特率、能发 BREAK，录制多一份能读的日志

这一版把串口线上原来做不到的三件事补上，外加一份能直接 grep 的日志。三件都不是新面板，而是「同一个串口连接里本来就该有、但因为没有而只能拔线重开」的动作。

## 一、不用断开重连就能改波特率

**问题**：设备上电跑 115200，进系统后切到 9600；或者反过来，为了抢 U-Boot 提示符得临时跳到 57600。以前只能改连接配置再重连，中间那段输出全丢 —— 而那段输出往往正是你要看的。

**改法**：`SerialTransport.setBaudRate(baudRate)` 调 `port.update({ baudRate })`，**不是 `close()` + 新建 `SerialPort`**。

重开一次端口会带来三个代价，全都不要：①重新走 DTR/RTS 的默认电平，接了自动下载电路的 ESP32 / STM32 会被复位；②设备在系统里重新枚举一次，端口的 `data` / `error` / `close` 订阅全部作废；③这一进一出之间的字节直接没有。`update` 只改 UART 分频，端口对象与事件订阅都还在。

生效值写回 `this.config.baudRate` 并作为返回值给出，界面按**真实生效值**回填输入框，而不是按用户敲的那串数字。非法值（字符串、负数、超过 4000000）回落**当前**速率 —— 切波特率时看到「已切到 115200」而实际没变，比直接报错难查得多。

判定区间收口在新文件 `src/shared/serialBaud.ts`（`SERIAL_MIN_BAUD = 50`、`SERIAL_MAX_BAUD = 4_000_000`、`isValidBaudRate`、`normalizeBaudRate`）。三处判定必须同源：`connections.json` 落盘、导入校验、传输层在线切。各写一遍就会出现「界面能填、导入认、打开时被 serialport 拒」这种自相矛盾。

## 二、BREAK

**问题**：板子已经在自动启动，想打断它进维护模式。串口线上只有 BREAK 这一种手段（把 TX 持续拉低一段时间，UART 层表现为帧错误 / 中断），而工具里没有。

**改法**：`sendBreak(durationMs = 250)`，`port.set({ brk: true })` → 等待 → `port.set({ brk: false })`。三处刻意的写法：

1. **时长夹在 50..2000ms**。太短某些 UART 根本不产生中断；太长会让整条线看起来像挂了。
2. **释放无条件执行**。置位时抛错也要把 `brk` 拉回 false —— 否则 TX 被钉在 break 状态，之后敲什么都不出去，用户只能拔线。所以失败是最后才抛，中间用 `failure` 变量记着。
3. **只碰 `brk` 字段**。`port.set` 会把没写的字段按默认值处理，顺手带上 `dtr`/`rts` 就等于顺手复位板子 —— 和上面第一条理由是同一件事。

界面上 BREAK 成功**不弹提示**：它的价值在于对端有没有反应（掉没掉进 U-Boot、进没进维护模式），本地「拉低成功」说明不了任何事。失败要提示，那多半是驱动不支持或端口已断。

## 三、纯文本日志

**问题**：录制只有 `.cast`。那是给回放器读的时间轴 + 原始控制码，要 grep 一个报错、要把它发到群里，得先另找一个工具转一遍。

**改法**：`recorder` 在写 `.cast` 的同时再写一份同名 `.log`（`RecorderOptions.plainText`，默认开）。文本通道自己做四件事：

- `stripAnsi` 剥 CSI / OSC。手写扫描而不是正则 —— 控制码嵌套起来时没人敢改那条正则，而这段代码是要长期被人读的。
- `\r\n` 与 `\r` 都归一成 `\n`。进度条那种原地重绘会变成一行行刷屏，但比粘成一行好读。
- 行首补**墙上时间** `[HH:MM:SS.mmm]`（`RecorderOptions.timestamp`，默认开）。现场排查要的是能与设备日志、抓包对表的时间，相对秒数对不上任何东西。
- 输入行前缀 `> `，一眼分得清谁敲的。

两种格式**各自计数**：`.cast` 撞到 50MB 只停 cast，`.log` 撞到 50MB 只停 log。一条通道被掐不会顺手把另一条也关了。

界面与导出按后缀分流（`SessionLogFile.format: 'cast' | 'log'`）：`.log` 标一个 `txt` 标签并**不显示回放按钮**（纯文本没有时间轴，给个点了没反应的按钮比不给更糟）；另存对话框按后缀选默认扩展名（`文本日志 .log` / `Asciinema Cast .cast`，顺序影响补全）；删除按「那次会话」而不是「那个文件」—— 删 `.cast` 连带删同名 `.log`，反之亦然。

## 四、设备只发 LF 时不再阶梯错位

**问题**：连 IFLY 机器人这类 Linux 设备，输出是一路向右错位的阶梯。编码没问题、字体没问题 —— 设备只发了 `\n`。终端里「换行」是两个动作：`\n` 把光标下移一行、`\r` 把光标拉回行首，只发前者就只有下移，每行都比上一行更靠右。设备 tty 本该由 `ONLCR` 翻成 `\r\n`，但 busybox 的精简 shell、裸机固件直接往串口 `write("\n")`、以及输出被重定向到串口的场景都不会翻。

**改法**：在 `SerialTransport` 的**入站文本通道**补 CR，新函数 `normalizeInboundNewlines(text, lastWasCR)`。四个选择都有代价，逐个说：

1. **放传输层，不开 xterm 的 `convertEol`**。那是终端实例级的开关，SSH 会话会跟着被改写；SSH 对端发的本来就是完整 CRLF，一旦上游已补过 CR，多余的改写就成了 `\r\r\n`。经过串口传输层的只有串口数据。
2. **`raw` 一个字节都不动**。`onData(chunk, text)` 两参数分开走：`raw` 原样透传（ZMODEM 帧与二进制协议靠它判帧，改一个字节 CRC 就废），只归一 `text`。这样录制、高亮行切分、终端拿到的内容一致，不会出现「屏幕对了、日志里还是阶梯」。
3. **跨帧状态 `lastWasCR`**。串口按块到达，上一块末尾 `\r` + 下一块开头 `\n` 是一个完整 CRLF；只看当前块会按「前面不是 CR」补成 `\r\r\n`，屏幕上反而多一个空行。`open()` 时重置为 false —— 上条连接末尾的 CR 不该影响这条的首帧。
4. **不看 `config.newline`**。那个字段描述「我们发出去用什么」，与设备回什么无关。

纯文本日志不用改：`recorder.writeText` 本来就把 `\r\n` 与 `\r` 都归一成 `\n`，入库站 CRLF 后 `.log` 不会多出空行。

## 五、接线与设置

- IPC 新增 `session:setBaud` / `session:break`，`channelTitle` 补中文标题，`preload` 暴露 `session.setBaud`（返回生效速率）/ `session.break`。
- `SessionInfo` 加 `baudRate?`：标签栏要显示当前速率时不必去正则解析 `COM3 · 57600 8N1`。
- `SerialBootBar` 折叠头右侧常驻 `Gauge + 速率`，展开体顶部单独一段「串口参数」—— 与刷机三步分开，因为「设备不吐字」和「刷机」是两件事：波特率错了的表现就是一片空白或满屏乱码，就地能试；BREAK 用来打断已经在自动启动的板子。档位下拉只把值填进输入框，不立刻切换；「应用」在速率没变时禁用。
- 切换成功后同时更新会话显示名（`sessionStore.applySerialBaud` 就地重算 `describeSerialTarget`），标签栏与状态条跟着变。
- 设置里加 `logPlainText` / `logTimestamp`（默认都开）。前者关掉后后者那一行一起隐藏 —— 它没有独立含义。

## 六、验证

- `scripts/verify-serial.cjs`：72 → **102 项**。新增三段 —— 切波特率真的走 `port.update` 而不是重建端口、生效值写回 config、非法与超上限回落当前值、驱动没有 `update` 时报可读错误；BREAK 先 `brk: true` 后 `brk: false`、只碰 `brk` 字段、时长被夹取、真实等待到点；会话层经假传输层转发，并在 `list()` 里看到新速率与新的显示名；以及入站归一那一段 —— 裸 LF 被补、已有 CRLF 不重复补、跨帧 CR|LF 不被拆开、`raw` 与源字节逐字节相同、分两帧发出的 CRLF 只补裸 LF 那一处。
- `scripts/verify-session-log.cjs`（新增，**24 项**）：临时 userData + 真实 `createWriteStream`。覆盖成对落盘、ANSI 被剥干净、一行一个时间戳、输入行前缀、`plainText: false` 与 `timestamp: false` 各自的边界、两种格式双向截断互不影响、`listSessionLogs` 带 `format`、删一种连带删另一种。
- 一个坑值得记：`stop()` 之后立刻读文件会读到空串 —— `createWriteStream` 是异步刷缓冲的。脚本里的 `waitText` 必须轮询，否则第一条断言会假红。

全部通过：`verify-serial` 102/102、`verify-session-log` 24/24、`verify-conn-transfer` 82/82、`verify-ipc-registration` 全绿（新通道都有注册点与中文标题）、`verify-docs-sync` 6/6。
