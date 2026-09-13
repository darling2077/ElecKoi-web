/** Web 外壳验收测试构建。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/chromeCheck.ts', 'chrome.mjs')
