import { describe, expect, it } from 'vitest'
import { AGENT_TOOL_GROUPS } from '../src/main/modules/agentTools'

describe('desktop Agent tool catalog', () => {
  it('lists only the current DSH workflow and collaboration tools', () => {
    const members = (groupId: string) => AGENT_TOOL_GROUPS
      .find((group) => group.id === groupId)
      ?.members.map((member) => member.name)

    expect(members('builtin:workflow')).toEqual([
      'todo_write', 'get_goal', 'create_goal', 'update_goal',
      'job_output', 'job_list', 'job_kill', 'skill', 'workflow'
    ])
    expect(members('builtin:collaboration')).toEqual([
      'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents'
    ])
  })
})
