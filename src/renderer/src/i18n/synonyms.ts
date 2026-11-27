/**
 * 中英同义扩展词表（供命令搜索使用）。
 * 从 lib/commandSearch.ts 迁入 i18n 目录统一维护，verify-i18n 跳过本目录。
 */
export const SYNONYMS: Array<{ zh: string[]; en: string[] }> = [
  { zh: ['磁盘', '硬盘', '空间'], en: ['disk', 'df', 'partition', 'storage'] },
  { zh: ['挂载', '挂载点'], en: ['mount', 'fstab'] },
  { zh: ['内存'], en: ['mem', 'memory', 'free', 'ram'] },
  { zh: ['进程'], en: ['process', 'proc', 'pid'] },
  { zh: ['负载', '压力'], en: ['load', 'loadavg', 'uptime'] },
  { zh: ['网络', '网卡', '网口'], en: ['network', 'iface', 'interface', 'nic'] },
  { zh: ['端口', '监听'], en: ['port', 'listen', 'netstat'] },
  { zh: ['连通', '探测', '延迟'], en: ['ping', 'latency', 'probe'] },
  { zh: ['日志', '报错'], en: ['log', 'journal', 'dmesg', 'syslog'] },
  { zh: ['温度', '散热'], en: ['temp', 'thermal', 'sensor'] },
  { zh: ['电源', '电压'], en: ['power', 'voltage', 'supply'] },
  { zh: ['串口'], en: ['tty', 'serial', 'usb'] },
  { zh: ['系统', '版本', '内核'], en: ['system', 'version', 'kernel', 'uname', 'release'] },
  { zh: ['服务', '重启'], en: ['service', 'systemctl', 'restart'] },
  { zh: ['文件', '目录'], en: ['file', 'dir', 'find'] },
  { zh: ['权限', '所有者'], en: ['chmod', 'chown'] },
  { zh: ['用户', '账号'], en: ['user', 'passwd', 'account'] },
  { zh: ['定时', '计划', '任务'], en: ['cron', 'timer', 'schedule'] },
  { zh: ['防火墙'], en: ['firewall', 'iptables'] },
  { zh: ['容器'], en: ['docker', 'container'] },
  { zh: ['固件', '升级'], en: ['firmware', 'flash', 'upgrade'] },
  { zh: ['备份'], en: ['backup'] }
]
