/** WebUI POC 构建（默认产出 out/web/poc.mjs）。 */

import { createWebBuildConfig } from './vite.shared'

export default createWebBuildConfig('src/web/poc/run.ts', 'poc.mjs')
