import { describe, expect, it } from 'vitest'
import { DshProcessProjector, DshReplyProjector, finalReplyText } from '@eleckoi/dsh-runtime'

function sessionEvent(type: string, data: Record<string, unknown>, time: number, sessionId = 'session-a') {
  return {
    method: 'session.event',
    params: {
      sessionId,
      event: { type, data, time }
    }
  } as never
}

function assistantStream(frame: Record<string, unknown>, sessionId = 'session-a') {
  return {
    method: 'agent.assistant-stream',
    params: { sessionId, frame }
  } as never
}

function assistantStreamStart(attemptId: string, turn: number, step: number, sessionId = 'session-a') {
  return assistantStream({ type: 'start', attemptId, revision: 1, turn, step }, sessionId)
}

function assistantStreamChunk(attemptId: string, index: number, time: number, chunk: Record<string, unknown>, sessionId = 'session-a') {
  return assistantStream({ type: 'chunk', attemptId, revision: index + 2, index, time, chunk }, sessionId)
}

function assistantStreamEnd(attemptId: string, outcome: Record<string, unknown>, sessionId = 'session-a') {
  return assistantStream({ type: 'end', attemptId, revision: 99, index: 1, outcome }, sessionId)
}

describe('DSH process projection', () => {
  it('keeps tool-bound assistant text in the process slot instead of the reply body', () => {
    const projector = new DshReplyProjector()
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 1,
      step: 2,
      chunk: { type: 'text-delta', text: '先检查变量。' }
    }, 70))).toBeUndefined()
    expect(projector.project(sessionEvent('assistant/message', {
      turn: 1,
      step: 2,
      message: {
        id: 'assistant-stage',
        content: [
          { type: 'text', text: '先检查变量。' },
          { type: 'tool-call', id: 'call-a', name: 'eleckoi_read_variables', arguments: '{}' }
        ]
      }
    }, 80))).toBeUndefined()
  })

  it('hands a text-only assistant message to the reply body', () => {
    const projector = new DshReplyProjector()
    projector.project(sessionEvent('assistant/chunk', {
      turn: 1,
      step: 3,
      chunk: { type: 'text-delta', text: '最终回复。' }
    }, 110))
    expect(projector.project(sessionEvent('assistant/message', {
      turn: 1,
      step: 3,
      message: { id: 'assistant-final', content: [{ type: 'text', text: '最终回复。' }] }
    }, 120))).toBe('最终回复。')
  })

  it('streams only the body after a split FINAL boundary', () => {
    const projector = new DshReplyProjector()
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 1,
      step: 3,
      chunk: { type: 'text-delta', text: '阶段说明<FIN' }
    }, 100))).toBeUndefined()
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 1,
      step: 3,
      chunk: { type: 'text-delta', text: 'AL>\n最终回' }
    }, 110))).toBe('最终回')
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 1,
      step: 3,
      chunk: { type: 'text-delta', text: '复。\n</FINAL>' }
    }, 115))).toBe('复。')
    expect(projector.project(sessionEvent('assistant/message', {
      turn: 1,
      step: 3,
      message: { id: 'assistant-final', content: [{ type: 'text', text: '阶段说明<FINAL>\n最终回复。\n</FINAL>' }] }
    }, 120))).toBeUndefined()
  })

  it('streams FINAL content immediately while retaining only a possible closing tag', () => {
    const projector = new DshReplyProjector()
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 2,
      step: 1,
      chunk: { type: 'text-delta', text: '<FINAL>' }
    }, 200))).toBeUndefined()
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 2,
      step: 1,
      chunk: { type: 'text-delta', text: '\r' }
    }, 210))).toBeUndefined()
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 2,
      step: 1,
      chunk: { type: 'text-delta', text: '\n第一段正文。' }
    }, 220))).toBe('第一段正文。')
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 2,
      step: 1,
      chunk: { type: 'text-delta', text: '\n第二段</FIN' }
    }, 230))).toBe('\n第二段')
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 2,
      step: 1,
      chunk: { type: 'text-delta', text: 'AL>' }
    }, 240))).toBeUndefined()
  })

  it('streams FINAL content across the increasing revisions emitted by DSH 0.1.5', () => {
    const projector = new DshReplyProjector('session-a')
    expect(projector.project(assistantStreamStart('reply-attempt', 6, 2))).toBeUndefined()
    expect(projector.project(assistantStreamChunk('reply-attempt', 0, 500,
      { type: 'text-delta', index: 1, text: '<' }))).toBeUndefined()
    expect(projector.project(assistantStreamChunk('reply-attempt', 1, 510,
      { type: 'text-delta', index: 1, text: 'FINAL>第一段' }))).toBe('第一段')
    expect(projector.project(assistantStreamChunk('reply-attempt', 2, 520,
      { type: 'text-delta', index: 1, text: '正文。' }))).toBe('正文。')
    expect(projector.project(sessionEvent('assistant/message', {
      turn: 6,
      step: 2,
      message: { id: 'assistant-final', content: [{ type: 'text', text: '<FINAL>第一段正文。</FINAL>' }] }
    }, 530))).toBeUndefined()
    expect(projector.project(assistantStreamEnd('reply-attempt', {
      kind: 'committed', eventType: 'assistant/message', seq: 9
    }))).toBeUndefined()
  })

  it('removes the FINAL envelope from persisted reply text', () => {
    expect(finalReplyText('<FINAL>\n最终回复。\n</FINAL>')).toBe('最终回复。')
    expect(finalReplyText('没有协议标记的最终回复。')).toBe('没有协议标记的最终回复。')
  })

  it('projects assistant prose as a phase boundary only when that step continues into tools', () => {
    const projector = new DshProcessProjector()
    expect(projector.project(sessionEvent('assistant/message', {
      turn: 1,
      step: 2,
      message: {
        id: 'assistant-stage',
        content: [
          { type: 'text', text: '先检查设定，再读取变量。' },
          { type: 'tool-call', id: 'call-a', name: 'eleckoi_glob_setting_files', arguments: '{}' }
        ]
      }
    }, 80))).toMatchObject({
      id: 'narrative-assistant-stage',
      kind: 'narrative',
      toolName: 'assistant_narrative',
      summary: '先检查设定，再读取变量。'
    })

    expect(projector.project(sessionEvent('assistant/message', {
      turn: 1,
      step: 3,
      message: { id: 'assistant-final', content: [{ type: 'text', text: '最终回复。' }] }
    }, 120))).toBeUndefined()
  })

  it('streams native DSH reasoning into one stable process item and settles it at block end', () => {
    const projector = new DshProcessProjector()
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 4,
      step: 2,
      chunk: { type: 'block-start', index: 0, blockType: 'reasoning' }
    }, 200))).toMatchObject({
      id: 'reasoning-session-a:4:2:0',
      kind: 'reasoning',
      status: 'running',
      detail: ''
    })
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 4,
      step: 2,
      chunk: { type: 'reasoning-delta', index: 0, text: '先读取' }
    }, 260))).toMatchObject({
      id: 'reasoning-session-a:4:2:0',
      status: 'running',
      detail: '先读取'
    })
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 4,
      step: 2,
      chunk: { type: 'reasoning-delta', index: 0, text: '设定。' }
    }, 270))).toBeUndefined()
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 4,
      step: 2,
      chunk: { type: 'reasoning-delta', index: 0, text: '完成。' }
    }, 320))).toMatchObject({
      id: 'reasoning-session-a:4:2:0',
      status: 'running',
      detail: '先读取设定。完成。'
    })
    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 4,
      step: 2,
      chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先读取设定。完成。' } }
    }, 340))).toMatchObject({
      id: 'reasoning-session-a:4:2:0',
      kind: 'reasoning',
      status: 'complete',
      summary: '先读取设定。完成。',
      detail: '先读取设定。完成。',
      startedAtMillis: 200,
      completedAtMillis: 340
    })
    expect(projector.project(sessionEvent('assistant/message', {
      turn: 4,
      step: 2,
      message: {
        id: 'assistant-reasoned',
        content: [
          { type: 'reasoning', text: '先读取设定。完成。' },
          { type: 'text', text: '最终回复。' }
        ]
      }
    }, 350))).toBeUndefined()
  })

  it('projects reasoning delivered only in the completed assistant message', () => {
    const projector = new DshProcessProjector()
    expect(projector.project(sessionEvent('assistant/message', {
      turn: 5,
      step: 1,
      message: {
        id: 'assistant-final-only-reasoning',
        content: [
          { type: 'reasoning', text: '先判断用户意图。' },
          { type: 'text', text: '你好。' }
        ]
      }
    }, 400))).toMatchObject({
      id: 'reasoning-session-a:5:1:0',
      kind: 'reasoning',
      status: 'complete',
      summary: '先判断用户意图。',
      detail: '先判断用户意图。',
      startedAtMillis: 400,
      completedAtMillis: 400
    })
  })

  it('projects reasoning live from the transient assistant stream used by DSH 0.1.5', () => {
    const projector = new DshProcessProjector('session-a')
    expect(projector.project(assistantStreamStart('reasoning-attempt', 7, 3))).toBeUndefined()
    expect(projector.project(assistantStreamChunk('reasoning-attempt', 0, 600,
      { type: 'block-start', index: 0, blockType: 'reasoning' }))).toMatchObject({
      id: 'reasoning-session-a:7:3:0',
      status: 'running',
      startedAtMillis: 600
    })
    expect(projector.project(assistantStreamChunk('reasoning-attempt', 1, 660,
      { type: 'reasoning-delta', index: 0, text: '继续生成最终回复。' }))).toMatchObject({
      id: 'reasoning-session-a:7:3:0',
      status: 'running',
      detail: '继续生成最终回复。'
    })
    expect(projector.project(sessionEvent('assistant/message', {
      turn: 7,
      step: 3,
      message: {
        id: 'assistant-reasoned',
        content: [{ type: 'reasoning', text: '继续生成最终回复。' }, { type: 'text', text: '正文。' }]
      }
    }, 680))).toMatchObject({
      id: 'reasoning-session-a:7:3:0',
      status: 'complete'
    })
    expect(projector.project(assistantStreamEnd('reasoning-attempt', {
      kind: 'committed', eventType: 'assistant/message', seq: 10
    }))).toBeUndefined()
  })

  it('keeps each live attempt on its DSH start-frame step instead of reusing one unknown slot', () => {
    const projector = new DshProcessProjector('session-a')
    expect(projector.project(assistantStreamStart('attempt-one', 8, 1))).toBeUndefined()
    expect(projector.project(assistantStreamChunk('attempt-one', 0, 700,
      { type: 'block-start', index: 0, blockType: 'reasoning' }))).toMatchObject({
      id: 'reasoning-session-a:8:1:0'
    })
    expect(projector.project(assistantStreamEnd('attempt-one', { kind: 'abandoned' }))).toMatchObject({
      id: 'reasoning-session-a:8:1:0',
      status: 'cancelled'
    })

    expect(projector.project(assistantStreamStart('attempt-two', 8, 2))).toBeUndefined()
    expect(projector.project(assistantStreamChunk('attempt-two', 0, 800,
      { type: 'block-start', index: 0, blockType: 'reasoning' }))).toMatchObject({
      id: 'reasoning-session-a:8:2:0'
    })
  })

  it('pairs approval audit events into one persistent fail-closed timeline item', () => {
    const projector = new DshProcessProjector()
    expect(projector.project(sessionEvent('approval/asked', {
      id: 'approval-a',
      toolName: 'pwsh',
      callId: 'call-a',
      reason: '需要访问工作区外路径'
    }, 100))).toMatchObject({
      id: 'approval-approval-a',
      status: 'running',
      toolName: 'approval',
      summary: '需要访问工作区外路径',
      startedAtMillis: 100
    })

    expect(projector.project(sessionEvent('approval/decided', {
      id: 'approval-a',
      outcome: 'rejected'
    }, 150))).toMatchObject({
      id: 'approval-approval-a',
      status: 'error',
      toolName: 'approval',
      summary: '已安全拒绝高风险操作',
      detail: '角色聊天暂未开放高风险操作授权，已安全拒绝',
      startedAtMillis: 100,
      completedAtMillis: 150
    })
  })

  it('shows automatic compaction as one concrete process item with a readable failure', () => {
    const projector = new DshProcessProjector()
    expect(projector.project(sessionEvent('compaction/start', {
      compactionId: 'compact-a'
    }, 100))).toMatchObject({
      id: 'compaction-compact-a',
      kind: 'compaction',
      status: 'running'
    })
    expect(projector.project(sessionEvent('compaction/summary', {
      compactionId: 'compact-a',
      summary: [{ type: 'text', text: '保留的人物与剧情摘要' }]
    }, 120))).toBeUndefined()
    expect(projector.project(sessionEvent('compaction/end', {
      compactionId: 'compact-a'
    }, 140))).toMatchObject({
      status: 'complete',
      summary: '上下文已自动压缩',
      detail: '保留的人物与剧情摘要'
    })

    expect(projector.project(sessionEvent('compaction/end', {
      compactionId: 'compact-b',
      error: 'summary is not smaller than the shadowed content (420 estimated framed tokens >= 300)'
    }, 200))).toMatchObject({
      status: 'error',
      summary: '摘要没有比被替换的历史更短（摘要约 420 Token，原历史约 300 Token）'
    })
  })

  it('keeps one authoritative subagent item and nests child session events under it', () => {
    const projector = new DshProcessProjector('session-a', 'child-model')
    expect(projector.project(sessionEvent('tool/call', {
      callId: 'call-subagent',
      name: 'subagent',
      arguments: { description: '搜索最新资讯', prompt: '搜索并汇总' }
    }, 100))).toMatchObject({
      id: 'call-subagent',
      kind: 'subagent',
      status: 'running',
      delegatedModel: 'child-model'
    })

    expect(projector.project({
      method: 'subagent.started',
      params: { parentSessionId: 'session-a', childSessionId: 'session-child' }
    } as never)).toBeUndefined()

    expect(projector.project(sessionEvent('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'block-start', index: 0, blockType: 'reasoning' }
    }, 110, 'session-child'))).toMatchObject({
      kind: 'reasoning',
      parentId: 'call-subagent'
    })

    expect(projector.project({
      method: 'subagent.finished',
      params: { parentSessionId: 'session-a', childSessionId: 'session-child' }
    } as never)).toBeUndefined()

    expect(projector.project(sessionEvent('tool/result', {
      message: {
        source: { callId: 'call-subagent' },
        content: [{ type: 'tool-result', toolCallId: 'call-subagent', content: '已完成搜索' }]
      }
    }, 150))).toMatchObject({
      id: 'call-subagent',
      kind: 'subagent',
      status: 'complete',
      delegatedModel: 'child-model'
    })
  })

  it('preserves tool identity when compaction replaces a completed tool result', () => {
    const projector = new DshProcessProjector('session-a')
    expect(projector.project(sessionEvent('tool/call', {
      callId: 'call-read-settings',
      name: 'eleckoi_read_setting_files',
      arguments: { paths: ['世界/当前地点'] }
    }, 100))).toMatchObject({
      id: 'call-read-settings',
      status: 'running',
      toolName: 'eleckoi_read_setting_files'
    })

    const result = (text: string, time: number) => sessionEvent('tool/result', {
      message: {
        source: { kind: 'tool', callId: 'call-read-settings' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-read-settings',
          content: [{ type: 'text', text }]
        }]
      }
    }, time)
    expect(projector.project(result('{"status":"ok","files":[{"path":"世界/当前地点","content":"正文"}]}', 150))).toMatchObject({
      id: 'call-read-settings',
      status: 'complete',
      toolName: 'eleckoi_read_setting_files',
      startedAtMillis: 100
    })
    expect(projector.project(result('{"status":"ok","files":[{"path":"世界/当前地点","content":"[内容已压缩]"}]}', 200))).toMatchObject({
      id: 'call-read-settings',
      status: 'complete',
      toolName: 'eleckoi_read_setting_files',
      startedAtMillis: 100,
      completedAtMillis: 200
    })
  })

  it('does not expose an orphan tool result with a meaningless generic title', () => {
    const projector = new DshProcessProjector('session-a')
    expect(projector.project(sessionEvent('tool/result', {
      message: {
        source: { kind: 'tool', callId: 'call-orphan' },
        content: [{ type: 'tool-result', toolCallId: 'call-orphan', content: '完成' }]
      }
    }, 100))).toBeUndefined()
  })

  it('does not project unknown sessions into the root reply or process timeline', () => {
    const processProjector = new DshProcessProjector('session-a')
    const replyProjector = new DshReplyProjector('session-a')
    const childMessage = sessionEvent('assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'child-final', content: [{ type: 'text', text: '子会话回复' }] }
    }, 100, 'unknown-child')
    expect(processProjector.project(childMessage)).toBeUndefined()
    expect(replyProjector.project(childMessage)).toBeUndefined()
  })
})
