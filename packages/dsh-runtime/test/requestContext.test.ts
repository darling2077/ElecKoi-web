import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discardRequestContexts,
  readRequestContextSnapshots,
  requestContextPath
} from '../src/requestContext'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('request context snapshots', () => {
  it('keeps the latest valid snapshot for one request sequence', () => {
    const root = mkdtempSync(join(tmpdir(), 'eleckoi-request-context-'))
    temporaryDirectories.push(root)
    const file = requestContextPath(root, 'thread-a')
    mkdirSync(join(root, 'eleckoi-request-context'), { recursive: true })
    writeFileSync(file, [
      JSON.stringify(definition('old', '旧内容')),
      JSON.stringify(request(4, 'old')),
      '{"partial":',
      JSON.stringify(definition('current', '实际发送内容')),
      JSON.stringify(request(4, 'current')),
      JSON.stringify(definition('next', '下一次请求')),
      JSON.stringify(request(8, 'next')),
      ''
    ].join('\n'))

    expect(readRequestContextSnapshots(root, 'thread-a')).toEqual([
      expect.objectContaining({ requestSeq: 4, items: [expect.objectContaining({ content: '实际发送内容' })] }),
      expect.objectContaining({ requestSeq: 8, items: [expect.objectContaining({ content: '下一次请求' })] })
    ])
  })

  it('removes discarded thread snapshots and preserves the selected thread', () => {
    const root = mkdtempSync(join(tmpdir(), 'eleckoi-request-context-'))
    temporaryDirectories.push(root)
    for (const threadId of ['thread-a', 'thread-b']) {
      const file = requestContextPath(root, threadId)
      mkdirSync(join(root, 'eleckoi-request-context'), { recursive: true })
      writeFileSync(file, `${JSON.stringify(snapshot(1, threadId))}\n`)
    }

    discardRequestContexts(root, ['thread-a', 'thread-b'], 'thread-b')

    expect(existsSync(requestContextPath(root, 'thread-a'))).toBe(false)
    expect(existsSync(requestContextPath(root, 'thread-b'))).toBe(true)
  })
})

function snapshot(requestSeq: number, content: string) {
  return {
    requestSeq,
    turn: 1,
    step: 1,
    timeMillis: 100,
    items: [{
      order: 1,
      messageId: 'message-1',
      role: 'user',
      kind: 'user',
      title: '用户最新输入',
      source: '本轮输入',
      anchor: '',
      content
    }]
  }
}

function definition(key: string, content: string) {
  return {
    type: 'definition',
    key,
    messageId: `message-${key}`,
    role: 'user',
    kind: 'user',
    title: '用户最新输入',
    source: '本轮输入',
    anchor: '',
    content
  }
}

function request(requestSeq: number, key: string) {
  return {
    type: 'request',
    requestSeq,
    turn: 1,
    step: 1,
    timeMillis: 100,
    items: [{ order: 1, key }]
  }
}
