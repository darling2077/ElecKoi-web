/** 数据库迁移验收：在真实库副本上跑 v3 → v4 并逐行比对。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/migrateCheck.ts', 'migrate.mjs')
