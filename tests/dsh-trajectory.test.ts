import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { projectDshTrajectory, readDshTrajectory } from '@eleckoi/dsh-runtime'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const child = relative(tmpdir(), directory)
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Unexpected test cleanup path')
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('DSH trajectory projection', () => {
  it('keeps the raw event ledger separate while pairing calls with their results', () => {
    const result = projectDshTrajectory([
      event(0, 'turn/start', { turn: 1 }, 1_000),
      event(1, 'step/start', { turn: 1, step: 1 }, 1_010),
      event(2, 'user/message', {
        content: [{ type: 'text', text: '你好' }],
        source: { kind: 'user' },
        role: 'user'
      }, 1_020),
      event(3, 'user/message', {
        content: [{ type: 'text', text: '工作区说明' }],
        source: { kind: 'agent-instructions' },
        role: 'user'
      }, 1_030),
      event(4, 'request/header', {
        header: { system: '系统提示词', config: { provider: 'deepseek-official', model: 'deepseek-chat' } },
        reason: 'initial'
      }, 1_040),
      event(5, 'assistant/message', {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '我来查看' }] },
        usage: { inputTokens: 120, outputTokens: 8 }
      }, 1_200),
      event(6, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-a',
        name: 'read',
        arguments: '{"path":"README.md"}'
      }, 1_220),
      event(7, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'call-a' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call-a',
            content: [{ type: 'text', text: '文件内容' }],
            isError: false
          }]
        }
      }, 1_270)
    ], { createdAt: 990 })

    expect(result.records.map((record) => record.kind)).toEqual([
      'user', 'context', 'assistant', 'tool'
    ])
    expect(result.records.map((record) => record.index)).toEqual([1, 2, 3, 4])
    expect(result.records[1]).toMatchObject({ title: 'Agent 指令', source: 'agent-instructions' })
    expect(result.records[2]).toMatchObject({
      durationMillis: 190,
      output: '我来查看',
      requests: [{ number: 1, seq: 1, provider: 'deepseek-official', model: 'deepseek-chat' }]
    })
    expect(result.records[3]).toMatchObject({
      title: 'read',
      input: '{\n  "path": "README.md"\n}',
      output: '文件内容',
      durationMillis: 50,
      status: 'complete'
    })
    expect(JSON.parse(result.records[3]?.rawJson ?? '[]')).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain('系统提示词')
    expect(result).toMatchObject({ startedAtMillis: 990, completedAtMillis: 1_270 })
  })

  it('reads the durable JSONL log, ignores a partial live tail and pages backwards', () => {
    const root = mkdtempSync(join(tmpdir(), 'eleckoi-trajectory-'))
    temporaryDirectories.push(root)
    const runtimeThreadId = 'thread-a'
    const directory = join(root, 'project-a', runtimeThreadId)
    mkdirSync(directory, { recursive: true })
    const rows = currentSessionRows(runtimeThreadId, 1_000, [
      event(0, 'turn/start', { turn: 1 }, 1_010),
      event(1, 'step/start', { turn: 1, step: 1 }, 1_020),
      event(2, 'request/header', {
        header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } },
        reason: 'initial'
      }, 1_030),
      event(3, 'user/message', { content: [{ type: 'text', text: '问题' }], source: { kind: 'user' } }, 1_040, 'append'),
      event(4, 'tool/call', { turn: 1, step: 1, callId: 'call-a', name: 'read', arguments: '{}' }, 1_050),
      event(5, 'tool/result', { turn: 1, step: 1, message: { source: { callId: 'call-a' }, content: [] } }, 1_060, 'append'),
      event(6, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '回答' }] } }, 1_070, 'append')
    ])
    writeFileSync(
      join(directory, `session.v${sessionFormatCatalog.currentVersion}.jsonl`),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n{"partial":`
    )

    const latest = readDshTrajectory(root, runtimeThreadId, { limit: 2 })
    expect(latest.records.map((record) => record.kind)).toEqual(['tool', 'assistant'])
    expect(latest).toMatchObject({ totalRecords: 3, hasMore: true, beforeIndex: 2 })

    const older = readDshTrajectory(root, runtimeThreadId, { beforeIndex: latest.beforeIndex ?? undefined, limit: 2 })
    expect(older.records.map((record) => record.kind)).toEqual(['user'])
    expect(older).toMatchObject({ totalRecords: 3, hasMore: false, beforeIndex: 1 })
  })

  it('numbers every model request while omitting DSH internal system prompts', () => {
    const result = projectDshTrajectory([
      event(0, 'turn/start', { turn: 1 }, 1_000),
      event(1, 'step/start', { turn: 1, step: 1 }, 1_010),
      event(2, 'request/header', {
        header: { system: '系统提示词', tools: [], config: { model: 'deepseek-chat' } },
        reason: 'initial'
      }, 1_020),
      event(3, 'assistant/message', {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '第一次' }] }
      }, 1_030),
      event(4, 'step/start', { turn: 1, step: 2 }, 1_040),
      event(5, 'request/header', {
        header: { system: '系统提示词', tools: [], config: { model: 'deepseek-chat' } },
        reason: 'continue'
      }, 1_050),
      event(6, 'assistant/message', {
        turn: 1,
        step: 2,
        message: { content: [{ type: 'text', text: '第二次' }] }
      }, 1_060)
    ])

    expect(result.records.map((record) => record.kind)).toEqual(['assistant', 'assistant'])
    expect(result.records.flatMap((record) => record.requests.map((request) => request.number))).toEqual([1, 2])
    expect(JSON.stringify(result)).not.toContain('系统提示词')
  })

})

function event(
  seq: number,
  type: string,
  data: SessionFormatJsonObject,
  time: number,
  surfaceOp?: 'append'
): SessionFormatEvent {
  return { seq, type, data, time, ...(surfaceOp === undefined ? {} : { surfaceOp }) }
}

function currentSessionRows(
  id: string,
  createdAt: number,
  events: ReturnType<typeof event>[]
): unknown[] {
  const header = {
    version: sessionFormatCatalog.currentVersion,
    id,
    createdAt,
    cwd: 'D:\\workspace',
    isSeeded: false,
    delegationDepth: 0
  }
  return [
    sessionFormatCatalog.encodeCurrentHeader(header, 0),
    ...events.map((item) => sessionFormatCatalog.encodeCurrentEvent(item))
  ]
}
