/** 角色卡批量导入工具的构建配置（维护工具，不是验收脚本）。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/importCards.ts', 'importCards.mjs')
