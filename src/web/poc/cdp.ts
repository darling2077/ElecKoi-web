/**
 * 验收用的极简 CDP 客户端。
 *
 * 只需要 `Runtime.evaluate`：在真实浏览器里读页面状态。抽成共享模块是因为
 * chrome 组与卡片图组都要用，两处各写一份容易漂移。
 */

export class Cdp {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private listeners: Array<(method: string, params: Record<string, unknown>) => void> = []

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number
        method?: string
        params?: Record<string, unknown>
        result?: unknown
        error?: { message: string }
      }
      if (message.id === undefined) {
        if (message.method !== undefined) {
          for (const listener of this.listeners) listener(message.method, message.params ?? {})
        }
        return
      }
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((done, fail) => {
      ws.addEventListener('open', () => done(), { once: true })
      ws.addEventListener('error', () => fail(new Error('CDP 连接失败')), { once: true })
    })
    return new Cdp(ws)
  }

  /** 订阅 CDP 事件（如 Runtime.exceptionThrown）。 */
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): void {
    this.listeners.push(listener)
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 在页面里执行表达式并取回 JSON 值。 */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '页面内执行出错'
      throw new Error(detail.slice(0, 300))
    }
    return result.result?.value as T
  }

  close(): void {
    this.ws.close()
  }
}

/**
 * 等一个**页面目标**的调试端点。
 *
 * 注意 `/json/version` 给的是**浏览器级**端点——在它上面调 `Page.navigate` 或
 * `Network.enable` 会报 "wasn't found"。要操作页面必须用 `/json/list` 里 type=page 的那条。
 */
export async function waitForPageEndpoint(port: number, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl !== undefined)
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl
    } catch {
      // 还没起来
    }
    await new Promise((done) => setTimeout(done, 300))
  }
  throw new Error('Chromium 页面目标未就绪')
}

/** 等 headless chromium 的调试端口就绪。 */
export async function waitForEndpoint(port: number, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      const payload = await response.json() as { webSocketDebuggerUrl?: string }
      if (payload.webSocketDebuggerUrl) return payload.webSocketDebuggerUrl
    } catch {
      // 还没起来
    }
    await new Promise((done) => setTimeout(done, 300))
  }
  throw new Error('Chromium 调试端口未就绪')
}

/**
 * 收掉 headless chromium：先杀进程、等它真的退出，再删 profile。
 *
 * 为什么必须等：chromium 还在写 profile 时直接 rmSync 会抛 ENOTEMPTY，
 * 而这类清理异常会**盖住真正的断言结果**（chrome 组与 cardimages 组都吃过这个亏）。
 * 删除失败也不影响验收结论，所以最后一步只吞掉错误。
 */
export async function closeBrowser(
  browser: { kill(signal?: NodeJS.Signals): boolean; exitCode: number | null; signalCode: NodeJS.Signals | null; once(event: 'exit', listener: () => void): unknown },
  profile: string
): Promise<void> {
  try {
    browser.kill('SIGKILL')
  } catch {
    // 已经退出了
  }
  await new Promise<void>((done) => {
    if (browser.exitCode !== null || browser.signalCode !== null) return done()
    browser.once('exit', () => done())
    setTimeout(done, 5000)
  })
  const { rmSync } = await import('node:fs')
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // 临时目录删不掉不影响结论
  }
}
