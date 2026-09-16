import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { authorVendorPlugin } from './scripts/vite-author-vendor-plugin'

export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve('src/main'),
      '@shared': resolve('src/shared'),
      '@eleckoi/dsh-runtime': resolve('packages/dsh-runtime/src/index.ts')
    }
  },
  plugins: [authorVendorPlugin(resolve('.'))],
  test: {
    environment: 'node'
  }
})
