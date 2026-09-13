/** WebUI 生产入口（多租户）构建，产出 out/web/entry.mjs。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/entry.ts', 'entry.mjs')
