#!/bin/bash
# SSH Workbench v1.3.0 优化验证报告

echo "============================================"
echo "  SSH Workbench v1.3.0 优化验证报告"
echo "============================================"
echo ""

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 计数器
PASS=0
TOTAL=0

check_file() {
    TOTAL=$((TOTAL + 1))
    if [ -f "$1" ]; then
        echo -e "${GREEN}✓${NC} $2"
        PASS=$((PASS + 1))
        return 0
    else
        echo -e "${YELLOW}✗${NC} $2 - 文件不存在: $1"
        return 1
    fi
}

check_content() {
    TOTAL=$((TOTAL + 1))
    if grep -q "$2" "$1" 2>/dev/null; then
        echo -e "${GREEN}✓${NC} $3"
        PASS=$((PASS + 1))
        return 0
    else
        echo -e "${YELLOW}✗${NC} $3 - 未找到: $2 in $1"
        return 1
    fi
}

echo "📋 文件完整性检查"
echo "=================="
check_file "src/renderer/src/lib/shortcutConflict.ts" "快捷键冲突检测工具"
check_file "scripts/stress-test.js" "压力测试脚本"
check_file "scripts/build-release.sh" "Linux/macOS 构建脚本"
check_file "scripts/build-release.bat" "Windows 构建脚本"
check_file "OPTIMIZATION_SUMMARY.md" "优化总结文档"
check_file "USAGE_GUIDE.md" "使用指南"
check_file "CHANGELOG.md" "更新日志"
check_file "RELEASE_NOTES.md" "发布说明"
check_file "RELEASE_CHECKLIST.md" "发布检查清单"
check_file "README_OPTIMIZATIONS.md" "优化概述"
echo ""

echo "🔍 代码实现检查"
echo "================"
check_content "src/shared/types.ts" "restoreSessions" "会话恢复类型定义"
check_content "src/shared/types.ts" "lastOpenSessions" "会话列表类型定义"
check_content "src/renderer/src/App.tsx" "restoreSessions" "会话恢复逻辑"
check_content "src/renderer/src/App.tsx" "lastOpenSessions" "会话保存逻辑"
check_content "src/renderer/src/components/connections/ConnectionSidebar.tsx" "BatchTagsEditor" "批量编辑标签组件"
check_content "src/renderer/src/components/connections/ConnectionSidebar.tsx" "批量编辑标签" "批量编辑菜单项"
check_content "src/renderer/src/components/settings/SettingsPanel.tsx" "detectShortcutConflicts" "快捷键冲突检测导入"
check_content "src/renderer/src/components/settings/SettingsPanel.tsx" "会话恢复" "会话恢复设置项"
check_content "electron-builder.yml" "asar: true" "ASAR 打包启用"
check_content "electron-builder.yml" "compression: gzip" "gzip 压缩配置"
echo ""

echo "📝 功能模块检查"
echo "================"
check_content "src/renderer/src/lib/shortcutConflict.ts" "detectShortcutConflicts" "冲突检测函数"
check_content "src/renderer/src/lib/shortcutConflict.ts" "checkSingleConflict" "单项冲突检查"
check_content "scripts/stress-test.js" "testMassiveConnections" "大量连接测试"
check_content "scripts/stress-test.js" "testShortcutConflicts" "快捷键冲突测试"
check_content "scripts/stress-test.js" "testSessionRestore" "会话恢复测试"
echo ""

echo "============================================"
echo "  验证完成"
echo "============================================"
echo ""
echo "通过: $PASS / $TOTAL"
echo ""

if [ $PASS -eq $TOTAL ]; then
    echo -e "${GREEN}✅ 所有检查通过！${NC}"
    echo ""
    echo "下一步："
    echo "  1. 运行 npm install 安装依赖"
    echo "  2. 运行 npm run typecheck 进行类型检查"
    echo "  3. 运行 node scripts/stress-test.js 执行压力测试"
    echo "  4. 运行 npm run build 构建应用"
    echo "  5. 运行 npm run build:linux 打包发布版本"
    exit 0
else
    echo -e "${YELLOW}⚠️  部分检查失败，请检查上述输出${NC}"
    exit 1
fi
