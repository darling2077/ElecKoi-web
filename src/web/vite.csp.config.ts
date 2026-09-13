/** M3 安全头与 CSP 验收测试构建。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/cspCheck.ts', 'csp.mjs')
