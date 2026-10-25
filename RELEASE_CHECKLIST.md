# SSH Workbench v1.3.0 - 发布前检查清单

## ✅ 代码实现

### 批量编辑标签
- [x] 新增 `BatchTagsEditor` 组件
- [x] 支持追加和替换两种模式
- [x] 集成到右键菜单
- [x] 添加成功提示
- [x] 自动去重标签

### 会话恢复
- [x] 在 `types.ts` 中添加配置类型
- [x] 在 `App.tsx` 中实现保存逻辑
- [x] 在 `App.tsx` 中实现恢复逻辑
- [x] 在设置面板中添加开关
- [x] 限制最多 10 个会话
- [x] 延迟 300ms 恢复避免阻塞

### 快捷键冲突检测
- [x] 创建 `shortcutConflict.ts` 工具模块
- [x] 实现 `detectShortcutConflicts()` 函数
- [x] 实现 `checkSingleConflict()` 函数
- [x] 在设置面板中显示冲突警告
- [x] 添加冲突确认对话框
- [x] 支持强制保存选项

### ASAR 打包优化
- [x] 在 `electron-builder.yml` 中启用 ASAR
- [x] 配置 gzip 压缩
- [x] 添加 SHA256 校验
- [x] 排除 resources 目录

## ✅ 测试脚本

- [x] 创建 `stress-test.js` 脚本
- [x] 实现大量连接测试
- [x] 实现快捷键冲突检测测试
- [x] 实现会话恢复测试
- [x] 生成 JSON 测试结果
- [x] 生成文本测试报告

## ✅ 构建脚本

- [x] 创建 `build-release.sh` (Linux/macOS)
- [x] 创建 `build-release.bat` (Windows)
- [x] 自动运行类型检查
- [x] 自动运行压力测试
- [x] 自动构建和打包
- [x] 显示包体积统计

## ✅ 文档

- [x] 创建 `OPTIMIZATION_SUMMARY.md` - 技术实现总结
- [x] 创建 `USAGE_GUIDE.md` - 用户使用指南
- [x] 创建 `CHANGELOG.md` - 完整更新日志
- [x] 创建 `RELEASE_NOTES.md` - 发布说明
- [x] 创建 `RELEASE_CHECKLIST.md` - 检查清单（本文件）

## 📋 发布前测试清单

### 功能测试

#### 批量编辑标签
- [ ] 选中 2 个连接，测试追加模式
- [ ] 选中 5 个连接，测试替换模式
- [ ] 输入空标签，验证错误处理
- [ ] 输入重复标签，验证去重功能
- [ ] 取消操作，验证无副作用

#### 会话恢复
- [ ] 启用会话恢复，打开 3 个连接，重启应用
- [ ] 禁用会话恢复，重启应用验证不恢复
- [ ] 打开 15 个连接，验证只恢复 10 个
- [ ] 恢复期间删除连接，验证跳过逻辑
- [ ] 快速连续重启，验证稳定性

#### 快捷键冲突检测
- [ ] 将两个操作设为同一快捷键，验证警告显示
- [ ] 录制新快捷键时触发冲突，验证弹窗
- [ ] 点击"取消"，验证不保存
- [ ] 点击"强制保存"，验证覆盖成功
- [ ] 恢复默认快捷键，验证冲突消失

### 性能测试

#### 压力测试
- [ ] 运行 `node scripts/stress-test.js`
- [ ] 验证所有测试通过
- [ ] 检查性能指标在预期范围内
- [ ] 查看 `stress-test-results/` 目录

#### 大量连接
- [ ] 创建 100 个连接，测试列表滚动
- [ ] 创建 500 个连接，测试搜索性能
- [ ] 批量编辑 100 个连接的标签
- [ ] 监控内存占用（应 < 100MB）

### 打包测试

#### Windows
- [ ] 运行 `npm run build:win`
- [ ] 测试安装版（Setup.exe）
- [ ] 测试便携版（portable.exe）
- [ ] 验证图标显示正常
- [ ] 检查包体积（应 < 80MB）

#### Linux
- [ ] 运行 `npm run build:linux`
- [ ] 测试 AppImage 可执行性
- [ ] 验证图标和启动菜单
- [ ] 检查包体积（应 < 90MB）

#### macOS
- [ ] 运行 `npm run build:mac`
- [ ] 测试 DMG 安装
- [ ] 验证应用签名（如适用）
- [ ] 检查包体积（应 < 85MB）

### 兼容性测试

- [ ] Windows 10 x64
- [ ] Windows 11 x64
- [ ] Ubuntu 20.04 LTS
- [ ] Ubuntu 22.04 LTS
- [ ] macOS 12 (Monterey)
- [ ] macOS 13 (Ventura)

### 回归测试

- [ ] 现有连接配置正常加载
- [ ] SSH 连接功能正常
- [ ] 文件传输（SFTP）正常
- [ ] 终端功能（搜索、复制、粘贴）正常
- [ ] 命令执行正常
- [ ] 设置保存和读取正常

## 🚀 发布步骤

### 1. 准备发布

```bash
# 更新版本号（如果尚未更新）
# 编辑 package.json 中的 version 字段

# 提交所有更改
git add .
git commit -m "Release v1.3.0: 批量编辑标签、会话恢复、快捷键冲突检测、ASAR优化"
git push origin main
```

### 2. 打标签

```bash
git tag -a v1.3.0 -m "Release v1.3.0"
git push origin v1.3.0
```

### 3. 构建所有平台

```bash
# Windows
npm run build:win

# Linux
npm run build:linux

# macOS
npm run build:mac
```

### 4. 验证构建产物

```bash
# 检查输出目录
ls -lh dist-v11/

# 验证文件完整性
sha256sum dist-v11/*.exe
sha256sum dist-v11/*.AppImage
sha256sum dist-v11/*.dmg
```

### 5. 创建 GitHub Release

1. 访问 https://github.com/yourusername/ssh-workbench/releases/new
2. 选择标签：v1.3.0
3. 标题：SSH Workbench v1.3.0
4. 描述：粘贴 RELEASE_NOTES.md 内容
5. 上传文件：
   - SSH-Workbench-1.3.0-Setup.exe
   - SSH-Workbench-1.3.0-portable.exe
   - SSH-Workbench-1.3.0-win.zip
   - SSH-Workbench-1.3.0.AppImage
   - SSH-Workbench-1.3.0.dmg
6. 勾选 "Set as the latest release"
7. 点击 "Publish release"

### 6. 发布后验证

- [ ] 下载链接可访问
- [ ] 所有平台的安装包完整
- [ ] Release notes 格式正确
- [ ] Changelog 已更新
- [ ] 文档链接有效

## 📢 宣传渠道

发布后可在以下渠道宣传：

- [ ] GitHub Release 页面
- [ ] 项目 README 更新
- [ ] 用户邮件列表（如有）
- [ ] 社交媒体（Twitter、微博等）
- [ ] 技术社区（Reddit、V2EX、知乎等）

## 🎯 关键指标

发布后跟踪：

- [ ] 下载次数
- [ ] 用户反馈
- [ ] Bug 报告数量
- [ ] 功能请求
- [ ] 性能问题反馈

## 📝 备注

- 所有测试必须在真实环境中进行，不能仅依赖模拟
- 发现问题立即修复，重新运行完整测试
- 保留旧版本安装包以便回滚
- 准备好快速修复流程应对紧急问题

---

**检查清单完成后，方可发布正式版本。**
