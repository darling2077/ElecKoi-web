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

  it('places current prompt entries around the latest input and tool flow', () => {
    const latest = createUserMessage({
      content: [{ type: 'text', text: '最新用户输入' }],
      source: { kind: 'user' }
    })
    const projected = projectPreStepMessages([latest], context([
      setting('before-latest', '输入前', 'insert_point_3', 1),
      setting('after-latest', '输入后', 'insert_point_4', 1),
      setting('after-tools', '工具后', 'insert_point_5', 1)
    ]))

    expect(projected.map(text)).toEqual(['输入前', '最新用户输入', '输入后', '工具后'])
    expect([projected[0], projected[2], projected[3]].every((message) => message.source?.plugin === 'eleckoi-conversation-context')).toBe(true)
  })

  it('keeps the stable prefix and cache region in DSH runtime context', () => {
    const rendered = renderRuntimeContext(context([
      setting('point-1', '第一插入点', 'insert_point_1', 1),
      { ...setting('cache', '缓存内容', null, 2), triggerMode: 'cache' },
      setting('point-2', '第二插入点', 'insert_point_2', 1),
      setting('point-3', '输入前', 'insert_point_3', 1)
    ]))
    expect(rendered).toBe('第一插入点\n\n缓存内容\n\n第二插入点')
  })

  it('uses custom position anchors and ignores disabled/on-demand entries', () => {
    const entries = settingInjections(context([
      { ...setting('custom', '自定义位置', 'insert_point_2', 2), promptPositionId: 'custom-position' },
      { ...setting('disabled', '不应出现', 'insert_point_2', 1), enabled: false },
      { ...setting('on-demand', '按需读取', 'insert_point_5', 1), triggerMode: 'agent_tool' }
    ], [{ id: 'custom-position', name: '输入前扩展', anchor: 'insert_point_3', side: 'before_setting_position', order: 7 }]))

    expect(entries).toEqual([expect.objectContaining({
      id: 'custom',
      anchor: 'insert_point_3',
      traceSource: '输入前扩展',
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
