import * as YAML from 'yaml';
import * as Zod from 'zod';

import fontAwesomeCss from 'virtual:author-vendor/text/@fortawesome/fontawesome-free/css/all.min.css';
import fontAwesomeSource from 'virtual:author-vendor/text/@fortawesome/fontawesome-free/js/all.min.js';
import fontAwesomeBrands from 'virtual:author-vendor/data/@fortawesome/fontawesome-free/webfonts/fa-brands-400.woff2';
import fontAwesomeRegular from 'virtual:author-vendor/data/@fortawesome/fontawesome-free/webfonts/fa-regular-400.woff2';
import fontAwesomeSolid from 'virtual:author-vendor/data/@fortawesome/fontawesome-free/webfonts/fa-solid-900.woff2';
import fontAwesomeV4 from 'virtual:author-vendor/data/@fortawesome/fontawesome-free/webfonts/fa-v4compatibility.woff2';
import jquerySource from 'virtual:author-vendor/text/jquery/dist/jquery.min.js';
import jqueryUiCss from 'virtual:author-vendor/text/jquery-ui-dist/jquery-ui.min.css';
import jqueryUiSource from 'virtual:author-vendor/text/jquery-ui-dist/jquery-ui.min.js';
import jqueryUiIcon444444 from 'virtual:author-vendor/data/jquery-ui-dist/images/ui-icons_444444_256x240.png';
import jqueryUiIcon555555 from 'virtual:author-vendor/data/jquery-ui-dist/images/ui-icons_555555_256x240.png';
import jqueryUiIcon777620 from 'virtual:author-vendor/data/jquery-ui-dist/images/ui-icons_777620_256x240.png';
import jqueryUiIcon777777 from 'virtual:author-vendor/data/jquery-ui-dist/images/ui-icons_777777_256x240.png';
import jqueryUiIconCc0000 from 'virtual:author-vendor/data/jquery-ui-dist/images/ui-icons_cc0000_256x240.png';
import jqueryUiIconFfffff from 'virtual:author-vendor/data/jquery-ui-dist/images/ui-icons_ffffff_256x240.png';
import touchPunchSource from 'virtual:author-vendor/text/jquery-ui-touch-punch/jquery.ui.touch-punch.min.js';
import lodashSource from 'virtual:author-vendor/text/lodash/lodash.min.js';
import pixiSource from 'virtual:author-vendor/text/pixi.js/dist/pixi.min.js';
import showdownSource from 'virtual:author-vendor/text/showdown/dist/showdown.min.js';
import tailwindBrowserSource from 'virtual:author-vendor/text/@tailwindcss/browser/dist/index.global.js';
import toastrCss from 'virtual:author-vendor/text/toastr/build/toastr.min.css';
import toastrSource from 'virtual:author-vendor/text/toastr/build/toastr.min.js';
import vueSource from 'virtual:author-vendor/text/vue/dist/vue.global.prod.js';
import vueRouterSource from 'virtual:author-vendor/text/vue-router/dist/vue-router.global.prod.js';

export const AUTHOR_LIBRARY_HOST_KEY = '__ElecKoiAuthorRuntimeLibrariesV1';

export const AUTHOR_LIBRARY_VERSIONS = Object.freeze({
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

function replaceAsset(source, path, value) {
  return source.replaceAll(path, value);
}

function buildRuntimeCss() {
  let jqueryUi = jqueryUiCss;
  jqueryUi = replaceAsset(jqueryUi, 'images/ui-icons_444444_256x240.png', jqueryUiIcon444444);
  jqueryUi = replaceAsset(jqueryUi, 'images/ui-icons_555555_256x240.png', jqueryUiIcon555555);
  jqueryUi = replaceAsset(jqueryUi, 'images/ui-icons_777620_256x240.png', jqueryUiIcon777620);
  jqueryUi = replaceAsset(jqueryUi, 'images/ui-icons_777777_256x240.png', jqueryUiIcon777777);
  jqueryUi = replaceAsset(jqueryUi, 'images/ui-icons_cc0000_256x240.png', jqueryUiIconCc0000);
  jqueryUi = replaceAsset(jqueryUi, 'images/ui-icons_ffffff_256x240.png', jqueryUiIconFfffff);

  let fontAwesome = fontAwesomeCss;
  fontAwesome = replaceAsset(fontAwesome, '../webfonts/fa-brands-400.woff2', fontAwesomeBrands);
  fontAwesome = replaceAsset(fontAwesome, '../webfonts/fa-regular-400.woff2', fontAwesomeRegular);
  fontAwesome = replaceAsset(fontAwesome, '../webfonts/fa-solid-900.woff2', fontAwesomeSolid);
  fontAwesome = replaceAsset(fontAwesome, '../webfonts/fa-v4compatibility.woff2', fontAwesomeV4);

  return [jqueryUi, toastrCss, fontAwesome].join('\n');
}

function buildRuntimeSource() {
  return [
    jquerySource,
    jqueryUiSource,
    touchPunchSource,
    lodashSource,
    pixiSource,
    showdownSource,
    toastrSource,
    vueSource,
    vueRouterSource,
    fontAwesomeSource,
    tailwindBrowserSource,
  ].join('\n;\n');
}

let prepared;

export function prepareAuthorRuntimeLibraries() {
  if (prepared) return prepared;

  Object.defineProperty(globalThis, AUTHOR_LIBRARY_HOST_KEY, {
    configurable: true,
    value: Object.freeze({ YAML, Zod }),
  });

  prepared = Object.freeze({
    scriptUrl: URL.createObjectURL(new Blob([buildRuntimeSource()], { type: 'text/javascript' })),
    styleUrl: URL.createObjectURL(new Blob([buildRuntimeCss()], { type: 'text/css' })),
    versions: AUTHOR_LIBRARY_VERSIONS,
  });
  return prepared;
}
