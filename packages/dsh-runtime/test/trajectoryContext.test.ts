import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { agentTrajectorySnapshotSchema } from '../../../src/shared/contracts/agent/trajectory'
import { readDshTrajectory } from '../src/trajectory'
import {
  appendTrajectoryContextActivation,
  readTrajectoryContextActivations
} from '../src/trajectoryContext'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const child = relative(tmpdir(), directory)
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Unexpected test cleanup path')
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('trajectory context ledger', () => {
  it('stores one definition and projects it for every activated turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'eleckoi-trajectory-context-'))
    temporaryDirectories.push(root)
    const runtimeThreadId = 'thread-context'
    const sessionLogRoot = join(root, 'sessions')
    const conversationStateRoot = join(sessionLogRoot, 'conversation-a')
    const directory = join(sessionLogRoot, 'project-context', runtimeThreadId)
    mkdirSync(directory, { recursive: true })
    const events = [
      trajectoryEvent(0, 'turn/start', 1_100, { turn: 1 }),
      trajectoryEvent(1, 'step/start', 1_110, { turn: 1, step: 1 }),
      trajectoryEvent(2, 'user/message', 1_120, { content: [{ type: 'text', text: '问题一' }], source: { kind: 'user' } }, 'append'),
      trajectoryEvent(3, 'user/message', 1_125, { content: [{ type: 'text', text: '通用背景内容' }], source: { kind: 'plugin', plugin: 'eleckoi-conversation-context', label: '缓存区', sections: [{ name: '缓存设定 · 通用背景' }] } }, 'append'),
      trajectoryEvent(4, 'assistant/message', 1_130, { turn: 1, step: 1, message: { content: [{ type: 'text', text: '回答一' }] } }, 'append'),
      trajectoryEvent(5, 'turn/start', 2_100, { turn: 2 }),
      trajectoryEvent(6, 'step/start', 2_110, { turn: 2, step: 1 }),
      trajectoryEvent(7, 'user/message', 2_120, { content: [{ type: 'text', text: '问题二' }], source: { kind: 'user' } }, 'append'),
      trajectoryEvent(8, 'assistant/message', 2_130, { turn: 2, step: 1, message: { content: [{ type: 'text', text: '回答二' }] } }, 'append')
    ]
    const rows = [
      sessionFormatCatalog.encodeCurrentHeader({
        version: sessionFormatCatalog.currentVersion,
        id: runtimeThreadId,
        createdAt: 1_000,
        cwd: 'D:\\workspace',
        isSeeded: false,
        delegationDepth: 0
      }, 0),
      ...events.map((event) => sessionFormatCatalog.encodeCurrentEvent(event))
    ]
    writeFileSync(
      join(directory, `session.v${sessionFormatCatalog.currentVersion}.jsonl`),
      rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
    )
    const entries = [{
      key: 'definition-a', id: 'setting-a', title: '缓存设定 · 通用背景', source: '缓存区',
      anchor: 'insert_point_1', role: 'user' as const, content: '通用背景内容'
    }]
    appendTrajectoryContextActivation(conversationStateRoot, runtimeThreadId, { turn: 1, time: 1_115, entries })
    appendTrajectoryContextActivation(conversationStateRoot, runtimeThreadId, { turn: 2, time: 2_115, entries })

    expect(readTrajectoryContextActivations(conversationStateRoot, runtimeThreadId)).toEqual([
      { turn: 1, time: 1_115, entries },
      { turn: 2, time: 2_115, entries }
    ])
    const page = readDshTrajectory(sessionLogRoot, runtimeThreadId, { limit: 20 }, [], conversationStateRoot)
    const contextRecords = page.records.filter((record) => record.kind === 'context')
    expect(contextRecords).toHaveLength(2)
    expect(contextRecords).toMatchObject([
      { turn: 1, title: '缓存设定 · 通用背景', input: '通用背景内容' },
      { turn: 2, title: '缓存设定 · 通用背景', input: '通用背景内容' }
    ])
    expect(() => agentTrajectorySnapshotSchema.parse({ conversationId: 'conversation-a', ...page })).not.toThrow()
  })
})

function trajectoryEvent(
  seq: number,
  type: string,
  time: number,
  data: SessionFormatJsonObject,
  surfaceOp?: 'append'
): SessionFormatEvent {
  return { seq, type, time, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) }
}
