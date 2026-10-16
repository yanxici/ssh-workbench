import type { DiagSection } from '@shared/types'

/**
 * 内置诊断巡检项（嵌入式 Linux / BusyBox 友好）。
 *
 * 编写约定：
 * - 每条命令尽量用 `a || b` 做降级（不同发行版/BusyBox 命令集差异大）；
 * - 结尾追加 echo 保证退出码为 0（命令缺失不算失败，输出里能看到原因）；
 * - 输出只走 stdout/stderr，不需要解析 —— 报告按原文呈现，便于人工研判与研发追溯。
 */

interface BuiltinSeed {
  id: string
  name: string
  group: string
  command: string
  timeoutMs?: number
  description?: string
}

const SEEDS: BuiltinSeed[] = [
  /* ---------------- 系统 ---------------- */
  {
    id: 'sys.info',
    name: '系统信息',
    group: '系统',
    command:
      "uname -a; echo '--- os-release ---'; cat /etc/os-release 2>/dev/null || cat /etc/issue 2>/dev/null; echo '---'; hostname; echo '---'; date",
    description: '内核版本、发行版标识、主机名、当前时间'
  },
  {
    id: 'sys.uptime',
    name: '运行时长与负载',
    group: '系统',
    command: "uptime; echo '--- loadavg ---'; cat /proc/loadavg; echo '---'; cat /proc/uptime",
    description: '开机时长与 1/5/15 分钟平均负载'
  },
  {
    id: 'sys.timezone',
    name: '时钟与时区',
    group: '系统',
    command:
      "date '+%Y-%m-%d %H:%M:%S %Z (%z)'; echo '---'; cat /etc/timezone 2>/dev/null; ls -l /etc/localtime 2>/dev/null; echo '--- ntp ---'; (ntpq -p 2>/dev/null || chronyc sources 2>/dev/null || echo '无 ntp 客户端') | head -8",
    description: '设备时钟是否漂移、时区与 NTP 同步状态'
  },

  /* ---------------- CPU ---------------- */
  {
    id: 'cpu.info',
    name: 'CPU 信息',
    group: 'CPU',
    command:
      "cat /proc/cpuinfo | head -60; echo '--- cores ---'; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo",
    description: '处理器型号、核心数、特性'
  },
  {
    id: 'cpu.top',
    name: 'CPU 占用 Top',
    group: 'CPU',
    command: 'top -b -n 1 2>/dev/null | head -22 || busybox top -b -n 1 2>/dev/null | head -22',
    description: '瞬时 CPU 占用最高的进程'
  },
  {
    id: 'cpu.freq',
    name: 'CPU 频率与调频',
    group: 'CPU',
    command:
      "for f in /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_cur_freq; do [ -f \"$f\" ] && echo \"$f = $(cat $f)\"; done; echo '--- governor ---'; cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null; echo '(以上为空表示不支持)'",
    description: '当前频率与调频策略（工控设备常被锁频）'
  },

  /* ---------------- 内存 ---------------- */
  {
    id: 'mem.usage',
    name: '内存使用',
    group: '内存',
    command: "free -m 2>/dev/null || cat /proc/meminfo | head -20",
    description: '总内存/可用/缓存（-m 单位 MB，无 free 则回退 /proc/meminfo）'
  },
  {
    id: 'mem.detail',
    name: '内存详情',
    group: '内存',
    command:
      "cat /proc/meminfo; echo '--- slab top ---'; (slabtop -o 2>/dev/null | head -15 || echo '无 slabtop')",
    description: '完整 meminfo 与内核 slab 占用（排查内核内存泄漏）'
  },
  {
    id: 'mem.oom',
    name: 'OOM / 内存告警记录',
    group: '内存',
    command:
      "dmesg 2>/dev/null | grep -iE 'out of memory|oom-kill|oom_reaper|killed process' | tail -20; echo '(无输出代表未发现)'",
    description: '历史 OOM 事件（进程被杀多源于此）'
  },

  /* ---------------- 存储 ---------------- */
  {
    id: 'disk.usage',
    name: '磁盘使用',
    group: '存储',
    command: 'df -h',
    description: '各分区容量与使用率'
  },
  {
    id: 'disk.inode',
    name: 'Inode 使用',
    group: '存储',
    command: 'df -i 2>/dev/null || echo "不支持 df -i"',
    description: 'inode 耗尽会导致"磁盘没满却写不进去"'
  },
  {
    id: 'disk.mount',
    name: '挂载信息',
    group: '存储',
    command: "mount | head -40; echo '--- fstab ---'; cat /etc/fstab 2>/dev/null",
    description: '当前挂载表与开机挂载配置'
  },
  {
    id: 'disk.block',
    name: '块设备',
    group: '存储',
    command: 'lsblk 2>/dev/null || cat /proc/partitions',
    description: '磁盘/分区/loop 设备清单'
  },
  {
    id: 'disk.ro',
    name: '只读挂载检查',
    group: '存储',
    command:
      "mount | grep -E 'ro[,\\)]' ; echo '--- 分区错误 ---'; dmesg 2>/dev/null | grep -iE 'ext4-fs error|i/o error|read-only|remount' | tail -15; echo '(无输出代表未发现)'",
    description: '文件系统被切只读（多为存储故障前置信号）'
  },

  /* ---------------- 网络 ---------------- */
  {
    id: 'net.ifaces',
    name: '网络接口',
    group: '网络',
    command:
      "ip addr 2>/dev/null || ifconfig -a 2>/dev/null; echo '--- 链路状态 ---'; for i in /sys/class/net/*/operstate; do echo \"$(basename $(dirname $i)): $(cat $i)\"; done",
    description: 'IP 配置与物理链路 up/down'
  },
  {
    id: 'net.route',
    name: '路由表',
    group: '网络',
    command: "ip route 2>/dev/null || route -n 2>/dev/null",
    description: '默认网关与路由条目'
  },
  {
    id: 'net.listen',
    name: '监听端口',
    group: '网络',
    command:
      "netstat -tlnp 2>/dev/null || ss -tlnp 2>/dev/null || netstat -tln 2>/dev/null",
    description: '设备对外提供的服务'
  },
  {
    id: 'net.conns',
    name: '活动连接',
    group: '网络',
    command:
      "netstat -tn 2>/dev/null | head -30 || ss -tn 2>/dev/null | head -30; echo '--- 统计 ---'; netstat -s 2>/dev/null | grep -iE 'retrans|error|drop' | head -12; echo '(无输出代表未发现)'",
    description: 'TCP 连接与重传/错误计数'
  },
  {
    id: 'net.arp',
    name: 'ARP 表',
    group: '网络',
    command: 'arp -a 2>/dev/null || ip neigh 2>/dev/null',
    description: '同网段邻居设备'
  },

  /* ---------------- 进程 ---------------- */
  {
    id: 'proc.list',
    name: '进程列表',
    group: '进程',
    command: 'ps aux 2>/dev/null | head -45 || ps -ef | head -45',
    description: '当前进程快照'
  },
  {
    id: 'proc.dstate',
    name: 'D 状态（不可中断）进程',
    group: '进程',
    command:
      "ps aux 2>/dev/null | awk '$8 ~ /^D/ {print}' | head -10; echo '--- count ---'; ps aux 2>/dev/null | awk '$8 ~ /^D/' | wc -l",
    description: '卡在 IO 的进程（存储/驱动问题的重要线索）'
  },
  {
    id: 'proc.zombie',
    name: '僵尸进程',
    group: '进程',
    command:
      "ps aux 2>/dev/null | awk '$8 ~ /^Z/ {print}' | head -10; echo '--- count ---'; ps aux 2>/dev/null | awk '$8 ~ /^Z/' | wc -l",
    description: '未回收的子进程'
  },

  /* ---------------- 内核日志 ---------------- */
  {
    id: 'klog.dmesg',
    name: '内核日志（尾部）',
    group: '内核日志',
    command: 'dmesg 2>/dev/null | tail -80 || echo "dmesg 不可读（权限）"',
    description: '最近的内核消息'
  },
  {
    id: 'klog.errors',
    name: '内核错误扫描',
    group: '内核日志',
    command:
      "dmesg 2>/dev/null | grep -iE 'error|fail|oops|panic|segfault|bug:|call trace|timeout' | tail -50; echo '(无输出代表未发现)'",
    description: 'error/fail/oops/panic/segfault 等关键字扫描'
  },
  {
    id: 'klog.messages',
    name: '系统日志（messages）',
    group: '内核日志',
    command:
      "tail -80 /var/log/messages 2>/dev/null || tail -80 /var/log/syslog 2>/dev/null || echo '日志文件不可读或无 syslog'",
    description: '用户态系统日志尾部'
  },

  /* ---------------- 硬件 ---------------- */
  {
    id: 'hw.temp',
    name: '温度传感器',
    group: '硬件',
    command:
      "for z in /sys/class/thermal/thermal_zone*; do [ -d \"$z\" ] && echo \"$(cat $z/type 2>/dev/null): $(cat $z/temp 2>/dev/null)\"; done; echo '--- sensors ---'; sensors 2>/dev/null | head -30 || echo '无 lm-sensors'",
    description: '温区读数（毫摄氏度）与传感器'
  },
  {
    id: 'hw.gpio',
    name: 'GPIO 状态',
    group: '硬件',
    command:
      "ls /sys/class/gpio 2>/dev/null; echo '--- gpio values ---'; for g in /sys/class/gpio/gpio*/; do [ -f \"$g/direction\" ] && echo \"$(basename $g): dir=$(cat $g/direction 2>/dev/null) val=$(cat $g/value 2>/dev/null)\"; done; echo '(无输出代表未导出 GPIO)'",
    description: '已导出 GPIO 的方向与电平'
  },
  {
    id: 'hw.usb',
    name: 'USB / PCI 设备',
    group: '硬件',
    command:
      "lsusb 2>/dev/null || ls /sys/bus/usb/devices 2>/dev/null; echo '--- pci ---'; lspci 2>/dev/null | head -20 || ls /sys/bus/pci/devices 2>/dev/null | head -20",
    description: '外设枚举情况'
  },
  {
    id: 'hw.modules',
    name: '内核模块',
    group: '硬件',
    command: 'lsmod 2>/dev/null | head -40 || cat /proc/modules | head -40',
    description: '已加载驱动模块'
  },

  /* ---------------- 固件 ---------------- */
  {
    id: 'fw.version',
    name: '固件版本',
    group: '固件',
    command:
      "cat /etc/version 2>/dev/null; cat /etc/fw_version 2>/dev/null; cat /etc/sw_version 2>/dev/null; echo '---'; cat /proc/version; echo '--- image ---'; ls -l /boot 2>/dev/null | head -15",
    description: '常见版本文件与内核构建标识'
  },
  {
    id: 'fw.machine',
    name: '设备型号与序列号',
    group: '固件',
    command:
      "cat /proc/device-tree/model 2>/dev/null; echo; cat /sys/firmware/devicetree/base/model 2>/dev/null; echo; cat /etc/serialno 2>/dev/null; cat /etc/sn 2>/dev/null; cat /sys/class/dmi/id/product_name 2>/dev/null; cat /sys/class/dmi/id/product_serial 2>/dev/null; echo '(以上为空表示不支持)'",
    description: '设备树型号 / 序列号（DT 与 DMI 两路探测）'
  }
]

export const BUILTIN_DIAG_SECTIONS: DiagSection[] = SEEDS.map((s) => ({
  id: s.id,
  name: s.name,
  group: s.group,
  command: s.command,
  timeoutMs: s.timeoutMs ?? 12000,
  description: s.description,
  builtin: true
}))

/** 内置分组顺序（UI 按此排序展示） */
export const DIAG_GROUP_ORDER = [
  '系统',
  'CPU',
  '内存',
  '存储',
  '网络',
  '进程',
  '内核日志',
  '硬件',
  '固件'
]
