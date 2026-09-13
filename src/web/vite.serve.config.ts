/** WebUI 本地服务构建（产出 out/web/serve.mjs，供 webui:serve 使用）。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/serve.ts', 'serve.mjs')
