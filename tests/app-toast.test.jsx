import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppToast } from '../src/renderer/src/ui/ui/AppToast.jsx';

vi.mock('../src/renderer/src/ui/icons/index.jsx', async () => {
  const { createElement } = await import('react');
  const Icon = ({ size = 16 }) => createElement('svg', { width: size, height: size, 'aria-hidden': true });
  return { CopyIcon: Icon, XIcon: Icon };
});

describe('app notices', () => {
  it('renders ordinary notices as compact status toasts', () => {
    const html = renderToStaticMarkup(<AppToast notice={{ id: 1, type: 'success', message: '已保存' }} />);

    expect(html).toContain('class="app-toast success"');
    expect(html).toContain('role="status"');
    expect(html).toContain('已保存');
  });

  it('renders errors as persistent copyable dialogs with the complete original message', () => {
    const message = 'RESOURCE_EXHAUSTED\nCaused by: HTTP 429 {"retryDelay":"59s"}';
    const html = renderToStaticMarkup(<AppToast
      notice={{ id: 2, type: 'error', message }}
      onDismiss={() => {}}
    />);

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('运行错误');
    expect(html).toContain('RESOURCE_EXHAUSTED');
    expect(html).toContain('Caused by: HTTP 429');
    expect(html).toContain('复制错误');
    expect(html).toContain('关闭');
  });
});
