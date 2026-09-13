/** 反向代理部署（自定义域名/HTTPS/Cookie/限流/卡片源分流）验收测试构建。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/proxyCheck.ts', 'proxy.mjs')
