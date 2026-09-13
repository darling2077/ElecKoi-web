/** 并发配额验收测试构建。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/quotaCheck.ts', 'quota.mjs')
