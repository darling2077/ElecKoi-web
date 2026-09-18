import { describe, expect, it } from 'vitest'
import {
  DshGenerationStatsProjector,
  emptyStoredGenerationStats,
  parseStoredGenerationStats
} from '@eleckoi/dsh-runtime'

function sessionEvent(seq: number, type: string, data: Record<string, unknown>, time: number, surfaceOp?: unknown) {
  return {
    method: 'session.event',
    params: {
      sessionId: 'session-a',
      event: { seq, type, data, time, ...(surfaceOp === undefined ? {} : { surfaceOp }) }
    }
  } as never
}

describe('DSH generation statistics projection', () => {
  it('folds whole-session timing, tool duration and replacement token usage', () => {
    const projector = new DshGenerationStatsProjector()
    projector.project(sessionEvent(1, 'request/context', { contextWindow: 128_000 }, 0), 'session-a')
    projector.project(sessionEvent(2, 'step/start', { turn: 1, step: 1 }, 1_000), 'session-a')
    projector.project(sessionEvent(3, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', text: '开始' }
    }, 1_800), 'session-a')
    projector.project(sessionEvent(4, 'tool/call', { callId: 'call-a' }, 2_000), 'session-a')
    projector.project(sessionEvent(5, 'tool/result', {
      message: { source: { callId: 'call-a' }, content: [{ type: 'text', text: '完成' }] }
    }, 2_500), 'session-a')
    projector.project(sessionEvent(6, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: {
        type: 'usage',
        usage: { inputTokens: 6_000, outputTokens: 20, cacheReadTokens: 4_000, cacheWriteTokens: 0 }
      }
    }, 4_700), 'session-a')
    projector.project(sessionEvent(7, 'assistant/message', {
      turn: 1,
      step: 1,
      usage: { inputTokens: 6_000, outputTokens: 60, cacheReadTokens: 4_000, cacheWriteTokens: 0 },
      message: { content: [{ type: 'text', text: '最终回复' }] }
    }, 4_800), 'session-a')
    const stats = projector.project(sessionEvent(8, 'step/end', { turn: 1, step: 1 }, 4_900), 'session-a')

    expect(stats).toMatchObject({
      turns: 1,
      steps: 1,
      llmMs: 3_800,
      toolMs: 500,
      ttftMs: 800,
      ttftSteps: 1,
      decodeMs: 3_000,
      decodeTokens: 60,
      tokenUsage: {
        uncachedInputTokens: 6_000,
        outputTokens: 60,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 0
      },
      contextPressure: { pressureTokens: 10_000, contextWindow: 128_000 }
    })
  })

  it('tracks surface movement for the projected context total and ignores subagents', () => {
    const projector = new DshGenerationStatsProjector()
    projector.project(sessionEvent(1, 'user/message', {
      content: [{ type: 'text', text: '12345678' }]
    }, 100, 'append'), 'session-a')
    projector.project(sessionEvent(2, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 90, outputTokens: 10 } }
    }, 200), 'session-a')
    const ignored = {
      method: 'session.event',
      params: {
        sessionId: 'subagent',
        event: { seq: 3, type: 'step/end', data: { turn: 1, step: 1 }, time: 300 }
      }
    } as never
    expect(projector.project(ignored, 'session-a')).toBeUndefined()
    const stats = projector.project(sessionEvent(4, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'abcdefghijkl' }] }
    }, 400, 'append'), 'session-a')

    expect(stats?.contextPressure).toMatchObject({ pressureTokens: 90, projectedTokens: 101 })
    expect(stats?.contextBreakdown.messageTokens).toBe(21)
  })

  it('classifies the final surviving system surface exactly like the DSH token meter', () => {
    const projector = new DshGenerationStatsProjector()
    projector.project(sessionEvent(1, 'system/message', {
      turn: 1,
      step: 1,
      message: { role: 'system', content: [{ type: 'text', text: '12345678' }] }
    }, 100, 'append'), 'session-a')
    projector.project(sessionEvent(2, 'user/message', {
      role: 'user',
      content: [{ type: 'text', text: '12345678' }],
      source: { kind: 'plugin', plugin: 'eleckoi-conversation-context' }
    }, 110, 'append'), 'session-a')
    const stats = projector.project(sessionEvent(3, 'request/header', {
      header: { config: { provider: 'test', model: 'test' }, tools: [{ name: 'tool-a' }] }
    }, 120), 'session-a')

    expect(stats?.contextBreakdown).toEqual({
      systemTokens: 6,
      toolsTokens: 9,
      messageTokens: 10
    })
  })

  it('uses DSH startSeq and endSeq replacements for both pressure and breakdown', () => {
    const projector = new DshGenerationStatsProjector()
    projector.project(sessionEvent(1, 'user/message', {
      role: 'user', content: [{ type: 'text', text: '12345678' }]
    }, 100, 'append'), 'session-a')
    projector.project(sessionEvent(2, 'user/message', {
      role: 'user', content: [{ type: 'text', text: 'abcdefghijkl' }]
    }, 110, 'append'), 'session-a')
    projector.project(sessionEvent(3, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } }
    }, 120), 'session-a')
    projector.project(sessionEvent(4, 'compaction/summary', {
      shadowedRange: { start: 1, end: 2 },
      shadowedTokenCount: 21
    }, 130), 'session-a')
    const stats = projector.project(sessionEvent(5, 'user/message', {
      role: 'user', content: [{ type: 'text', text: 'abcd' }]
    }, 140, { op: 'replace', startSeq: 1, endSeq: 2 }), 'session-a')

    expect(stats?.contextPressure).toMatchObject({ pressureTokens: 100, projectedTokens: 88 })
    expect(stats?.contextBreakdown).toMatchObject({ systemTokens: 0, messageTokens: 9 })
  })

  it('restores durable totals without reviving transient open work', () => {
    const stored = emptyStoredGenerationStats()
    stored.turns = 3
    stored.steps = 8
    stored.lastSeq = 42
    stored.openStep = { turn: 4, step: 1, startTime: 100, firstTokenTime: null }
    stored.pendingCalls = { stale: 120 }

    const parsed = parseStoredGenerationStats(stored)
    expect(parsed).toMatchObject({ turns: 3, steps: 8, lastSeq: 42, openStep: null, pendingCalls: {} })
  })

  it('does not treat prototype names as pending tool calls', () => {
    const projector = new DshGenerationStatsProjector()
    const stats = projector.project(sessionEvent(1, 'tool/result', {
      message: { source: { callId: 'constructor' }, content: [] }
    }, 500), 'session-a')

    expect(stats).toBeUndefined()
    expect(projector.snapshot().toolMs).toBe(0)
  })
})
