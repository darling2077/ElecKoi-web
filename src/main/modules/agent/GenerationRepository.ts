import type { SqliteDatabase } from '@main/platform/sqlite/SqliteDatabase'
import type { ConversationDeleteGuard, MessageRepository } from '@main/modules/conversations'
import type { MessageStatus } from '@shared/contracts/entities/chat'

export class GenerationRepository implements ConversationDeleteGuard {
  constructor(
    private readonly store: SqliteDatabase,
    private readonly messages: Pick<MessageRepository, 'requirePendingResponse'>
  ) {}

  start(id: string, conversationId: string, messageId: string): void {
    this.store.withWriteTx(() => {
      const responseId = this.messages.requirePendingResponse(conversationId, messageId)
      this.store.native.prepare(`INSERT INTO generation_attempts(id,conversationId,ownerId,state)
        VALUES (?,?,?,'running')`).run(id, conversationId, responseId)
    })
  }

  finish(id: string, status: MessageStatus): void {
    this.store.native.prepare(`UPDATE generation_attempts SET state=? WHERE id=? AND state='running'`)
      .run(status === 'complete' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed', id)
  }

  deleteForMessages(conversationId: string, messageIds: readonly string[]): void {
    const ids = [...new Set(messageIds.filter(Boolean))]
    if (ids.length === 0) return
    this.store.withWriteTx(() => {
      const statement = this.store.native.prepare(
        'DELETE FROM generation_attempts WHERE conversationId=? AND ownerId=?'
      )
      for (const id of ids) statement.run(conversationId, id)
    })
  }

  assertCanDelete(conversationId: string): void {
    if (this.store.native.prepare(
      "SELECT 1 FROM generation_attempts WHERE conversationId = ? AND state IN ('queued', 'running') LIMIT 1"
    ).get(conversationId)) {
      throw new Error('请先停止此聊天的生成任务，再删除数据。')
    }
  }
}
