# SSH Workbench v1.7.2

本地路径守卫的两处绕过修复。**建议所有 v1.7.0 / v1.7.1 用户升级** —— 这两条都是能在用户机器上真删文件的安全缺口。


### Fixed（本地路径守卫两处绕过，均为 v1.7.0 引入）

**P0：`\\?\` / `\\.\` 扩展前缀让整条位置黑名单失效。** `pathGuard.ts` 的 `isForbiddenTarget` 全部基于 `resolve(path)`，而 `path.resolve('\\?\C:\Windows\System32\config')` 原样保留前缀（实测输出 `\\?\c:\windows\system32\config`），与黑名单字符串 `c:\windows\system32` 永不相等；`normalize('//?/C:/...')` 还会把斜杠形态**转成**前缀形态，两个入口都漏。渲染层被控制后，攻击者给任意路径加四个字符 `\\?\` 即可绕过全部位置判断——实测用该前缀真删掉了 tmp 目录里的文件、真建出了目录。

修法：新增 `stripExtendedPrefix`，在 `normalize` **之前**剥掉 `\\?\`、`//?/`、`\\.\` 三种形态；`GLOBALROOT` 单独拒绝（阴影副本路径剥完拿不到盘符）；剥完仍无盘符的（`\\.\PhysicalDrive0`、`\\.\pipe\x`）一并拒绝。`assertSafeLocalPath` 与 `assertBrowsableDir` 共用，返回值为剥过的路径，`fs` 作用在同一对象，行为无差异。

顺带定下 UNC 口径并写进注释：**浏览放行**（用户要能看网络共享），**删除/重命名拒绝**（黑名单对 `\\attacker\share` 本就无意义，拒绝比假装校验更诚实）。

**P1：`localList` 用校验后的 `target` 读目录，却用原始 `dir` 拼子项路径。** 后果是带前后空格的路径 `readdir(target)` 读到条目、`lstat(join(dir,...))` 全部 ENOENT 被空 `catch` 吞掉，**静默返回空列表**，用户看到空目录且日志无痕；带 `\\?\` 前缀时返回的 `path` 字段把前缀漏给渲染层，再回传给 `localDelete` 时行为靠巧合对齐。

修法：`join(dir, e.name)` → `join(target, e.name)`；`catch` 从空块改成只对 `ENOENT` 打 `console.warn`（EPERM/EACCES 是列 `C:\` 根时的常态，不刷屏）。

### Changed（回归断言判据，`AGENTS.md` 2.6 节）

本轮连出三个「绿了但没测到」，同一模式：**断言只看了终态没看区分度**。三类假绿已列表固化——用例自己消掉载荷（`path.resolve(work,'..','..')`）、判据看不出差异（耗时判 20s 窗口是否夹紧）、系统自己先抛错（`fs.rename` 自己抛 ENOENT 冒充守卫）。核心判据一句：写断言前自问「如果这个 bug 还在，这条会不会红」，验证方法把修复 `git stash` 掉重跑。

`verify-local-fs-guard` 从 11 条扩到 **33** 条：新增 `\\?\` 四条、`localList` 两条、UNC 浏览侧一条，并把 3 条假绿翻成断言守卫错误文案（`路径分隔符`/`名称无效`/`非法字符`）。

