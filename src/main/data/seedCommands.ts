import { randomUUID } from 'node:crypto'
import type { Command } from '@shared/types'

/**
 * 内置常用命令种子 —— 只在首次运行（commands.json 不存在）时注入一次。
 * 面向嵌入式设备技术支持场景：远程排查、巡检、维护。
 */

type SeedInput = Omit<Command, 'id' | 'sortOrder' | 'useCount' | 'createdAt' | 'updatedAt'>

function cmd(input: SeedInput): SeedInput {
  return input
}

const SEED: SeedInput[] = [
  /* ---------------- 系统信息 ---------------- */
  cmd({
    name: '系统内核信息',
    command: 'uname -a',
    description: '内核版本、主机名、架构',
    group: '系统信息',
    icon: 'Info',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '发行版信息',
    command: 'cat /etc/os-release 2>/dev/null || cat /etc/issue',
    description: '发行版名称与版本号',
    group: '系统信息',
    icon: 'Terminal',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: 'CPU 型号与核心数',
    command: 'grep -E "model name|processor|Hardware" /proc/cpuinfo | head -n 20',
    description: 'CPU 硬件信息',
    group: '系统信息',
    icon: 'Cpu',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '内存使用情况',
    command: 'free -h 2>/dev/null || head -n 5 /proc/meminfo',
    description: '总内存 / 已用 / 可用',
    group: '系统信息',
    icon: 'MemoryStick',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '磁盘占用',
    command: 'df -h',
    description: '各分区容量与使用率',
    group: '系统信息',
    icon: 'HardDrive',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '运行时长与负载',
    command: 'uptime',
    description: '开机时长、平均负载',
    group: '系统信息',
    icon: 'Clock',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '系统时间',
    command: 'date && cat /etc/timezone 2>/dev/null',
    description: '当前时间与时区',
    group: '系统信息',
    icon: 'Timer',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '挂载点列表',
    command: 'mount | column -t 2>/dev/null || cat /proc/mounts',
    description: '当前挂载的文件系统',
    group: '系统信息',
    icon: 'Layers',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '块设备列表',
    command: 'lsblk 2>/dev/null || cat /proc/partitions',
    description: '磁盘与分区拓扑',
    group: '系统信息',
    icon: 'HardDrive',
    confirmRequired: false,
    variables: []
  }),

  /* ---------------- 网络诊断 ---------------- */
  cmd({
    name: '查看 IP 地址',
    command: 'ip addr 2>/dev/null || ifconfig',
    description: '网卡与 IP 配置',
    group: '网络诊断',
    icon: 'Network',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '路由表',
    command: 'ip route 2>/dev/null || route -n',
    description: '默认网关与路由项',
    group: '网络诊断',
    icon: 'Router',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: 'DNS 配置',
    command: 'cat /etc/resolv.conf',
    description: 'DNS 服务器列表',
    group: '网络诊断',
    icon: 'Globe',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '端口监听列表',
    command: 'netstat -tunlp 2>/dev/null || ss -tunlp',
    description: '本机监听端口与服务',
    group: '网络诊断',
    icon: 'Plug',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: 'Ping 目标主机',
    command: 'ping -c 4 {{host}}',
    description: '连通性与丢包检测',
    group: '网络诊断',
    icon: 'Wifi',
    confirmRequired: false,
    variables: [
      { name: 'host', label: '目标主机', type: 'text', required: true, placeholder: '192.168.1.1' }
    ]
  }),
  cmd({
    name: '端口连通性探测',
    command: 'nc -zv -w 3 {{host}} {{port}}',
    description: 'TCP 端口是否可达',
    group: '网络诊断',
    icon: 'Plug',
    confirmRequired: false,
    variables: [
      { name: 'host', label: '目标主机', type: 'text', required: true, placeholder: '192.168.1.1' },
      { name: 'port', label: '端口', type: 'text', required: true, defaultValue: '22' }
    ]
  }),
  cmd({
    name: 'HTTP 接口测试',
    command: 'curl -sS -m 8 -i {{url}} 2>&1 | head -n 40',
    description: '查看响应头与前若干行内容',
    group: '网络诊断',
    icon: 'Globe',
    confirmRequired: false,
    variables: [
      {
        name: 'url',
        label: 'URL',
        type: 'text',
        required: true,
        placeholder: 'http://192.168.1.1/api/status'
      }
    ]
  }),
  cmd({
    name: 'ARP 表',
    command: 'arp -a 2>/dev/null || ip neigh',
    description: '局域网邻居缓存',
    group: '网络诊断',
    icon: 'Network',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '网卡流量统计',
    command: 'cat /proc/net/dev',
    description: '收发字节/错误计数',
    group: '网络诊断',
    icon: 'Activity',
    confirmRequired: false,
    variables: []
  }),

  /* ---------------- 进程与资源 ---------------- */
  cmd({
    name: '进程快照',
    command: 'ps aux 2>/dev/null || ps',
    description: '全部进程与资源占用',
    group: '进程与资源',
    icon: 'ListTree',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '资源占用 TOP',
    command: 'top -b -n 1 | head -n 25',
    description: 'CPU / 内存占用最高的进程',
    group: '进程与资源',
    icon: 'Gauge',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '系统负载',
    command: 'cat /proc/loadavg',
    description: '1/5/15 分钟平均负载',
    group: '进程与资源',
    icon: 'Activity',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '进程详情',
    command: 'ls -l /proc/{{pid}}/cwd && cat /proc/{{pid}}/status | head -n 12',
    description: '进程工作目录与状态',
    group: '进程与资源',
    icon: 'FileText',
    confirmRequired: false,
    variables: [
      { name: 'pid', label: '进程号 PID', type: 'text', required: true, placeholder: '1024' }
    ]
  }),

  /* ---------------- 日志排查 ---------------- */
  cmd({
    name: '内核日志尾部',
    command: 'dmesg | tail -n 100',
    description: '最近的内核消息',
    group: '日志排查',
    icon: 'FileText',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '日志文件尾部',
    command: 'tail -n 200 {{path}}',
    description: '查看日志文件最后 200 行',
    group: '日志排查',
    icon: 'FileText',
    confirmRequired: false,
    variables: [
      {
        name: 'path',
        label: '日志文件路径',
        type: 'text',
        required: true,
        defaultValue: '/var/log/messages'
      }
    ]
  }),
  cmd({
    name: '关键字检索日志',
    command: 'grep -rn -i "{{keyword}}" {{path}} 2>/dev/null | tail -n 50',
    description: '在日志文件中检索关键字',
    group: '日志排查',
    icon: 'Search',
    confirmRequired: false,
    variables: [
      { name: 'keyword', label: '关键字', type: 'text', required: true, placeholder: 'error' },
      {
        name: 'path',
        label: '目录或文件',
        type: 'text',
        required: true,
        defaultValue: '/var/log'
      }
    ]
  }),
  cmd({
    name: '错误关键字汇总',
    command: 'dmesg | grep -iE "error|fail|oops|panic|segfault" | tail -n 50',
    description: '内核错误/崩溃关键字',
    group: '日志排查',
    icon: 'Bug',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '启动错误日志',
    command: 'journalctl -b -p err --no-pager 2>/dev/null | tail -n 100',
    description: '本次启动的错误级日志（systemd 系统）',
    group: '日志排查',
    icon: 'FileText',
    confirmRequired: false,
    variables: []
  }),

  /* ---------------- 嵌入式专项 ---------------- */
  cmd({
    name: 'CPU 温度',
    command: 'for z in /sys/class/thermal/thermal_zone*; do echo "$z: $(cat $z/temp 2>/dev/null)"; done',
    description: '各温区原始读数（通常为毫摄氏度）',
    group: '嵌入式专项',
    icon: 'Thermometer',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: 'GPIO 状态',
    command: 'cat /sys/kernel/debug/gpio 2>/dev/null || echo "debugfs 未挂载，可执行: mount -t debugfs none /sys/kernel/debug"',
    description: 'GPIO 方向与电平',
    group: '嵌入式专项',
    icon: 'Microchip',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '串口设备列表',
    command: 'ls -l /dev/ttyS* /dev/ttyUSB* /dev/ttyACM* 2>/dev/null',
    description: '枚举板载/USB 串口设备',
    group: '嵌入式专项',
    icon: 'Cable',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: 'I2C 总线扫描',
    command: 'i2cdetect -y {{bus}}',
    description: '扫描 I2C 总线上的从设备地址',
    group: '嵌入式专项',
    icon: 'Microchip',
    confirmRequired: false,
    variables: [
      { name: 'bus', label: '总线号', type: 'text', required: true, defaultValue: '1' }
    ]
  }),
  cmd({
    name: '电源与电压',
    command: 'for p in /sys/class/power_supply/*; do echo "== $p"; cat $p/voltage_now 2>/dev/null; cat $p/capacity 2>/dev/null; done',
    description: '电池/适配器电压与电量',
    group: '嵌入式专项',
    icon: 'Zap',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '闪存挂载与错误',
    command: 'dmesg | grep -iE "mmc|emmc|nand|flash|ubi" | tail -n 30',
    description: '查看存储介质相关内核消息',
    group: '嵌入式专项',
    icon: 'HardDrive',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '固件版本探测',
    command: 'cat /etc/version /etc/fw_version /etc/firmware_version 2>/dev/null; uname -r',
    description: '尝试读取厂商固件版本文件',
    group: '嵌入式专项',
    icon: 'Rocket',
    confirmRequired: false,
    variables: []
  }),

  /* ---------------- 设备维护 ---------------- */
  cmd({
    name: '同步文件缓冲',
    command: 'sync && echo "文件系统缓冲已同步"',
    description: '把内存缓冲刷到存储介质（断电前建议执行）',
    group: '设备维护',
    icon: 'RefreshCw',
    confirmRequired: false,
    variables: []
  }),
  cmd({
    name: '重启系统',
    command: 'reboot',
    description: '重启设备，当前连接会断开',
    group: '设备维护',
    icon: 'Power',
    confirmRequired: true,
    variables: []
  }),
  cmd({
    name: '关机',
    command: 'poweroff',
    description: '关闭设备，当前连接会断开',
    group: '设备维护',
    icon: 'Power',
    confirmRequired: true,
    variables: []
  }),
  cmd({
    name: '磁盘写入测试',
    command: 'dd if=/dev/zero of={{path}} bs=1M count=10 && sync && rm -f {{path}} && echo "写入测试完成"',
    description: '向目标路径写入 10MB 测试数据并删除',
    group: '设备维护',
    icon: 'HardDrive',
    confirmRequired: true,
    variables: [
      {
        name: 'path',
        label: '测试文件路径',
        type: 'text',
        required: true,
        defaultValue: '/tmp/write_test.bin'
      }
    ]
  }),
  cmd({
    name: '强制删除路径',
    command: 'rm -rf {{path}}',
    description: '危险：先确认变量中的路径再执行',
    group: '设备维护',
    icon: 'Trash2',
    confirmRequired: true,
    variables: [
      { name: 'path', label: '要删除的路径', type: 'text', required: true, placeholder: '/tmp/xxx' }
    ]
  }),
  cmd({
    name: '重启网络服务',
    command: 'systemctl restart networking 2>/dev/null || /etc/init.d/network restart',
    description: '刷新网络配置，可能短暂断连',
    group: '设备维护',
    icon: 'Network',
    confirmRequired: true,
    variables: []
  }),
  cmd({
    name: '重启 SSH 服务',
    command: 'systemctl restart sshd 2>/dev/null || /etc/init.d/sshd restart',
    description: '注意：会立即断开当前连接',
    group: '设备维护',
    icon: 'ServerCog',
    confirmRequired: true,
    variables: []
  })
]

/** 生成首次运行使用的内置命令（id / 时间戳在此生成） */
export function buildSeedCommands(): Command[] {
  const now = Date.now()
  return SEED.map((item, index) => ({
    ...item,
    id: randomUUID(),
    sortOrder: index,
    useCount: 0,
    createdAt: now,
    updatedAt: now
  }))
}
