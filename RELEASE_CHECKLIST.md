# SSH Workbench 发布前检查清单

> 周期性发版用。以 v1.4.4 为基线整理，每次发版把「本次变更」小节换成当次内容，其余直接复用。

---

## 0. 优先排查：目录完整性标签

**动手前先跑这条。** 本机反复出现过「双击 exe 没反应 / 退出码 `-2147483645` / 0xC0000005 / 同一份 exe 拷到别的目录就能跑」——根因是目录被打上 `Low Mandatory Level` 完整性标签，Electron 沙箱子进程启动即被杀。

```powershell
icacls "D:\ssh-workbench" | Select-String "Mandatory"
icacls "D:\ssh-workbench\dist-v11" | Select-String "Mandatory"
```

命中 `Low Mandatory Level` 就修：

```powershell
icacls "D:\ssh-workbench" /setintegritylevel "(OI)(CI)Medium" /T
```

> 修完不需要重启机器。判定标准是 `Mandatory Label\Medium Mandatory Level`。

---

## 1. 本次变更（v1.4.4）

### 修复：分组字段选不了其他分组（严重）
- [x] 定位根因：原生 `<datalist>` 按输入框当前值做子串过滤，预填「默认」时只剩 1 条候选，浏览器无关闭开关
- [x] 新增 `Combobox`（`src/renderer/src/components/ui/index.tsx`）
- [x] `CommandEditor` 分组字段接入并移除 datalist
- [x] `ConnectionEditor` 分组字段接入并移除 datalist
- [x] `DiagSectionEditor` 分类字段接入并移除 datalist
- [x] 验证：打开即全量候选、点选生效、打字过滤、Esc 不连带关弹窗、下方空间不足上翻

### 修复：命令名 / 命令文本撑出卡片
- [x] `CommandPanel` 名称行与命令行补 `w-full min-w-0`
- [x] `CommandCenter` 名称行补 `w-full`
- [x] 实测 129 张卡：命令行溢出 82→0、名称行 92→0

### 全量溢出复查
- [x] CDP 逐屏打开 12 个视图/面板扫描右边界溢出 → 0 处

---

## 2. 通用检查流程

### 2.1 类型检查

```bash
npm run typecheck   # 必须 EXIT=0
```

### 2.2 压测

```bash
node scripts/stress-test.js
```

- [ ] 全部通过
- [ ] `stress-test-results/` 已更新（summary.txt + 4 个 json）
- [ ] 内存占用 < 100MB（2000 连接场景）

### 2.3 版本号与日志

- [ ] `package.json:3` 的 `version` 已 bump
- [ ] `CHANGELOG.md` 顶部新增本版条目（Fixed / Added / Changed 分类）
- [ ] `README.md` 与 `README.zh-CN.md` 的「当前版本 / 最近更新」已同步
- [ ] `RELEASE_NOTES.md` 已按本版重写
- [ ] `DESIGN.md` 头部阶段行 + §7.0 版本更新记录已补

### 2.4 构建

```bash
# 换输出目录前先确认 electron-builder.yml 的 directories.output
npx electron-vite build
npx electron-builder --win --config electron-builder.yml
```

- [ ] `out/main/index.js`、`out/preload/index.js`、`out/renderer/` 均生成
- [ ] rcedit 阶段没报 `Fatal error: Unable to commit changes`（报了说明旧 exe 还在跑，先杀进程）
- [ ] 产物齐全（**本地仍出三件套**，只是远端不全传）：`Setup <ver>.exe` + `Setup <ver>.exe.blockmap` + `portable.exe` + `win.zip` + `latest.yml`

### 2.5 打包产物冒烟（不能只测源码态）

源码态过了不代表产物能过——asar 打包、资源路径、原生层图标都可能变。

```powershell
# 注意：shell 里若存在 ELECTRON_RUN_AS_NODE，Electron 会被当纯 Node 跑，冒烟必挂
Remove-Item Env:ELECTRON_RUN_AS_NODE -EA SilentlyContinue
Start-Process "dist-v11\win-unpacked\SSH Workbench.exe" -ArgumentList '--remote-debugging-port=9337'
```

- [ ] 进程存活，`title=SSH Workbench`
- [ ] 通过 CDP 验证本次改动的关键交互
- [ ] 全视图溢出扫描 0 处

> 冒烟脚本注意：点选后**不要**在同一个 `Runtime.evaluate` 里同步读 `input.value`，React 还没重渲染会误判 FAIL。改成 click → 等 300~500ms → 另起一次 evaluate 读值。
> 另一个坑：上一轮测试残留的弹窗/浮层会污染下一轮，每轮开头先关掉所有 `[role="dialog"]`，必要时重启应用。

### 2.6 提交与发布

```bash
git add <具体文件>          # 不要 git add .
git commit -m "fix(scope): 简述"
git tag -a v<ver> -m "v<ver>"
git -c http.proxy=http://127.0.0.1:7897 push origin main
git -c http.proxy=http://127.0.0.1:7897 push origin v<ver>
```

- [ ] commit 信息能说清「改了什么 + 为什么」
- [ ] tag 与 `package.json` 版本一致
- [ ] push 走本地代理（直连 GitHub 不可达）

### 2.7 GitHub Release

- [ ] 创建 Release，tag 选中刚推的
- [ ] 正文用 `RELEASE_NOTES.md` 内容
- [ ] **只上传 Setup 安装包，其余安装版本一律不上传**（用户 2026-10-26 定的规则）
  - 传：`Setup <ver>.exe`、`Setup <ver>.exe.blockmap`、`latest.yml` —— 后两个是自动更新元数据，不是"另一个版本"，缺了客户端查不到更新 / 无法差量下载
  - 不传：`portable.exe`、`win.zip` —— 与 Setup 解出来的 `win-unpacked` 完全一致，多传只是白费 200+ MB 带宽
  - 本地 `dist-v11` 照样出三件套，这条**只约束远端上传**
- [ ] asset `state=uploaded`，体积与本地一致
- [ ] 回读 release 的 `assets` 数组：恰好 3 个文件，无 portable / zip

> 凭证：`git credential fill` 可取到系统凭证管理器里的 token（用户 `yanxici`，scope 含 `repo`）。上传走 `https://uploads.github.com`；`NODE_TLS_REJECT_UNAUTHORIZED=0` 只在本地网络有 TLS 中间人时需要。

### 2.8 发布后验证

- [ ] Release 页面可访问，asset 可下载
- [ ] `git status` 干净（临时脚本、日志都已清理）
- [ ] 杀掉所有残留的 `SSH Workbench` / `electron` 进程

---

## 3. 退出条件

全部页面测试项通过 + 冒烟在**打包产物**上通过 + Release asset 完整，才算发布完成。

保留上一版安装包以便回滚。
