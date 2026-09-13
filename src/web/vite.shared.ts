/**
 * WebUI 服务端构建配置的共享工厂。
 *
 * 关键点：
 *  - 把裸导入 `electron` 别名到 src/web/shims/electron.ts，使上游含 Electron 代码的文件
 *    （DesktopGateway / AppPaths / CredentialCipher）可以原样复用，无需 fork。
 *  - 上游源码走 @main / @shared 别名打进产物；node_modules 依赖保持外部化，运行时由 node 解析。
 */

import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export function createWebBuildConfig(entry: string, outFileName: string) {
  return defineConfig({
    resolve: {
      alias: {
        electron: resolve('src/web/shims/electron.ts'),
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      ssr: resolve(entry),
      outDir: resolve('out/web'),
      emptyOutDir: true,
      target: 'node24',
      minify: false,
      sourcemap: true,
      rollupOptions: {
        output: {
          entryFileNames: outFileName,
          format: 'es'
        }
      }
    }
    // 不在此列出工作区包：上游 scripts/check-architecture.mjs 禁止 src/ 下出现
    // dsh-runtime 字面量（DSH 只能经 Agent 模块适配器访问）。工作区包本身已构建出
    // dist/ 并作为真实包存在于 node_modules，SSR 外部化后可被 node 正常解析。
  })
}
