/** M3 卡片跨源隔离验收测试构建。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/cardIsolationCheck.ts', 'cardisolation.mjs')
