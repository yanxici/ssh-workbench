#!/bin/bash
# SSH Workbench 构建和发布脚本

set -e

# 产物目录：从 electron-builder.yml 的 directories.output 解析，不在脚本里硬编码。
#
# 硬编码的历史教训：dist-v13 → dist-v14 → dist-v15 改了三次，
# 每次忘改脚本就会去旧目录找产物 —— 要么报「找不到文件」，
# 要么把旧版本残留的 Setup 误当成待发布文件传上去，后者是生产事故。
OUTPUT_DIR="$(
  awk '/^directories:/{d=1;next} d&&/^[^[:space:]]/{d=0} d&&/^[[:space:]]+output:/{print $2;exit}' \
    "$(dirname "$0")/../electron-builder.yml" | tr -d '"'"'"
)"
if [ -z "$OUTPUT_DIR" ]; then
  echo "❌ 无法从 electron-builder.yml 解析 directories.output"
  exit 1
fi

echo "========================================="
echo "  SSH Workbench 构建脚本"
echo "========================================="
echo ""

# 检查依赖
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未找到 Node.js"
    echo "请先安装 Node.js (v18 或更高版本)"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo "❌ 错误: 未找到 npm"
    exit 1
fi

echo "✅ Node.js 版本: $(node --version)"
echo "✅ npm 版本: $(npm --version)"
echo ""

# 安装依赖（如果需要）
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖..."
    npm install
    echo ""
fi

# 运行类型检查
echo "🔍 类型检查..."
npm run typecheck
echo ""

# 运行压力测试
echo "⚡ 运行压力测试..."
node scripts/stress-test.js
echo ""

# 构建应用
echo "🔨 构建应用..."
npm run build
echo ""

# 根据平台打包
PLATFORM=$(uname -s)
echo "📦 打包应用 (平台: $PLATFORM)..."

case "$PLATFORM" in
    Linux*)
        npm run build:linux
        echo "✅ Linux 打包完成"
        ls -lh "$OUTPUT_DIR"/*.AppImage 2>/dev/null || echo "未找到 AppImage"
        ;;
    Darwin*)
        npm run build:mac
        echo "✅ macOS 打包完成"
        ls -lh "$OUTPUT_DIR"/*.dmg 2>/dev/null || echo "未找到 DMG"
        ;;
    MINGW*|MSYS*|CYGWIN*)
        npm run build:win
        echo "✅ Windows 打包完成"
        ls -lh "$OUTPUT_DIR"/*.exe 2>/dev/null || echo "未找到 EXE"
        ;;
    *)
        echo "❌ 不支持的平台: $PLATFORM"
        exit 1
        ;;
esac

echo ""
echo "========================================="
echo "  构建完成！"
echo "========================================="
echo ""
echo "📁 输出目录: $OUTPUT_DIR/"
echo "📊 压力测试结果: stress-test-results/"
echo ""
echo "包体积统计:"
du -sh "$OUTPUT_DIR"/* 2>/dev/null | head -10 || echo "无法读取文件大小"
echo ""
echo "✅ 所有任务完成"
