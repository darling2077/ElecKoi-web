/** 请求体上限（大图/批量导入）验收构建。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/uploadLimitCheck.ts', 'uploadlimit.mjs')
