/**
 * Web 端凭据加密，替代 Electron safeStorage。
 *
 * 设计要点：
 *  - AES-256-GCM；密文格式 `web-aes-v1:<keyVersion>:<iv>:<tag>:<ciphertext>`（base64url）。
 *  - 每租户派生独立数据密钥：HKDF-SHA256(masterKey, salt=tenantId)。
 *    单一租户密钥泄露不影响其他租户；轮换只影响 masterKey 版本。
 *  - 前缀刻意与上游 `desktop-safe-v1:` 不同：桌面端与 Web 端数据互不误读。
 *  - masterKey 只来自环境变量 / Docker secret，绝不入镜像、不入库。
 *
 * 解密失败**不抛异常，返回空串**（见 decrypt 的说明）。这不是"吞掉错误"，
 * 而是把一次事故的爆炸半径从"整个功能不可用"压到"这一条需要重填"。
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const PREFIX = 'web-aes-v1'
const KEY_VERSION = '1'
const KEY_BYTES = 32
const IV_BYTES = 12

export class WebCredentialCipher {
  private readonly masterKey: Buffer

  constructor(
    masterKeyBase64: string,
    private readonly tenantId: string,
    /** 解密失败时的告警出口；默认打到 stderr。 */
    private readonly warn: (message: string) => void = (message) => console.warn(message)
  ) {
    const key = Buffer.from(masterKeyBase64, 'base64')
    if (key.length !== KEY_BYTES) {
      throw new Error(`ELECKOI_MASTER_KEY 必须是 ${KEY_BYTES} 字节的 base64（当前 ${key.length} 字节）。`)
    }
    this.masterKey = key
  }

  private dataKey(): Buffer {
    return Buffer.from(hkdfSync('sha256', this.masterKey, Buffer.from(this.tenantId, 'utf8'), Buffer.from('eleckoi-credentials', 'utf8'), KEY_BYTES))
  }

  encrypt(value: string): string {
    if (!value) return ''
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.dataKey(), iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [PREFIX, KEY_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':')
  }

  /**
   * 解不开就返回空串，而不是抛错。
   *
   * 为什么必须这样：上游 `ModelRepository.list()` 是**逐行**解密的
   * （`ModelRepository.ts` 第 18 行），单条解不开会让整个列表查询抛错——
   * 表现就是"所有 API 供应商凭空消失"；而 `save()`（第 30 行）又会拿旧密文
   * 比对，于是"重新添加"同样报错，用户被彻底锁在外面。
   *
   * 主密钥一旦被换过（历史上确实发生过），这条数据是**救不回来**的，
   * 抛错只会把可修复的"一个字段要重填"升级成"功能不可用"。
   * 所以这里只告警 + 返回空串，让界面照常列出配置、让用户重填这一个 Key。
   */
  decrypt(value: string): string {
    if (!value) return ''
    const parts = value.split(':')
    const reason = parts[0] !== PREFIX
      ? '凭据不是 Web 端写入的格式（可能是桌面端数据）'
      : parts.length !== 5
        ? '凭据格式损坏'
        : parts[1] !== KEY_VERSION
          ? `凭据密钥版本 ${parts[1]} 不受支持`
          : undefined
    if (reason !== undefined) {
      this.warn(`[web] ${reason}（租户 ${this.tenantId}）：已按空值处理，请重新填写 API Key。`)
      return ''
    }
    try {
      const [, , ivPart, tagPart, dataPart] = parts as [string, string, string, string, string]
      const decipher = createDecipheriv('aes-256-gcm', this.dataKey(), Buffer.from(ivPart, 'base64url'))
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      this.warn(`[web] 凭据解密失败（主密钥可能已更换，租户 ${this.tenantId}）：已按空值处理，请重新填写 API Key。`)
      return ''
    }
  }
}
