import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
    writeFileSync(join(directory, 'session.jsonl'), [
      { type: 'session', version: 0, id: runtimeThreadId, createdAt: 1_000, cwd: 'D:\\workspace' },
      { type: 'turn/start', time: 1_100, data: { turn: 1 } },
      { type: 'step/start', time: 1_110, data: { turn: 1, step: 1 } },
      { type: 'user/message', time: 1_120, data: { content: [{ type: 'text', text: '问题一' }], source: { kind: 'user' } } },
      { type: 'user/message', time: 1_125, data: { content: [{ type: 'text', text: '通用背景内容' }], source: { kind: 'plugin', plugin: 'eleckoi-conversation-context', label: '缓存区', sections: [{ name: '缓存设定 · 通用背景' }] } } },
      { type: 'assistant/message', time: 1_130, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '回答一' }] } } },
      { type: 'turn/start', time: 2_100, data: { turn: 2 } },
      { type: 'step/start', time: 2_110, data: { turn: 2, step: 1 } },
      { type: 'user/message', time: 2_120, data: { content: [{ type: 'text', text: '问题二' }], source: { kind: 'user' } } },
      { type: 'assistant/message', time: 2_130, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '回答二' }] } } }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')
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
