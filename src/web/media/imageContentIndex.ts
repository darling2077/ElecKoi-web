/**
 * 卡片图片的**内容去重索引**（跨租户共享）。
 *
 * 为什么需要：多租户下每个人各导各的卡，同一张卡被两个人导入就会往图床传两份；
 * 实测确认 Zipline 不按内容去重（同文件传两次得到两个 URL、存储翻倍）。
 * 加上这个索引后，第二个人导入同一张卡时直接复用已在图床上的地址，省一次上传与一份存储。
 *
 * 设计取舍：
 *   - **进程内共享、落盘在数据根**：WebUI 是单进程，一个 JSON 文件足够；
 *     写入用「临时文件 + rename」保证原子性，写失败就退化成进程内去重（不影响功能）。
 *   - **复用前先探活**：命中索引后发一个 HEAD，只有确认还在才复用——
 *     否则用户在图床后台删了图，卡片就会指向 404。
 *     探活失败（网络抖动/非 404）时**重新上传**：多一份存储是小事，卡片裂图是大事。
 *   - **按目标隔离**：索引键带上对外地址前缀，换图床后不会把旧图床的地址套上来。
 */

export interface ImageContentIndex {
  /** 命中则返回已存在的对外地址。 */
  lookup(key: string): string | undefined
  remember(key: string, url: string): void
  forget(key: string): void
  /** 落盘（自动合并短时间内的多次写入）。 */
  flush(): Promise<void>
  readonly size: number
}

import { existsSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'

interface StoredIndex {
  version: 1
  entries: Record<string, string>
}

export function createImageContentIndex(options: {
  path: string | undefined
  log?: (message: string) => void
}): ImageContentIndex {
  const log = options.log ?? ((): void => undefined)
  let entries: Record<string, string> = {}
  let loaded = false
  let writable = options.path !== undefined
  let writeChain: Promise<void> = Promise.resolve()
  let dirty = false

  const load = (): void => {
    if (loaded) return
    loaded = true
    if (options.path === undefined || !existsSync(options.path)) return
    try {
      const parsed = JSON.parse(readFileSync(options.path, 'utf8')) as StoredIndex
      if (parsed.version === 1 && typeof parsed.entries === 'object' && parsed.entries !== null) {
        entries = parsed.entries
      }
    } catch (error) {
      // 索引坏了不该影响导入：丢掉它，重新积累。
      log(`  图片去重索引读取失败，将重建：${error instanceof Error ? error.message : String(error)}`)
      entries = {}
    }
  }

  return {
    get size() {
      load()
      return Object.keys(entries).length
    },
    lookup(key) {
      load()
      return entries[key]
    },
    remember(key, url) {
      load()
      if (entries[key] === url) return
      entries[key] = url
      dirty = true
    },
    forget(key) {
      load()
      if (entries[key] === undefined) return
      delete entries[key]
      dirty = true
    },
    async flush() {
      load()
      if (options.path === undefined || !writable || !dirty) return
      const path = options.path
      const snapshot = JSON.stringify({ version: 1, entries } satisfies StoredIndex)
      dirty = false
      // 串行化写入，避免并发互相覆盖；原子替换避免半截文件。
      writeChain = writeChain.then(async () => {
        try {
          const temporary = `${path}.tmp`
          await writeFile(temporary, snapshot, 'utf8')
          await rename(temporary, path)
        } catch (error) {
          writable = false
          log(`  图片去重索引落盘失败（本次仅进程内去重）：${error instanceof Error ? error.message : String(error)}`)
        }
      })
      await writeChain
    }
  }
}
