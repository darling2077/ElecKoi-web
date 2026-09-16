import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  createConversationSeed,
  projectPreStepMessages,
  renderRuntimeContext,
  settingInjections
} from '../resources/dsh/conversation-context.mjs'

const model = { provider: 'moonshotai-cn', model: 'kimi-k3' }

function text(message) {
  return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

function context(entries, promptPositions = []) {
  return {
    history: [],
    settingLibrary: { entries, promptPositions }
  }
}

describe('DSH conversation context', () => {
  it('creates a balanced seed from product history without the current prompt', () => {
    const seed = createConversationSeed({
      conversationContext: {
        history: [
          { role: 'assistant', content: '开场' },
          { role: 'user', content: '上一问' },
          { role: 'assistant', content: '上一答' }
        ]
      }
    }, model)

    expect(seed.map((event) => event.seq)).toEqual(seed.map((_, index) => index))
    expect(seed.filter((event) => event.type === 'turn/start')).toHaveLength(2)
    expect(seed.filter((event) => event.type === 'turn/end')).toHaveLength(2)
    expect(seed.filter((event) => event.type === 'step/start')).toHaveLength(2)
    expect(seed.filter((event) => event.type === 'step/end')).toHaveLength(2)
    expect(seed.filter((event) => event.type === 'user/message').map((event) => text(event.data))).toEqual(['上一问'])
    expect(seed.filter((event) => event.type === 'assistant/message').map((event) => text(event.data.message))).toEqual(['开场', '上一答'])
    expect(JSON.stringify(seed)).not.toContain('最新用户输入')
    expect(seed.filter((event) => event.type === 'assistant/message')[0].data.message.source).toEqual({
      kind: 'model',
      ...model
    })
  })

  it('logs entries before the latest input through agent/pre-step order', () => {
    const latest = createUserMessage({
      content: [{ type: 'text', text: '最新用户输入' }],
      source: { kind: 'user' }
    })
    const projected = projectPreStepMessages([latest], context([
      setting('after-instructions', '系统后', 'after_instructions', 1),
      setting('before-history', '历史前', 'before_history', 1),
      setting('before-latest', '输入前', 'before_latest_user_input', 1),
      setting('after-latest', '输入后', 'after_latest_user_input', 1)
    ]))

    expect(projected.map(text)).toEqual(['系统后', '历史前', '输入前', '最新用户输入'])
    expect(projected.slice(0, 3).every((message) => message.source?.plugin === 'eleckoi-conversation-context')).toBe(true)
  })

  it('keeps post-input and tool-flow context on DSH runtime context', () => {
    const rendered = renderRuntimeContext(context([
      setting('before', '输入前', 'before_latest_user_input', 1),
      setting('after-history', '历史后', 'after_history', 1),
      setting('after-input', '输入后', 'after_latest_user_input', 1),
      setting('before-tools', '工具前', 'before_tool_flow', 1),
      setting('after-tools', '工具后', 'after_tool_flow', 1)
    ]))
    expect(rendered).toBe('历史后\n\n输入后\n\n工具前\n\n工具后')
  })

  it('uses custom position anchors and ignores disabled/on-demand entries', () => {
    const entries = settingInjections(context([
      { ...setting('custom', '自定义位置', 'after_history', 2), promptPositionId: 'custom-position' },
      { ...setting('disabled', '不应出现', 'after_history', 1), enabled: false },
      { ...setting('on-demand', '按需读取', 'after_tool_flow', 1), triggerMode: 'agent_tool' }
    ], [{ id: 'custom-position', anchor: 'before_latest_user_input', order: 7 }]))

    expect(entries).toEqual([expect.objectContaining({
      id: 'custom',
      anchor: 'before_latest_user_input',
      content: '自定义位置',
      positionOrder: 7,
      order: 2
    })])
  })
})

function setting(id, content, position, order) {
  return {
    id,
    enabled: true,
    content,
    kind: 'normal',
    triggerMode: 'always',
    position,
    promptPositionId: '',
    insertRole: 'user',
    order
  }
}
