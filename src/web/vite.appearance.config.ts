/** M3 自有页面（登录/账号/用户管理）外观一致性验收测试构建。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/appearanceCheck.ts', 'appearance.mjs')
