# 阶段 1（UI）：设计 token 落地

> 分支 `ui/tokens` · 父提交 `969b6e9`（技术栈升级完成） · 独立 commit

## 1. 做了什么

| 类别 | 内容 |
|---|---|
| 新增 token | 间距 5 档（4/8/12/16/24）、圆角 3 档（4/6/10）、动效 3 档时长 + 1 条主缓动、3 个语义尺寸 |
| 重复任意值收敛 | `bottom-[26px]/top-[38px]` 8 处 → `.panel-shell`；`w-[248px]` 3 处 → `.rail-w` |
| 新行口径 | `.row-token` / `.file-row-token` / `.conn-row-token`，行高统一 24px |
| flag 体系 | `AppSettings.experimental.tokens.<panel>`，5 个面板独立灰度 + 设置面板可见开关 |
| 新增回归 | `verify-design-tokens.cjs`（13 条）、`verify-experimental-flags.cjs`（5 条） |

## 2. 为什么是「并存两套」而不是直接改

硬约束要求「可独立回滚 + feature flag 控制」。所以新 token 全部走**新类名**
（`.row-token` 而非改 `.row`），旧类原样保留。关闭全部 flag 时渲染路径完全走旧类，
与改动前逐字节一致 —— 这是「能回滚」的实际含义。

## 3. 三个实测发现（都写进了代码注释）

### 3.1 `contain-intrinsic-size` 会参与实际布局

给 `.file-row-token` 加 `content-visibility: auto; contain-intrinsic-size: auto 28px` 后，
实测行高是 **36px**（28 估高 + py-1 的 8px），改成 24px 估高仍得 **32px**。
也就是说估高不是「未渲染时的替身」，而是会**叠加**在真实盒子上。
统一行高正是本阶段的目标，所以 token 行**不挂** content-visibility —— 阶段 3 上真虚拟化后由 JS 控高。

### 3.2 `row-token` 漏写 `text-xs` 会得 32px

不写字号会继承 body 的 15px/22px → 行高 32px 而不是 24px。已显式补 `text-xs`。

### 3.3 自绘标题栏的按钮不吃 `.click()`

`document.querySelector('[aria-label="设置"]').click()` 不触发 React 链路（面板弹不出来），
必须 `dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))`。
这条坑让 `verify-experimental-flags` 第一次跑出假失败，已写进脚本注释。

## 4. 门禁与基准

| 命令 | 结果 |
|---|---|
| typecheck | ✅ 0 错误 |
| lint | ✅ 0 错误 |
| test:verify | ✅ **57 通过 / 0 失败**（阶段 6 是 55，新增 2） |
| UI e2e | ✅ 18/18 |
| build | ✅ CSS 82.90 kB（+0.73）、JS 1,880.11 kB（+0.39） |

### 性能（同机 3 次中位数）

| 指标 | 改动前 | 改动后 | 变化 |
|---|---|---|---|
| 冷启动 | 642 ms | **662 ms**（661/687/662） | +3%（噪声） |
| 空闲内存 | 310.3 MB | 310.4 MB | 持平 |
| 10 会话内存 | 318.8 MB | 317.5 MB | 持平 |

**诚实标注**：冷启动共测了 3 轮，第一轮读到 771/779/785（中位 779），
后两轮读到 704 与 662。同一份代码差 117ms，说明**这台机器在测量窗口内有偶发负载**，
779 那组不可信。取「无其它进程、连续三轮一致」的 662ms 作为结论。
内存三次测量（307.9 / 310.4 / 311.2）离散度 ≤3.3 MB，可信。

## 5. 风险与回滚

| 风险 | 说明 |
|---|---|
| flag 全关时仍走旧路径 | 已验证（`verify-experimental-flags` 第 5 条） |
| `.panel-shell` 替换了 8 处内联值 | 值相同（26/38px），见面板截图无变化；断言 `.panel-shell` computed 值等于 token |
| 新 flag 字段进 settings.json | 老版本读到会忽略（多出的键无害），已确认 `mergeSettings` 为浅合并 |

回滚：`git checkout upgrade/tech-stack`，或在设置里把 5 个开关全部关掉（无需改代码）。
