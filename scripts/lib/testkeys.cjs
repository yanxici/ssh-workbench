'use strict'

/**
 * 生成一把 ssh2 真能解析的 ed25519 主机私钥。
 *
 * 为什么不能直接 utils.generateKeyPairSync('ed25519').private：
 * ssh2 自己那套 PKCS8→OpenSSH 转换有概率写坏（实测约 1/400），产出的私钥
 * 喂回 utils.parseKey 会得到 "Malformed OpenSSH private key"。测试里拿它当
 * 主机密钥，表现为某个毫不相关的 verify 脚本随机崩在 new Server(...)，
 * 排查半天发现跟被测代码一点关系没有。
 * 生成后立刻自检，坏了就重来 —— 比在四个脚本里各写一遍靠谱。
 */
const { utils } = require('ssh2')

function ed25519HostKey() {
  for (let i = 0; i < 10; i++) {
    const { private: priv } = utils.generateKeyPairSync('ed25519')
    if (!(utils.parseKey(priv) instanceof Error)) return priv
  }
  throw new Error('连续 10 次都生成了无法解析的 ed25519 私钥，ssh2 的 keygen 出问题了')
}

module.exports = { ed25519HostKey }
