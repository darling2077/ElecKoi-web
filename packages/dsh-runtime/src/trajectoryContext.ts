import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { DshConversationContext } from './types'

const DEFINITION_TYPE = 'context/definition'
const ACTIVATION_TYPE = 'context/activation'
const knownDefinitionKeys = new Map<string, Set<string>>()

export interface DshTrajectoryContextEntry {
  key: string
  id: string
  title: string
  source: string
  anchor: string
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface DshTrajectoryContextActivation {
  turn: number
  time: number
  entries: DshTrajectoryContextEntry[]
}

export function trajectoryContextEntries(context?: DshConversationContext): DshTrajectoryContextEntry[] {
  const library = context?.settingLibrary
  if (library === undefined) return []
  const positions = new Map(library.promptPositions.map((value) => [text(value.id), value]))
  return library.entries
    .filter((value) => value.enabled === true
      && text(value.content).trim().length > 0
      && value.kind !== 'opening'
      && value.kind !== 'history_compaction'
      && (value.triggerMode === 'cache' || (value.triggerMode === 'always' && text(value.position))))
    .map((value) => {
      const custom = positions.get(text(value.promptPositionId))
      const anchor = value.triggerMode === 'cache' ? 'insert_point_1' : text(custom?.anchor) || text(value.position)
      const entryTitle = text(value.title).trim() || '未命名设定'
      const rank = value.triggerMode === 'cache'
        ? 3
        : custom?.side === 'before_setting_position' ? 0 : custom?.side === 'after_setting_position' ? 2 : 1
      const entry = {
        id: text(value.id).slice(0, 128),
        title: value.triggerMode === 'cache'
          ? `缓存设定 · ${entryTitle}`
          : value.kind === 'hidden_tool_timeline'
            ? `预设固定条目 · ${entryTitle}`
            : text(value.id).startsWith('agent-preset:')
              ? `预设条目 · ${entryTitle}`
              : `设定 · ${entryTitle}`,
        source: text(custom?.name).trim() || positionLabel(anchor),
        anchor,
        role: anchor === 'instructions' ? 'system' as const : value.insertRole === 'assistant' ? 'assistant' as const : 'user' as const,
        content: text(value.content).slice(0, 40_000),
        rank,
        positionOrder: integer(custom?.order, 0),
        order: integer(value.order, 1)
      }
      return { ...entry, key: contextEntryKey(entry) }
    })
    .sort((left, right) => anchorOrder(left.anchor) - anchorOrder(right.anchor)
      || left.rank - right.rank
      || left.positionOrder - right.positionOrder
      || left.order - right.order
      || left.id.localeCompare(right.id))
    .slice(0, 128)
    .map(({ rank: _rank, positionOrder: _positionOrder, order: _order, ...entry }) => entry)
}

export function appendTrajectoryContextActivation(
  sessionRoot: string,
  runtimeThreadId: string,
  activation: DshTrajectoryContextActivation
): void {
  if (activation.entries.length === 0) return
  const file = trajectoryContextPath(sessionRoot, runtimeThreadId)
  mkdirSync(join(sessionRoot, 'eleckoi-trajectory-context'), { recursive: true })
  const known = knownDefinitionKeys.get(file) ?? readDefinitionKeys(file)
  knownDefinitionKeys.set(file, known)
  const rows: Record<string, unknown>[] = []
  for (const entry of activation.entries) {
    if (known.has(entry.key)) continue
    known.add(entry.key)
    rows.push({ type: DEFINITION_TYPE, ...entry })
  }
  rows.push({
    type: ACTIVATION_TYPE,
    turn: activation.turn,
    time: activation.time,
    keys: activation.entries.map((entry) => entry.key)
  })
  appendFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

export function readTrajectoryContextActivations(
  sessionRoot: string,
  runtimeThreadId: string
): DshTrajectoryContextActivation[] {
  const file = trajectoryContextPath(sessionRoot, runtimeThreadId)
  if (!existsSync(file)) return []
  const definitions = new Map<string, DshTrajectoryContextEntry>()
  const byTurn = new Map<number, DshTrajectoryContextActivation>()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (value.type === DEFINITION_TYPE) {
        const entry = parseDefinition(value)
        if (entry !== undefined) definitions.set(entry.key, entry)
        continue
      }
      if (value.type !== ACTIVATION_TYPE || !Number.isSafeInteger(value.turn) || (value.turn as number) < 1) continue
      const entries = Array.isArray(value.keys)
        ? value.keys.flatMap((key) => typeof key === 'string' && definitions.has(key) ? [definitions.get(key)!] : [])
        : []
      if (entries.length === 0) continue
      byTurn.set(value.turn as number, {
        turn: value.turn as number,
        time: integer(value.time, 0),
        entries
      })
    } catch {
      continue
    }
  }
  knownDefinitionKeys.set(file, new Set(definitions.keys()))
  return [...byTurn.values()].sort((left, right) => left.time - right.time || left.turn - right.turn)
}

export function discardTrajectoryContextActivations(
  sessionRoot: string,
  runtimeThreadIds: readonly string[],
  selectedThreadId: string
): void {
  for (const runtimeThreadId of new Set(runtimeThreadIds)) {
    if (!runtimeThreadId || runtimeThreadId === selectedThreadId) continue
    const file = trajectoryContextPath(sessionRoot, runtimeThreadId)
    knownDefinitionKeys.delete(file)
    rmSync(file, { force: true })
  }
}

function parseDefinition(value: Record<string, unknown>): DshTrajectoryContextEntry | undefined {
  const key = text(value.key)
  const content = text(value.content)
  if (!key || !content.trim()) return undefined
  return {
    key,
    id: text(value.id),
    title: text(value.title) || '上下文注入',
    source: text(value.source),
    anchor: text(value.anchor),
    role: value.role === 'assistant' || value.role === 'system' ? value.role : 'user',
    content
  }
}

function readDefinitionKeys(file: string): Set<string> {
  if (!existsSync(file)) return new Set()
  const keys = new Set<string>()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (value.type === DEFINITION_TYPE && text(value.key)) keys.add(text(value.key))
    } catch {
      continue
    }
  }
  return keys
}

function contextEntryKey(entry: Record<string, unknown>): string {
  return createHash('sha256').update([
    entry.id,
    entry.title,
    entry.source,
    entry.anchor,
    entry.role,
    entry.content
  ].join('\0')).digest('hex')
}

function trajectoryContextPath(sessionRoot: string, runtimeThreadId: string): string {
  return join(sessionRoot, 'eleckoi-trajectory-context', `${threadKey(runtimeThreadId)}.jsonl`)
}

function threadKey(runtimeThreadId: string): string {
  return createHash('sha256').update(runtimeThreadId).digest('hex')
}

function anchorOrder(anchor: string): number {
  const index = ['instructions', 'insert_point_1', 'insert_point_2', 'insert_point_3', 'insert_point_4', 'insert_point_5'].indexOf(anchor)
  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}

function positionLabel(anchor: string): string {
  return ({
    instructions: '系统指令', insert_point_1: '设定插入点 1', insert_point_2: '设定插入点 2',
    insert_point_3: '设定插入点 3', insert_point_4: '设定插入点 4', insert_point_5: '设定插入点 5'
  } as Record<string, string>)[anchor] ?? '设定位置'
}

function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function integer(value: unknown, fallback: number): number { return Number.isSafeInteger(value) ? value as number : fallback }
