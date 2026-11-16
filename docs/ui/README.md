# v2.1.0 交付说明（客户端质感改造）

> 主线 `upgrade/tech-stack` @ `3e5ce60` · 7 个提交（5 个阶段 + 1 个补做 + 1 个发版）
> 产物：nsis / portable / zip 三件套，均已在打包后实测

## 交付内容

| 阶段 | 提交 | 内容 |
|---|---|---|
| 1 | `ui/tokens` | 设计 token（间距/圆角/动效/语义尺寸）+ 重复任意值收敛 + 5 面板灰度 flag |
| 2 | `ui/panel-switch` | 面板切换骨架兜底 + 空闲预加载（如实标注为非收益项）|
| 3 | `ui/virtual-list` | 双栏目录真虚拟滚动 + 标签/传输/发现三处硬上限 |
| 3.5 | 同上补做 | 虚拟化专项验证（8 条断言 + 变异测试，`npm run test:vlist`）|
| 4 | `ui/shortcuts` | 快捷键冲突检测改为作用域感知 + 修门禁 flaky |
| 5 | `ui/status-detail` | 连接阶段 tcp/handshake/jump/shell |
| 7 | `ui/webgl` | 终端 WebGL + 自愈式降级 |

## 未做的两件事（明确交代）

| 项 | 原因 |
|---|---|
| 阶段 3.5 剩余 3 个列表虚拟化 | `SessionFileTree` 是嵌套树（固定行高破坏树语义）、`HistoryPanel` 截断在 IPC 层（要先改跨进程分页）、`DiagnosticsPanel` 按 section 分组变高。三者当前都有截断，不会无限增长 |
| 阶段 6（ZMODEM 移出渲染主线程） | 审计确认它是真阻塞源，但搬移要重做协议状态机与 IPC 边界，风险最高。本版未动，建议单独评估 |

## 验证

| 项 | 结果 |
|---|---|
| typecheck / lint | 0 错误 |
| verify 脚本 | **61 项全绿**（v2.0.0 是 50 项）|
| UI e2e（开发构建） | 18/18 |
| **UI e2e（打包 exe）** | **18/18** |
| 虚拟列表专项 | 8/8 + 变异测试（关窗口化后 rows=10000，三条红）|
| 打包产物 serialport | 5/5（ABI 150 下可枚举 4 个 COM 口）|
| 文档同步门禁 | 6/6 |

## 产物

| 文件 | 大小 | SHA256 |
|---|---|---|
| `ssh-workbench-Setup-2.1.0.exe` | 117,765,827 | `84B2C9EE…776F55` |
| `ssh-workbench-2.1.0-portable.exe` | 117,545,101 | `2E3D2D70…7AA3` |
| `SSH Workbench-2.1.0-win.zip` | 156,531,908 | `4B1C2ACA…4B07` |
| `latest.yml` | — | version 2.1.0，指向 Setup |

## 本版最有价值的三条实测结论

1. **「切面板闪烁」的主体不是 chunk 下载**，而是面板打开后自己取数的 ~300ms（本地打包 chunk 只要十几毫秒）。
   所以预加载几乎无收益（变异测试实测有/无一致），骨架才是真正修掉观感的那一步。
2. **关硬件加速 ≠ 禁 WebGL**。Chromium 会用 SwiftShader 软件光栅化顶上，实测 `softwareRender=true` 时终端照样有 canvas。
   原断言「软件渲染 ⇒ canvas 为 0」是错的，已改。
3. **WebGL 渲染器下 `.xterm-rows` 与 `.xterm` 文本都是空的**（字形画在 canvas 上）。
   这一条把 `verify-xterm6` 的两条断言打红，现已改为断尺寸 + 读 buffer（普通构建 SKIP）。

## 回滚

```
3e5ce60  chore(release): v2.1.0          ← 当前
a2d18ef  阶段 7 WebGL
35443c1  阶段 5 连接阶段
e2e5d68  阶段 4 快捷键作用域
2fefdf4  阶段 3 虚拟化验证补做
0ce233b  阶段 3 列表上限 + 虚拟滚动
… 阶段 2 / 阶段 1 → 969b6e9（技术栈升级完成）
```

设计 token 也可以在设置 →「实验性」逐面板关闭，一键回到旧视觉（无需改代码、无需回退）。
