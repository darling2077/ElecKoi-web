import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readSessionSnapshot(root, sessionId) {
  if (!root) throw new Error('ELECKOI_SESSION_SNAPSHOT_ROOT is required')
  const safeId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160) || 'default'
  const value = JSON.parse(readFileSync(join(root, `${safeId}.json`), 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ElecKoi Session snapshot: ${sessionId}`)
  }
  return value
}
