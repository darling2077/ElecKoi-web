/** M2 多租户验收测试构建。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/multiTenantCheck.ts', 'multitenant.mjs')
