import type Database from 'better-sqlite3'

export function recoverInterruptedState(database: Database.Database): number {
  return database.transaction(() => {
    const result = database.prepare(`UPDATE agent_responses SET status = 'error'
      WHERE status IN ('streaming', 'running', 'pending')`).run()
    database.prepare(`UPDATE generation_attempts SET state = 'failed'
      WHERE state IN ('queued', 'running', 'pending')`).run()
    return result.changes
  }).immediate()
}
