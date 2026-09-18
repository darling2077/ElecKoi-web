import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { installRequestConfig, projectCompactionRequest } from '../resources/dsh/request-config.mjs';

describe('DSH request configuration', () => {
  it('replaces only the final compaction instruction with the active preset template', () => {
    const first = { id: 'earlier', role: 'user', content: [{ type: 'text', text: '较早对话' }] };
    const upstream = { id: 'upstream', role: 'user', content: [{ type: 'text', text: 'DSH 默认英文压缩模板' }] };
    const projected = projectCompactionRequest({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      purpose: 'compaction',
      reasoningEffort: 'high',
      tools: [{ name: 'read', description: 'read', parameters: {} }],
      messages: [first, upstream],
    }, '请用中文保留角色状态和未完成剧情。');

    expect(projected.messages[0]).toBe(first);
    expect(projected.messages[1]).toMatchObject({ id: 'upstream', role: 'user' });
    expect(projected.messages[1].content[0].text).toContain('请用中文保留角色状态和未完成剧情。');
    expect(projected.messages[1].content[0].text).not.toContain('DSH 默认英文压缩模板');
    expect(projected).not.toHaveProperty('tools');
    expect(projected).not.toHaveProperty('reasoningEffort');
  });

  it('leaves ordinary requests and blank preset templates untouched', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }];
    expect(projectCompactionRequest({ purpose: undefined, messages }, '模板')).toBeUndefined();
    expect(projectCompactionRequest({ purpose: 'compaction', messages }, '   ')).toBeUndefined();
  });

  it('routes a compaction through the public DSH llm stream with the session preset template', () => {
    const root = mkdtempSync(join(tmpdir(), 'eleckoi-request-config-'));
    try {
      writeFileSync(join(root, 'session-a.json'), JSON.stringify({
        model: { provider: 'deepseek-official', model: 'deepseek-flash' },
        historyCompactionInstructions: '只保留角色状态与剧情伏笔。',
      }));
      const listeners = new Map();
      const disposers = [];
      const agentCtx = {
        on(name, listener) {
          listeners.set(name, listener);
          const dispose = vi.fn();
          disposers.push(dispose);
          return dispose;
        },
      };
      const dispose = installRequestConfig(agentCtx, root, 'session-a');
      const inherited = vi.fn(() => options);
      const options = {
        provider: 'deepseek-official', model: 'deepseek-flash', purpose: 'compaction',
        messages: [{ role: 'user', content: [{ type: 'text', text: '上游默认模板' }] }],
      };

      const projected = listeners.get('llm/stream')(options, inherited);
      expect(inherited).toHaveBeenCalledOnce();
      expect(projected.messages[0].content[0].text).toContain('只保留角色状态与剧情伏笔。');
      expect(projected).not.toHaveProperty('tools');
      expect(projected).not.toHaveProperty('reasoningEffort');

      dispose();
      expect(disposers.every((entry) => entry.mock.calls.length === 1)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
