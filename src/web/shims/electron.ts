/**
 * ElecKoi WebUI · Electron 替身模块
 *
 * 构建期把裸导入 `electron` 别名到本文件，使上游那些「只用到 electron 很小一面」的
 * 文件（DesktopGateway 的 ipcMain/BrowserWindow、AppPaths 的 app、CredentialCipher 的
 * safeStorage）可以被原样复用，而不需要在 git 树里修改上游源码。
 *
 * 原则：
 *  - 只实现上游复用代码真正碰到的面，不做完整模拟。
 *  - 语义上「在 Web 端不该存在」的能力一律显式抛错，避免静默错误行为。
 */

import { join } from 'node:path'

/** 部署根目录：容器内由 ELECKOI_APP_ROOT 指定，缺省为进程工作目录。 */
function appRoot(): string {
  return process.env.ELECKOI_APP_ROOT ?? process.cwd()
}

/**
 * 每个租户的数据目录由 WebAppPaths 直接持有；此处的 getPath 只是兜底，
 * 保证任何遗漏路径都不会静默写到宿主机意外位置。
 */
function fallbackUserData(): string {
  return process.env.ELECKOI_DATA_DIR ?? join(appRoot(), '.eleckoi-web-data')
}

export const app = {
  getPath(name: string): string {
    if (name === 'userData') return fallbackUserData()
    if (name === 'temp') return process.env.TMPDIR ?? '/tmp'
    throw new Error(`WebUI 运行时不支持 app.getPath(${JSON.stringify(name)})`)
  },
  getAppPath(): string {
    return appRoot()
  },
  getVersion(): string {
    return process.env.ELECKOI_VERSION ?? '0.0.0-web'
  },
  isPackaged: false,
  requestSingleInstanceLock(): boolean {
    return true
  },
  whenReady(): Promise<void> {
    return Promise.resolve()
  },
  on(): void {},
  once(): void {},
  quit(): void {},
  setAppUserModelId(): void {}
}

/**
 * Web 端凭据加密由 WebCredentialCipher 负责（AES-256-GCM + 服务端主密钥）。
 * 上游 safeStorage 依赖操作系统钥匙串，容器内不存在，故一律抛错——
 * 一旦有代码路径意外走到这里，立刻暴露而不是静默降级。
 */
export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return false
  },
  encryptString(): Buffer {
    throw new Error('WebUI 运行时不可用 safeStorage，请使用 WebCredentialCipher。')
  },
  decryptString(): string {
    throw new Error('WebUI 运行时不可用 safeStorage，请使用 WebCredentialCipher。')
  }
}

/** Web 端没有 IPC 主进程通道；网关由 WebGateway 走 WebSocket。 */
export const ipcMain = {
  handle(): void {},
  removeHandler(): void {},
  on(): void {}
}

/** Web 端没有 BrowserWindow；事件广播由 WebGateway 覆盖为推送到 WS 连接。 */
export const BrowserWindow = {
  getAllWindows(): never[] {
    return []
  },
  fromWebContents(): undefined {
    return undefined
  }
}

export const dialog = {
  showErrorBox(): void {},
  showMessageBox(): Promise<{ response: number }> {
    return Promise.resolve({ response: 0 })
  }
}

export const shell = {
  openExternal(): Promise<void> {
    return Promise.resolve()
  }
}

export default { app, safeStorage, ipcMain, BrowserWindow, dialog, shell }
