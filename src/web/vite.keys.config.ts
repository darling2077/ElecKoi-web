/** 凭据加密（主密钥不可变 / 坏密文降级）验收测试构建。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/keyCheck.ts', 'keys.mjs')
