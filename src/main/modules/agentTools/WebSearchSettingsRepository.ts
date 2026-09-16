import { eq } from 'drizzle-orm'
import type { CredentialCipher } from '@main/platform/electron/CredentialCipher'
import { type ElecKoiDatabase, SqliteDatabase } from '@main/platform/sqlite/SqliteDatabase'
import { webSearchSettings } from '@main/platform/sqlite/schema/common'
import {
  webSearchSettingsSchema,
  webSearchSettingsUpdateSchema,
  type WebSearchSettings,
  type WebSearchSettingsUpdate
} from '@shared/contracts/agent/webSearch'

const SINGLETON_ID = 1

interface StoredWebSearchSettings {
  mode: WebSearchSettings['mode']
  maxResults: WebSearchSettings['maxResults']
  tavilyApiKey: string
}

export interface WebSearchRuntimeSettings {
  mode: WebSearchSettings['mode']
  maxResults: WebSearchSettings['maxResults']
  tavilyApiKey: string
}

export class WebSearchSettingsRepository {
  constructor(private readonly store: SqliteDatabase, private readonly cipher: CredentialCipher) {}

  read(db: ElecKoiDatabase = this.store.db): WebSearchSettings {
    const stored = this.readStored(db)
    return webSearchSettingsSchema.parse({
      mode: stored.mode,
      maxResults: stored.maxResults,
      apiKeyConfigured: stored.tavilyApiKey.length > 0
    })
  }

  update(input: WebSearchSettingsUpdate): WebSearchSettings {
    const parsed = webSearchSettingsUpdateSchema.parse(input)
    return this.store.withWriteTx((database) => {
      const stored = this.readStored(database)
      this.writeStored({ ...stored, mode: parsed.mode, maxResults: parsed.maxResults }, database)
      return this.read(database)
    })
  }

  saveTavilyApiKey(apiKey: string): WebSearchSettings {
    const normalized = validateApiKey(apiKey)
    return this.store.withWriteTx((database) => {
      const stored = this.readStored(database)
      this.writeStored({ ...stored, tavilyApiKey: this.cipher.encrypt(normalized) }, database)
      return this.read(database)
    })
  }

  removeTavilyApiKey(): WebSearchSettings {
    return this.store.withWriteTx((database) => {
      const stored = this.readStored(database)
      this.writeStored({ ...stored, tavilyApiKey: '' }, database)
      return this.read(database)
    })
  }

  runtimeSettings(db: ElecKoiDatabase = this.store.db): WebSearchRuntimeSettings {
    const stored = this.readStored(db)
    return {
      mode: stored.mode,
      maxResults: stored.maxResults,
      tavilyApiKey: stored.tavilyApiKey ? this.cipher.decrypt(stored.tavilyApiKey) : ''
    }
  }

  tavilyApiKey(db: ElecKoiDatabase = this.store.db): string {
    return this.runtimeSettings(db).tavilyApiKey
  }

  private readStored(db: ElecKoiDatabase): StoredWebSearchSettings {
    const row = db.select().from(webSearchSettings).where(eq(webSearchSettings.singletonId, SINGLETON_ID)).get()
    if (!row) return defaultStoredConfig()
    const settings = webSearchSettingsSchema.parse({
      mode: row.mode,
      maxResults: row.maxResults,
      apiKeyConfigured: row.tavilyApiKey.length > 0
    })
    return {
      mode: settings.mode,
      maxResults: settings.maxResults,
      tavilyApiKey: row.tavilyApiKey
    }
  }

  private writeStored(value: StoredWebSearchSettings, db: ElecKoiDatabase): void {
    const row = {
      singletonId: SINGLETON_ID,
      mode: value.mode,
      maxResults: value.maxResults,
      tavilyApiKey: value.tavilyApiKey,
      updatedAt: new Date().toISOString()
    }
    db.insert(webSearchSettings).values(row).onConflictDoUpdate({
      target: webSearchSettings.singletonId,
      set: { mode: row.mode, maxResults: row.maxResults, tavilyApiKey: row.tavilyApiKey, updatedAt: row.updatedAt }
    }).run()
  }
}

function defaultStoredConfig(): StoredWebSearchSettings {
  return { mode: 'provider_native', maxResults: 5, tavilyApiKey: '' }
}

function validateApiKey(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error('请先填写 Tavily API Key。')
  if (normalized.length > 2_048) throw new Error('Tavily API Key 长度无效。')
  return normalized
}
