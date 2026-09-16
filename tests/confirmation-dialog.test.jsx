import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfirmationDialog } from '../src/renderer/src/ui/ui/ConfirmationDialog.jsx';

describe('confirmation dialog', () => {
  it('states the destructive message action before it can run', () => {
    const html = renderToStaticMarkup(<ConfirmationDialog
      open
      title="删除这些消息？"
      description="将删除选中消息及其后的全部内容，共 3 条。"
      confirmLabel="删除消息"
      destructive
      onCancel={() => {}}
      onConfirm={() => {}}
    />);

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('删除这些消息？');
    expect(html).toContain('共 3 条');
    expect(html).toContain('class="is-destructive"');
    expect(html).toContain('>删除消息<');
    expect(html).toContain('>取消<');
  });
});
