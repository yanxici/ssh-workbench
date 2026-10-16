/**
 * MAC 厂商识别（OUI 前缀表）—— 主进程与渲染层共用。
 * 覆盖常见的嵌入式/工业设备厂商；命中不了就显示原始 MAC。
 */

const OUI_VENDORS: Array<[string, string]> = [
  ['00:0c:29', 'VMware 虚拟机'],
  ['00:1c:42', 'Parallels 虚拟机'],
  ['b8:27:eb', '树莓派'],
  ['dc:a6:32', '树莓派'],
  ['e4:5f:01', '树莓派'],
  ['24:0a:c4', '乐鑫 ESP32'],
  ['30:ae:a4', '乐鑫 ESP32'],
  ['84:cc:a8', '乐鑫 ESP32'],
  ['7c:df:a1', '乐鑫 ESP32'],
  ['94:b9:7e', '乐鑫 ESP32'],
  ['48:3f:da', '乐鑫 ESP32'],
  ['50:02:91', '乐鑫 ESP32'],
  ['c8:c9:a3', '乐鑫 ESP32'],
  ['d8:a0:1d', '乐鑫 ESP32'],
  ['00:1e:c0', 'Microchip'],
  ['00:04:a3', 'Microchip'],
  ['00:80:e1', 'STMicro'],
  ['00:0e:3a', '工业设备'],
  ['b0:c5:3c', '工业设备'],
  ['00:04:4b', '工控屏/串口屏'],
  ['00:1a:2b', '合宙/AirM2M'],
  ['a4:cf:12', '合宙/AirM2M'],
  ['f0:9e:9e', '华为'],
  ['00:e0:fc', '华为'],
  ['00:1e:10', '华三 H3C'],
  ['e0:3f:49', '华三 H3C']
]

export function guessVendor(mac: string): string | undefined {
  const prefix = mac.slice(0, 8).toLowerCase()
  return OUI_VENDORS.find(([oui]) => oui === prefix)?.[1]
}
