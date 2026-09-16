import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

const publicPrefix = 'virtual:author-vendor/'
const resolvedPrefix = '\0eleckoi-author-vendor:'

const mimeTypes: Record<string, string> = {
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

export function authorVendorPlugin(projectRoot: string): Plugin {
  const vendorRoot = resolve(projectRoot, 'node_modules')
  return {
    name: 'eleckoi-author-vendor',
    enforce: 'pre',
    resolveId(id) {
      if (!id.startsWith(publicPrefix)) return null
      return `${resolvedPrefix}${encodeURIComponent(id.slice(publicPrefix.length))}.js`
    },
    async load(id) {
      if (!id.startsWith(resolvedPrefix)) return null
      const request = decodeURIComponent(id.slice(resolvedPrefix.length, -3))
      const separator = request.indexOf('/')
      const mode = request.slice(0, separator)
      const packagePath = request.slice(separator + 1)
      const absolutePath = resolve(vendorRoot, ...packagePath.split('/'))
      if (!absolutePath.startsWith(`${vendorRoot}${sep}`)) {
        throw new Error(`作者运行库资源越出 node_modules：${packagePath}`)
      }
      if (mode === 'text') {
        const content = await readFile(absolutePath, 'utf8')
        return `export default ${JSON.stringify(content)}`
      }
      if (mode === 'data') {
        const extension = absolutePath.slice(absolutePath.lastIndexOf('.')).toLowerCase()
        const mimeType = mimeTypes[extension]
        if (!mimeType) throw new Error(`作者运行库不支持内联资源类型：${extension}`)
        const content = await readFile(absolutePath)
        return `export default ${JSON.stringify(`data:${mimeType};base64,${content.toString('base64')}`)}`
      }
      throw new Error(`未知作者运行库载入模式：${mode}`)
    }
  }
}
