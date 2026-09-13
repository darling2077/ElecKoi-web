/** 消息渲染（代码块/HTML 块）验收测试构建。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/renderCheck.ts', 'render.mjs')
