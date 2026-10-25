@echo off
REM SSH Workbench 构建和发布脚本 (Windows)

echo =========================================
echo   SSH Workbench 构建脚本
echo =========================================
echo.

REM 检查 Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ 错误: 未找到 Node.js
    echo 请先安装 Node.js (v18 或更高版本^)
    exit /b 1
)

REM 检查 npm
where npm >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ 错误: 未找到 npm
    exit /b 1
)

echo ✅ Node.js 版本:
node --version
echo ✅ npm 版本:
npm --version
echo.

REM 安装依赖（如果需要）
if not exist "node_modules" (
    echo 📦 安装依赖...
    call npm install
    echo.
)

REM 运行类型检查
echo 🔍 类型检查...
call npm run typecheck
if %ERRORLEVEL% NEQ 0 (
    echo ❌ 类型检查失败
    exit /b 1
)
echo.

REM 运行压力测试
echo ⚡ 运行压力测试...
node scripts\stress-test.js
echo.

REM 构建应用
echo 🔨 构建应用...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo ❌ 构建失败
    exit /b 1
)
echo.

REM Windows 打包
echo 📦 打包 Windows 应用...
call npm run build:win
if %ERRORLEVEL% NEQ 0 (
    echo ❌ 打包失败
    exit /b 1
)
echo.

echo =========================================
echo   构建完成！
echo =========================================
echo.
echo 📁 输出目录: dist-v11\
echo 📊 压力测试结果: stress-test-results\
echo.
echo 包体积统计:
dir dist-v11\*.exe 2>nul
echo.
echo ✅ 所有任务完成
pause
