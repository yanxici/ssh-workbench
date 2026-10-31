# SSH Workbench v1.7.1

**这是一个有安全缺口的版本，已由 v1.7.2 取代。** 保留此 Release 仅为记录与追溯，不要安装。

此版本引入的 `\\?\` 扩展前缀绕过（本地路径守卫可被四个字符绕过，实测可删任意用户可写文件）已在 v1.7.2 修复。请升级到 v1.7.2。


### Fixed（安全：本地路径守卫被 `\\?\` / `\\.\` 扩展前缀绕过）

**P0 — 破坏性操作可以借扩展前缀绕过黑名单。** `pathGuard` 之前只把 `normalize()` 之后的路径与黑名单比较，但 `\\?\C:\Windows\System32\config` 这类扩展前缀路径 `normalize` 之后**前缀原样保留**，黑名单里的 `C:\Windows\System32\config` 永远匹配不上。`//?/C:/...` 这种斜杠形态还会被 `normalize` 主动转成 `\\?\` 形态，两个入口都漏。

现在新增 `stripExtendedPrefix`，在 `normalize` **之前**剥掉 `\\?\`、`//?/`、`\\.\` 三种形态；`\\?\GLOBALROOT\...ShadowCopy` 直接拒绝；剥完不带盘符的（`\\.\PhysicalDrive0`、`\\.\pipe\xxx`）也拒绝。浏览侧 `assertBrowsableDir` 同样走这套清洗，前缀不再能漏给渲染层。

同时 `assertSafeLocalPath` 拒绝一切 UNC 路径的破坏性操作（`\\attacker\share` 对黑名单本就无意义），而 `assertBrowsableDir` 保留浏览——口径已在注释中写明。

### Fixed（`localList` 路径清洗不一致）

`localList` 用校验后的 `target` 读目录，却用原始 `dir` 拼子项路径，两个后果：

- `dir` 带前后空格时：`readdir(target)` 读到条目，`lstat(join(dir,...))` 全部 ENOENT，被空 `catch` 吞掉，**静默返回空列表**，用户看到空目录且无任何日志。
- `dir` 带 `\\?\` 前缀时：返回的 `path` 字段把前缀漏给渲染层。

现在统一用 `target` 拼路径；`catch` 只对 ENOENT 留 `console.warn`（EPERM/EACCES 是列 `C:\` 根的常态，不刷屏）。

### 回归

`verify-local-fs-guard` 33 条断言：新增 `\\?\` 4 条、`localList` 2 条、UNC 浏览侧 1 条。按「修复未落地会红」的判据写，3 条历史假绿（`a/b`、`..`、`a<b`）翻成断言守卫错误文案。

