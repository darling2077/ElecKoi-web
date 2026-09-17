import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import {
  AUTHOR_LIBRARY_VERSIONS,
  prepareAuthorRuntimeLibraries,
} from '../src/renderer/src/modules/authorFrontend/model/authorRuntimeLibraries.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const buildTimeAuthorPackages = [
  '@fortawesome/fontawesome-free',
  '@tailwindcss/browser',
  'jquery',
  'jquery-ui-dist',
  'jquery-ui-touch-punch',
  'lodash',
  'pixi.js',
  'showdown',
  'toastr',
  'vue',
  'vue-router',
];

describe('author runtime libraries', () => {
  it('keeps browser bundles out of packaged production dependencies', () => {
    for (const packageName of buildTimeAuthorPackages) {
      expect(packageJson.dependencies?.[packageName]).toBeUndefined();
      expect(packageJson.devDependencies?.[packageName]).toBeTypeOf('string');
    }
  });

  it('publishes every bundled author dependency with a pinned version', () => {
    expect(AUTHOR_LIBRARY_VERSIONS).toEqual({
      fontAwesome: '7.3.1',
      jquery: '3.7.1',
      jqueryUi: '1.13.3',
      jqueryUiTouchPunch: '0.2.3',
      lodash: '4.17.21',
      pixi: '8.20.1',
      showdown: '2.1.0',
      tailwindCss: '4.3.3',
      toastr: '2.1.4',
      vue: '3.5.42',
      vueRouter: '4.6.3',
      yaml: '2.9.0',
      zod: '4.1.11',
    });
  });

  it('creates one reusable script and style URL containing the browser bundles', async () => {
    const first = prepareAuthorRuntimeLibraries();
    const second = prepareAuthorRuntimeLibraries();
    expect(first).toBe(second);
    expect(first.scriptUrl).toMatch(/^blob:/);
    expect(first.styleUrl).toMatch(/^blob:/);
    const [script, style] = await Promise.all([
      fetch(first.scriptUrl).then((response) => response.text()),
      fetch(first.styleUrl).then((response) => response.text()),
    ]);
    expect(script).toContain('jQuery');
    expect(script).toContain('PIXI');
    expect(script).toContain('showdown');
    expect(script).toContain('VueRouter');
    expect(style).toContain('jQuery UI - v1.13.3');
    expect(style).toContain('toast-container');
    expect(style).toContain('Font Awesome');
  });
});
