import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export type DshRequestContextRole = 'system' | 'user' | 'assistant'
export type DshRequestContextKind = 'system' | 'prompt' | 'history' | 'user' | 'assistant' | 'tool' | 'context'

export interface DshRequestContextItem {
  order: number
  messageId: string
  role: DshRequestContextRole
  kind: DshRequestContextKind
  title: string
  source: string
  anchor: string
  content: string
}

export interface DshRequestContextSnapshot {
  requestSeq: number
  turn: number
  step: number
  timeMillis: number
  items: DshRequestContextItem[]
}

export function requestContextPath(sessionRoot: string, runtimeThreadId: string): string {
  return join(sessionRoot, 'eleckoi-request-context', `${safeRuntimeThreadFile(runtimeThreadId)}.jsonl`)
}

export function readRequestContextSnapshots(
  sessionRoot: string,
  runtimeThreadId: string
): DshRequestContextSnapshot[] {
  const file = requestContextPath(sessionRoot, runtimeThreadId)
  if (!existsSync(file)) return []
  const definitions = new Map<string, Omit<DshRequestContextItem, 'order'>>()
  const byRequestSeq = new Map<number, DshRequestContextSnapshot>()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as unknown
      if (isRecord(value) && value.type === 'definition') {
        const key = text(value.key)
        const item = parseItem(value, 0)
        if (key && item !== undefined) {
          const { order: _order, ...definition } = item
          definitions.set(key, definition)
        }
        continue
      }
      const parsed = isRecord(value) && value.type === 'request'
        ? parseRequestSnapshot(value, definitions)
        : parseSnapshot(value)
      if (parsed !== undefined) byRequestSeq.set(parsed.requestSeq, parsed)
    } catch {
      continue
    }
  }
  return [...byRequestSeq.values()].sort((left, right) => left.requestSeq - right.requestSeq)
}

function parseRequestSnapshot(
  value: Record<string, unknown>,
  definitions: Map<string, Omit<DshRequestContextItem, 'order'>>
): DshRequestContextSnapshot | undefined {
  const requestSeq = nonnegativeInteger(value.requestSeq)
  const turn = positiveInteger(value.turn)
  const step = positiveInteger(value.step)
  const timeMillis = nonnegativeInteger(value.timeMillis)
  if (requestSeq === undefined || turn === undefined || step === undefined || timeMillis === undefined) return undefined
  const items = Array.isArray(value.items)
    ? value.items.flatMap((value, index) => {
        if (!isRecord(value)) return []
        const definition = definitions.get(text(value.key))
        if (definition === undefined) return []
        return [{ ...definition, order: positiveInteger(value.order) ?? index + 1 }]
      })
    : []
  return { requestSeq, turn, step, timeMillis, items }
}

export function discardRequestContexts(
  sessionRoot: string,
  runtimeThreadIds: readonly string[],
  selectedThreadId: string
): void {
  for (const runtimeThreadId of new Set(runtimeThreadIds)) {
    if (!runtimeThreadId || runtimeThreadId === selectedThreadId) continue
    rmSync(requestContextPath(sessionRoot, runtimeThreadId), { force: true })
  }
}

function parseSnapshot(value: unknown): DshRequestContextSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const requestSeq = nonnegativeInteger(value.requestSeq)
  const turn = positiveInteger(value.turn)
  const step = positiveInteger(value.step)
  const timeMillis = nonnegativeInteger(value.timeMillis)
  if (requestSeq === undefined || turn === undefined || step === undefined || timeMillis === undefined) return undefined
  const items = Array.isArray(value.items)
    ? value.items.flatMap((item, index) => {
        const parsed = parseItem(item, index)
        return parsed === undefined ? [] : [parsed]
      })
    : []
  return { requestSeq, turn, step, timeMillis, items }
}

function parseItem(value: unknown, index: number): DshRequestContextItem | undefined {
  if (!isRecord(value)) return undefined
  const role = value.role === 'system' || value.role === 'assistant' ? value.role : value.role === 'user' ? 'user' : undefined
  const kind = isContextKind(value.kind) ? value.kind : undefined
  const content = text(value.content)
  if (role === undefined || kind === undefined || !content) return undefined
  return {
    order: positiveInteger(value.order) ?? index + 1,
    messageId: text(value.messageId),
    role,
    kind,
    title: text(value.title) || roleLabel(role),
    source: text(value.source),
    anchor: text(value.anchor),
    content
  }
}

function isContextKind(value: unknown): value is DshRequestContextKind {
  return value === 'system' || value === 'prompt' || value === 'history' || value === 'user'
    || value === 'assistant' || value === 'tool' || value === 'context'
}

function roleLabel(role: DshRequestContextRole): string {
  return role === 'system' ? '系统提示词' : role === 'assistant' ? '助手消息' : '用户消息'
}

function safeRuntimeThreadFile(runtimeThreadId: string): string {
  return runtimeThreadId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160) || 'default'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined
}

function nonnegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
}
