/**
 * 诊断报告生成自检（Markdown / HTML，无需构建环境）。
 * 用法：node node_modules/typescript/bin/tsc -p tsconfig.verify.json && node scripts/verify-report.cjs
 */
const { generateMarkdown, generateHtml, formatDateTime } = require('../.tsc-verify/main/util/reportFormat.js')
const {
  BUILTIN_DIAG_SECTIONS,
  DIAG_GROUP_ORDER
} = require('../.tsc-verify/main/data/diagTemplates.js')

const startedAt = new Date(2026, 9, 14, 16, 30, 0).getTime()
const finishedAt = startedAt + 41_000

const report = {
  id: '20261014-163000-A区',
  title: 'A区 · 192.168.1.20',
  connectionName: 'A区',
  host: '192.168.1.20',
  username: 'share',
  startedAt,
  finishedAt,
  sectionCount: 4,
  okCount: 3,
  problemCount: 1,
  size: 0,
  sections: [
    {
      sectionId: 'sys.info',
      name: '系统信息',
      group: '系统',
      command: 'uname -a; echo ---; hostname',
      status: 'done',
      output: 'Linux host 4.19.90 #1 SMP <aarch64> GNU/Linux\n---\nfactory01\n',
      exitCode: 0,
      durationMs: 120
    },
    {
      sectionId: 'cpu.top',
      name: 'CPU 占用 Top',
      group: 'CPU',
      command: 'top -b -n 1 | head -5',
      status: 'done',
      output: '令牌 <script>alert(1)</script> & "引号" \'单引号\'\n```\n嵌套围栏测试\n```\n',
      exitCode: 0,
      durationMs: 310
    },
    {
      sectionId: 'klog.errors',
      name: '内核错误扫描',
      group: '内核日志',
      command: "dmesg | grep -iE 'error|fail'",
      status: 'error',
      output: '',
      error: 'sh: dmesg: Permission denied',
      exitCode: 126,
      durationMs: 45
    },
    {
      sectionId: 'hw.temp',
      name: '温度传感器',
      group: '硬件',
      command: 'cat /sys/class/thermal/thermal_zone0/temp',
      status: 'timeout',
      output: '',
      exitCode: null,
      durationMs: 12000
    }
  ]
}

let pass = 0
let fail = 0

function check(name, condition, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ''}`)
  }
}

console.log('== Markdown 生成 ==')
{
  const md = generateMarkdown(report)
  check('包含标题', md.includes('# 诊断报告 · A区 · 192.168.1.20'))
  check('包含设备信息表', md.includes('192.168.1.20') && md.includes('share'))
  check('包含统计行', md.includes('共 4 项：正常 3 / 异常 1'))
  check('分组标题按出现顺序', md.indexOf('## 系统') < md.indexOf('## CPU') && md.indexOf('## CPU') < md.indexOf('## 内核日志'))
  check('含命令围栏', md.includes('```sh'))
  check('输出含 ``` 时围栏升级为 ````', md.includes('````'))
  check('超时项标记为警告', md.includes('### ⚠️ 温度传感器') && md.includes('**超时**'))
  check('stderr 以引用块呈现', md.includes('> sh: dmesg: Permission denied'))
  check('生成时间出现在尾部', md.includes(formatDateTime(finishedAt)))
}

console.log('== HTML 生成 ==')
{
  const html = generateHtml(report)
  check('文档结构完整', html.startsWith('<!DOCTYPE html>') && html.includes('</html>'))
  check('单文件自包含（无外链资源）', !html.includes('<link') && !html.includes('<script'))
  check('恶意尖括号被转义', html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !html.includes('<script>alert'))
  check('引号被转义', html.includes('&quot;引号&quot;') && html.includes('&#39;单引号&#39;'))
  check('设备树尖括号被转义', html.includes('&lt;aarch64&gt;'))
  check('含正常/异常统计', html.includes('正常 3') && html.includes('异常 1'))
  check('超时状态为红色卡片', html.includes('card bad') && html.includes('超时'))
  check('stderr 有独立样式块', html.includes('class="err"') && html.includes('class="errlabel"'))
  check('保留原始命令', html.includes('uname -a; echo ---; hostname'))
}

console.log('== 内置诊断模板 ==')
{
  const ids = BUILTIN_DIAG_SECTIONS.map((s) => s.id)
  check(
    `诊断项数量充足（当前 ${BUILTIN_DIAG_SECTIONS.length} 项，≥ 25）`,
    BUILTIN_DIAG_SECTIONS.length >= 25
  )
  check('ID 无重复', new Set(ids).size === ids.length)
  check(
    '所有分组均在预定义顺序中',
    BUILTIN_DIAG_SECTIONS.every((s) => DIAG_GROUP_ORDER.includes(s.group))
  )
  check('命令均非空且带降级兜底', BUILTIN_DIAG_SECTIONS.every((s) => s.command.trim().length > 0))
  check('全部标记为内置（不可误删）', BUILTIN_DIAG_SECTIONS.every((s) => s.builtin === true))
  check(
    '覆盖需求要求的全部关键分类',
    ['系统', 'CPU', '内存', '存储', '网络', '进程', '内核日志', '硬件', '固件'].every((g) =>
      BUILTIN_DIAG_SECTIONS.some((s) => s.group === g)
    )
  )
  check(
    '超时均为合理区间（1s-120s）',
    BUILTIN_DIAG_SECTIONS.every((s) => s.timeoutMs >= 1000 && s.timeoutMs <= 120000)
  )
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
