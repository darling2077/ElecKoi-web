import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { Conversation, ConversationMetadata, OpeningMessageOption } from '@shared/contracts/entities/chat'
import { parseJsonObject } from '@shared/foundation/json'
import { requireCharacter } from '@main/modules/personas'
import { type ElecKoiDatabase, SqliteDatabase } from '@main/platform/sqlite/SqliteDatabase'
import {
  agentBranches,
  agentBranchTurns,
  agentConversations,
  agentTurns,
  chatSessions,
  chatSessionCharacterSnapshots,
  conversationSpeakers,
  userProfile
} from '@main/platform/sqlite/schema/common'
import type { ConversationCleanupRepository } from './ConversationCleanupRepository'
import type { ConversationSeed } from './conversationSeed'
import { seedConversationVariableStates } from './ConversationVariableStateStore'

const emptyMetadata = (): ConversationMetadata => ({ characterId: '', characterName: '', characterAvatar: '', characterPersona: {} })
const toConversation = (row: typeof chatSessions.$inferSelect, preview = row.historySummary): Conversation => ({ id: row.id, title: row.title, preview, createdAt: row.createdAt, updatedAt: row.updatedAt })

export interface ConversationDeleteCleanup {
  enqueue(conversationId: string): void
  drain(): void
}

export interface ConversationDeleteGuard {
  assertCanDelete(conversationId: string): void
}

export interface ConversationDeleteParticipant {
  prepareForDelete(conversationId: string): Promise<void>
  finishDelete(conversationId: string): void
}

export class ConversationRepository {
  private readonly deleteCleanups = new Set<ConversationDeleteCleanup>()
  private readonly deleteGuards = new Set<ConversationDeleteGuard>()
  private readonly deleteParticipants = new Set<ConversationDeleteParticipant>()
  private readonly pendingDeletes = new Map<string, Promise<void>>()

  constructor(
    private readonly store: SqliteDatabase,
    private readonly cleanup?: ConversationCleanupRepository,
    private readonly resolveSeed?: (
      characterId: string,
      db: ElecKoiDatabase
    ) => string | ConversationSeed
  ) {}

  ensure(): Conversation { return this.list()[0]?.conversation ?? this.create({}).conversation }

  registerDeleteCleanup(cleanup: ConversationDeleteCleanup): () => void {
    this.deleteCleanups.add(cleanup)
    return () => this.deleteCleanups.delete(cleanup)
  }

  registerDeleteGuard(guard: ConversationDeleteGuard): () => void {
    this.deleteGuards.add(guard)
    return () => this.deleteGuards.delete(guard)
  }

  registerDeleteParticipant(participant: ConversationDeleteParticipant): () => void {
    this.deleteParticipants.add(participant)
    return () => this.deleteParticipants.delete(participant)
  }

  create(input: { title?: string | undefined; metadata?: { [K in keyof ConversationMetadata]?: ConversationMetadata[K] | undefined } | undefined }, db?: ElecKoiDatabase) {
    const operation = (database: ElecKoiDatabase) => {
      const now = new Date().toISOString()
      const id = randomUUID()
      const branchId = randomUUID()
      const metadata: ConversationMetadata = {
        characterId: input.metadata?.characterId ?? '', characterName: input.metadata?.characterName ?? '',
        characterAvatar: input.metadata?.characterAvatar ?? '', characterPersona: input.metadata?.characterPersona ?? {}
      }
      const card = metadata.characterId ? requireCharacter(database, metadata.characterId) : undefined
      const resolvedSeed = card && this.resolveSeed
        ? this.resolveSeed(card.id, database)
        : '{}'
      const seed: ConversationSeed = typeof resolvedSeed === 'string'
        ? { initialVariableStateJson: resolvedSeed, openingText: '', openingOptions: [], selectedOpeningId: '' }
        : resolvedSeed
      const variableStateJson = seed.initialVariableStateJson || '{}'
      database.insert(chatSessions).values({
        id, title: input.title?.trim() || '新对话', characterId: metadata.characterId,
        characterName: card?.name ?? metadata.characterName, characterAvatar: card?.avatar ?? metadata.characterAvatar,
        historySummary: '',
        historyMessageCount: 0, historyUserMessageCount: 0, createdAt: now, updatedAt: now
      }).run()
      database.insert(agentConversations).values({ id, activeBranchId: branchId }).run()
      database.insert(agentBranches).values({ id: branchId, conversationId: id }).run()
      database.insert(chatSessionCharacterSnapshots).values({ sessionId: id, personaJson: JSON.stringify(metadata.characterPersona) }).run()
      seedConversationVariableStates(id, variableStateJson, database)
      if (seed.openingText) this.insertOpening(database, {
        conversationId: id,
        branchId,
        sourceSpeakerId: card?.id || 'assistant',
        speakerName: card?.name || metadata.characterName || 'ElecKoi',
        speakerAvatar: card?.avatar || metadata.characterAvatar,
        content: seed.openingText,
        openingOptions: seed.openingOptions,
        selectedOpeningId: seed.selectedOpeningId,
        variableStateJson,
        createdAt: now
      })
      return { conversation: this.get(id, database), metadata: this.getMetadata(id, database) }
    }
    return db ? operation(db) : this.store.withWriteTx(operation)
  }

  list(): Array<{ conversation: Conversation; metadata: ConversationMetadata }> {
    return this.store.db.select().from(chatSessions).orderBy(desc(chatSessions.updatedAt), desc(chatSessions.id)).all()
      .map((row) => ({ conversation: toConversation(row, this.preview(row)), metadata: { ...emptyMetadata(), characterId: row.characterId, characterName: row.characterName, characterAvatar: row.characterAvatar } }))
  }

  get(id: string, db: ElecKoiDatabase = this.store.db): Conversation {
    const row = db.select().from(chatSessions).where(eq(chatSessions.id, id)).get()
    if (!row) throw new Error('找不到对应的聊天存档。')
    return toConversation(row, this.preview(row))
  }

  getCharacterBinding(id: string, db: ElecKoiDatabase = this.store.db): {
    characterId: string
  } {
    const row = db.select({
      characterId: chatSessions.characterId
    }).from(chatSessions).where(eq(chatSessions.id, id)).get()
    if (!row) throw new Error('找不到对应的聊天存档。')
    return row
  }

  private preview(row: typeof chatSessions.$inferSelect): string {
    if (row.historySummary.trim()) return row.historySummary
    const parts = this.store.native.prepare(`SELECT p.text FROM agent_content_parts p
      JOIN agent_turns t ON t.id=p.ownerId AND p.ownerType='turn'
      WHERE p.conversationId=? AND t.kind='opening' AND p.kind='opening_text'
      ORDER BY p.partIndex,p.chunkIndex`).all(row.id) as { text: string }[]
    return parts.map((part) => part.text).join('').trim()
  }

  exists(id: string, db: ElecKoiDatabase = this.store.db): boolean {
    return !!db.select({ id: chatSessions.id }).from(chatSessions).where(eq(chatSessions.id, id)).get()
  }

  getMetadata(id: string, db: ElecKoiDatabase = this.store.db): ConversationMetadata {
    const session = db.select().from(chatSessions).where(eq(chatSessions.id, id)).get()
    if (!session) throw new Error('找不到对应的聊天存档。')
    const snapshot = db.select().from(chatSessionCharacterSnapshots).where(eq(chatSessionCharacterSnapshots.sessionId, id)).get()
    const profile = db.select().from(userProfile).where(eq(userProfile.id, 'default')).get()
    const characterPersona = parseJsonObject(snapshot?.personaJson ?? '{}')
    return { characterId: session.characterId, characterName: session.characterName, characterAvatar: session.characterAvatar,
      characterPersona: {
        ...characterPersona,
        user_name: profile?.userName ?? '你',
        user_avatar: profile?.userAvatar ?? '',
        user_square: profile?.userSquare ?? '',
        user_portrait: profile?.userPortrait ?? '',
        user_cover: profile?.userCover ?? ''
      } }
  }

  delete(id: string): Promise<void> {
    const pending = this.pendingDeletes.get(id)
    if (pending !== undefined) return pending
    const deletion = this.deleteOnce(id).finally(() => {
      if (this.pendingDeletes.get(id) === deletion) this.pendingDeletes.delete(id)
    })
    this.pendingDeletes.set(id, deletion)
    return deletion
  }

  private async deleteOnce(id: string): Promise<void> {
    if (!this.exists(id)) {
      this.flushCleanup()
      return
    }
    const participants = [...this.deleteParticipants]
    try {
      for (const participant of participants) await participant.prepareForDelete(id)
      this.store.withWriteTx(() => this.deleteInTransaction(id))
      this.flushCleanup()
    } finally {
      for (const participant of participants.reverse()) participant.finishDelete(id)
    }
  }

  private deleteInTransaction(id: string): void {
    for (const guard of this.deleteGuards) guard.assertCanDelete(id)
    if (this.exists(id)) {
      this.cleanup?.enqueue(id)
      for (const cleanup of this.deleteCleanups) cleanup.enqueue(id)
    }
    this.store.native.prepare('DELETE FROM agent_conversations WHERE id = ?').run(id)
    this.store.native.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id)
  }

  flushCleanup(): void {
    this.cleanup?.drain()
    for (const cleanup of this.deleteCleanups) cleanup.drain()
  }

  deleteForCharacter(characterId: string): void {
    this.store.withWriteTx(() => {
      const sessions = this.store.db.select({ id: chatSessions.id }).from(chatSessions).where(eq(chatSessions.characterId, characterId)).all()
      for (const { id } of sessions) this.deleteInTransaction(id)
    })
    this.flushCleanup()
  }

  upsertMetadata(id: string, metadata: ConversationMetadata, db?: ElecKoiDatabase): void {
    const operation = (database: ElecKoiDatabase) => {
      const previous = this.getMetadata(id, database)
      if (metadata.characterId !== previous.characterId) throw new Error('不能更改已有存档所属角色。')
      const value = JSON.stringify(metadata.characterPersona)
      if (value === JSON.stringify(previous.characterPersona)) return
      database.insert(chatSessionCharacterSnapshots).values({ sessionId: id, personaJson: value })
        .onConflictDoUpdate({ target: chatSessionCharacterSnapshots.sessionId, set: { personaJson: value } }).run()
    }
    if (db) operation(db)
    else this.store.withWriteTx(operation)
  }

  titleFromFirstMessage(id: string, text: string, db: ElecKoiDatabase = this.store.db): Conversation {
    const current = this.get(id, db)
    if (current.title !== '新对话') return current
    const title = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, 24).join('') || '新对话'
    db.update(chatSessions).set({ title, updatedAt: new Date().toISOString() }).where(and(eq(chatSessions.id, id), eq(chatSessions.title, '新对话'))).run()
    return this.get(id, db)
  }

  touch(id: string, preview?: string, db: ElecKoiDatabase = this.store.db): Conversation {
    const changes: { updatedAt: string; historySummary?: string } = { updatedAt: new Date().toISOString() }
    if (preview !== undefined) changes.historySummary = Array.from(preview).slice(0, 240).join('')
    db.update(chatSessions).set(changes).where(eq(chatSessions.id, id)).run()
    return this.get(id, db)
  }

  refreshCharacterIdentity(characterId: string, identity: {
    name: string
    avatar: string
    square: string
    portrait: string
  }, db: ElecKoiDatabase = this.store.db): void {
    db.update(chatSessions).set({ characterName: identity.name, characterAvatar: identity.avatar })
      .where(eq(chatSessions.characterId, characterId)).run()
    db.update(conversationSpeakers).set({ displayName: identity.name, avatarAssetId: identity.avatar })
      .where(eq(conversationSpeakers.sourceSpeakerId, characterId)).run()
    const sessions = db.select({ id: chatSessions.id }).from(chatSessions).where(eq(chatSessions.characterId, characterId)).all()
    for (const session of sessions) {
      const snapshot = db.select().from(chatSessionCharacterSnapshots)
        .where(eq(chatSessionCharacterSnapshots.sessionId, session.id)).get()
      if (!snapshot) continue
      const persona = parseJsonObject(snapshot.personaJson)
      const next = JSON.stringify({
        ...persona,
        assistant_name: identity.name,
        assistant_avatar: identity.avatar,
        assistant_square: identity.square,
        assistant_cover: identity.portrait
      })
      if (next !== snapshot.personaJson) db.update(chatSessionCharacterSnapshots).set({ personaJson: next })
        .where(eq(chatSessionCharacterSnapshots.sessionId, session.id)).run()
    }
  }

  refreshUserIdentity(identity: {
    name: string
    avatar: string
    square: string
    portrait: string
  }, db: ElecKoiDatabase = this.store.db): void {
    db.update(conversationSpeakers).set({ displayName: identity.name, avatarAssetId: identity.avatar })
      .where(eq(conversationSpeakers.sourceSpeakerId, 'user')).run()
    const snapshots = db.select().from(chatSessionCharacterSnapshots).all()
    for (const snapshot of snapshots) {
      const persona = parseJsonObject(snapshot.personaJson)
      const next = JSON.stringify({
        ...persona,
        user_name: identity.name,
        user_avatar: identity.avatar,
        user_square: identity.square,
        user_portrait: identity.portrait
      })
      if (next !== snapshot.personaJson) db.update(chatSessionCharacterSnapshots).set({ personaJson: next })
        .where(eq(chatSessionCharacterSnapshots.sessionId, snapshot.sessionId)).run()
    }
  }

  selectOpening(conversationId: string, openingId: string): void {
    this.store.withWriteTx((database) => {
      const session = database.select({ userMessages: chatSessions.historyUserMessageCount })
        .from(chatSessions).where(eq(chatSessions.id, conversationId)).get()
      if (!session) throw new Error('找不到对应的聊天存档。')
      if (session.userMessages > 0) throw new Error('对话开始后不能再切换开场白。')
      const row = this.store.native.prepare(`SELECT p.ownerId,p.payloadJson FROM agent_content_parts p
        JOIN agent_turns t ON t.id=p.ownerId AND p.ownerType='turn'
        WHERE p.conversationId=? AND t.kind='opening' AND p.kind='opening_text' AND p.partIndex=0 AND p.chunkIndex=0`)
        .get(conversationId) as { ownerId: string; payloadJson: string } | undefined
      if (!row) throw new Error('当前对话没有开场白。')
      const payload = JSON.parse(row.payloadJson || '{}') as { options?: OpeningMessageOption[]; selectedId?: string }
      const option = payload.options?.find((candidate) => candidate.id === openingId)
      if (!option) throw new Error('找不到这条开场白。')
      this.writeOpeningText(conversationId, row.ownerId, option.content, JSON.stringify({ options: payload.options, selectedId: option.id }))
      const stateJson = option.initialVariableStateJson || '{}'
      seedConversationVariableStates(conversationId, stateJson, database)
      const now = new Date().toISOString()
      database.update(agentTurns).set({ variableStateJson: stateJson }).where(eq(agentTurns.id, row.ownerId)).run()
      database.update(chatSessions).set({ updatedAt: now }).where(eq(chatSessions.id, conversationId)).run()
    })
  }

  updateOpening(conversationId: string, content: string): void {
    const nextContent = content.trim()
    if (!nextContent) throw new Error('开场白不能为空。')
    this.store.withWriteTx((database) => {
      const session = database.select({ userMessages: chatSessions.historyUserMessageCount })
        .from(chatSessions).where(eq(chatSessions.id, conversationId)).get()
      if (!session) throw new Error('找不到对应的聊天存档。')
      if (session.userMessages > 0) throw new Error('对话开始后不能修改开场白。')
      const row = this.store.native.prepare(`SELECT p.ownerId,p.payloadJson FROM agent_content_parts p
        JOIN agent_turns t ON t.id=p.ownerId AND p.ownerType='turn'
        WHERE p.conversationId=? AND t.kind='opening' AND p.kind='opening_text' AND p.partIndex=0 AND p.chunkIndex=0`)
        .get(conversationId) as { ownerId: string; payloadJson: string } | undefined
      if (!row) throw new Error('当前对话没有开场白。')
      let payload: { options?: OpeningMessageOption[]; selectedId?: string } = {}
      try { payload = JSON.parse(row.payloadJson || '{}') as typeof payload } catch { payload = {} }
      const options = Array.isArray(payload.options) ? payload.options.map((option) => ({ ...option })) : []
      const selectedId = payload.selectedId || options[0]?.id || ''
      const selected = options.find((option) => option.id === selectedId)
      if (selected) selected.content = nextContent
      this.writeOpeningText(conversationId, row.ownerId, nextContent, JSON.stringify({ options, selectedId }))
      const now = new Date().toISOString()
      database.update(agentTurns).set({ variableStateJson: selected?.initialVariableStateJson || '{}' }).where(eq(agentTurns.id, row.ownerId)).run()
      database.update(chatSessions).set({ updatedAt: now }).where(eq(chatSessions.id, conversationId)).run()
    })
  }

  private insertOpening(database: ElecKoiDatabase, input: {
    conversationId: string
    branchId: string
    sourceSpeakerId: string
    speakerName: string
    speakerAvatar: string
    content: string
    openingOptions: OpeningMessageOption[]
    selectedOpeningId: string
    variableStateJson: string
    createdAt: string
  }): void {
    const turnId = randomUUID()
    const speakerId = randomUUID()
    database.insert(conversationSpeakers).values({
      id: speakerId,
      conversationId: input.conversationId,
      sourceSpeakerId: input.sourceSpeakerId,
      kind: input.sourceSpeakerId === 'assistant' ? 'assistant' : 'card_character',
      displayName: input.speakerName,
      avatarAssetId: input.speakerAvatar
    }).run()
    database.insert(agentTurns).values({
      id: turnId,
      conversationId: input.conversationId,
      speakerId,
      kind: 'opening',
      createdAt: input.createdAt,
      variableStateJson: input.variableStateJson
    }).run()
    database.insert(agentBranchTurns).values({ branchId: input.branchId, sequence: 0, turnId }).run()
    this.writeOpeningText(
      input.conversationId,
      turnId,
      input.content,
      JSON.stringify({ options: input.openingOptions, selectedId: input.selectedOpeningId })
    )
    database.update(chatSessions).set({ historyMessageCount: 1 }).where(eq(chatSessions.id, input.conversationId)).run()
  }

  private writeOpeningText(conversationId: string, ownerId: string, content: string, payloadJson: string): void {
    this.store.native.prepare("DELETE FROM agent_content_parts WHERE conversationId=? AND ownerType='turn' AND ownerId=? AND kind='opening_text'").run(conversationId, ownerId)
    const chunks = splitContent(content)
    chunks.forEach((text, chunkIndex) => this.store.native.prepare(`INSERT INTO agent_content_parts
      (conversationId,ownerType,ownerId,partIndex,kind,text,payloadJson,chunkIndex) VALUES (?,'turn',?,0,'opening_text',?,?,?)`)
      .run(conversationId, ownerId, text, payloadJson, chunkIndex))
  }

}

function splitContent(content: string): string[] {
  const size = 64 * 1024
  const chunks: string[] = []
  let offset = 0
  do {
    let end = Math.min(offset + size, content.length)
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(content[end] ?? '')) end--
    chunks.push(content.slice(offset, end))
    offset = end
  } while (offset < content.length)
  return chunks
}
