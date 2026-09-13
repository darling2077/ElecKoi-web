/** 备份/恢复验收测试构建。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/backupCheck.ts', 'backup.mjs')
