import { describe, expect, it } from 'vitest';
import { buildRichMessageHtml } from '../src/renderer/src/modules/authorFrontend/model/buildRichMessageHtml.js';

describe('rich message sandbox document', () => {
  const runtime = {
    scriptUrl: 'blob:eleckoi-author-libraries-js',
    styleUrl: 'blob:eleckoi-author-libraries-css',
    versions: { jquery: '3.7.1', vue: '3.5.42' },
  };

  it('injects the constrained host transport and author SDK before authored scripts', () => {
    const authored = '<!doctype html><html><head><script>window.cardLoaded=true</script></head><body>card</body></html>';
    const output = buildRichMessageHtml({ source: authored, kind: 'full-document', contentKey: 'a' }, 'channel-a', runtime);
    expect(output).not.toContain('Content-Security-Policy')
    expect(output).toContain("Object.defineProperty(window, 'ElecKoiNative'")
    expect(output).toContain('0.1.0')
    expect(output).toContain('blob:eleckoi-author-libraries-js')
    expect(output).toContain('blob:eleckoi-author-libraries-css')
    expect(output).toContain('window.ElecKoiLibraries')
    expect(output).toContain('audio.setPlaylist')
    expect(output).toContain('media.getMessageAttachments')
    expect(output.indexOf('ElecKoiNative')).toBeLessThan(output.indexOf('window.cardLoaded'))
    expect(output.indexOf('blob:eleckoi-author-libraries-js')).toBeLessThan(output.indexOf('window.cardLoaded'))
  });

  it('wraps fragments in a complete transparent document', () => {
    const output = buildRichMessageHtml({ source: '<div class="card">card</div>', kind: 'fragment', contentKey: 'b' }, 'channel-b');
    expect(output.startsWith('<!doctype html><html><head>')).toBe(true)
    expect(output).toContain('<body><div class="card">card</div></body>')
  });

  it('keeps a body-only authored document as the document body', () => {
    const authored = '<body><main>panel</main><script>window.panelLoaded=true</script></body>';
    const output = buildRichMessageHtml({ source: authored, kind: 'full-document', contentKey: 'c' }, 'channel-c');
    expect(output).toContain('</head><body><main>panel</main>')
    expect(output).not.toContain('<body><body>')
    expect(output.indexOf('ElecKoiNative')).toBeLessThan(output.indexOf('window.panelLoaded'))
  });
});
