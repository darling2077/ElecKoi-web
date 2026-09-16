import type Database from 'better-sqlite3'

interface LegacyToolConfigRow {
  payloadJson: string
  updatedAt: string
}

interface WebSearchSettingsRow {
  mode: 'provider_native' | 'tavily'
  maxResults: 3 | 5 | 8
  tavilyApiKey: string
  updatedAt: string
}

export const migration0002 = {
  fromVersion: 1,
  toVersion: 2,
  name: 'runtime-clean',
  acceptedBaselines: ['eleckoi-common-v1-2026-09-11-agent-presets'] as const,
  apply(database: Database.Database): void {
    database.exec(`
      DROP TABLE chat_session_model_settings;
      DROP TABLE character_frontend_settings;
      DROP TABLE frontend_projects;
      DROP TABLE agent_conversation_display_cache;

      ALTER TABLE chat_sessions DROP COLUMN workspaceId;
      ALTER TABLE chat_sessions DROP COLUMN permissionMode;

      ALTER TABLE agent_conversations DROP COLUMN surface;
      ALTER TABLE agent_conversations DROP COLUMN createdAt;
      ALTER TABLE agent_conversations DROP COLUMN updatedAt;
      ALTER TABLE agent_conversations DROP COLUMN revision;

      DROP INDEX index_agent_branches_conversationId_createdAt;
      ALTER TABLE agent_branches DROP COLUMN parentBranchId;
      ALTER TABLE agent_branches DROP COLUMN forkedFromTurnId;
      ALTER TABLE agent_branches DROP COLUMN headSequence;
      ALTER TABLE agent_branches DROP COLUMN name;
      ALTER TABLE agent_branches DROP COLUMN reason;
      ALTER TABLE agent_branches DROP COLUMN createdAt;

      DROP INDEX index_agent_turns_conversationId_sourceMessageId;
      ALTER TABLE agent_turns DROP COLUMN sourceMessageId;
      ALTER TABLE agent_turns DROP COLUMN provider;
      ALTER TABLE agent_turns DROP COLUMN model;

      ALTER TABLE agent_responses DROP COLUMN sourceMessageId;
      ALTER TABLE agent_responses DROP COLUMN provider;
      ALTER TABLE agent_responses DROP COLUMN model;
      ALTER TABLE agent_responses DROP COLUMN runtimeTurnId;
      ALTER TABLE agent_responses DROP COLUMN turnStartedAtMillis;
      ALTER TABLE agent_responses DROP COLUMN turnCompletedAtMillis;

      DROP INDEX index_generation_attempts_conversationId_kind_ownerId_attemptNumber;
      DROP INDEX index_generation_attempts_parentAttemptId;
      DROP INDEX index_generation_attempts_outputMessageId;
      ALTER TABLE generation_attempts DROP COLUMN kind;
      ALTER TABLE generation_attempts DROP COLUMN parentAttemptId;
      ALTER TABLE generation_attempts DROP COLUMN outputMessageId;
      ALTER TABLE generation_attempts DROP COLUMN attemptNumber;
      ALTER TABLE generation_attempts DROP COLUMN createdAtMillis;
      ALTER TABLE generation_attempts DROP COLUMN startedAtMillis;
      ALTER TABLE generation_attempts DROP COLUMN finishedAtMillis;
      ALTER TABLE generation_attempts DROP COLUMN errorMessage;
      ALTER TABLE generation_attempts DROP COLUMN outputPath;
      ALTER TABLE generation_attempts DROP COLUMN supersededByAttemptId;
      CREATE UNIQUE INDEX IF NOT EXISTS \`index_generation_attempts_conversationId_ownerId\`
        ON \`generation_attempts\` (\`conversationId\`, \`ownerId\`);
    `)
    applyCurrentStorageCleanup(database)
  }
} as const

export function isLegacyDevelopmentV2Storage(database: Database.Database): boolean {
  return tableExists(database, 'global_tool_config')
    && !tableExists(database, 'web_search_settings')
    && columnExists(database, 'chat_sessions', 'characterMode')
    && columnExists(database, 'characters', 'characterMode')
    && columnExists(database, 'agent_presets', 'usageInstructions')
}

export function applyCurrentStorageCleanup(database: Database.Database): void {
  database.exec('CREATE TABLE `web_search_settings` (`singletonId` INTEGER NOT NULL, `mode` TEXT NOT NULL, `maxResults` INTEGER NOT NULL, `tavilyApiKey` TEXT NOT NULL, `updatedAt` TEXT NOT NULL, PRIMARY KEY(`singletonId`));')

  const legacyToolConfig = database.prepare(
    'SELECT payloadJson, updatedAt FROM global_tool_config WHERE singletonId = 1'
  ).get() as LegacyToolConfigRow | undefined
  if (legacyToolConfig) {
    const webSearch = readLegacyWebSearchSettings(legacyToolConfig)
    database.prepare(`INSERT INTO web_search_settings(
      singletonId, mode, maxResults, tavilyApiKey, updatedAt
    ) VALUES (1, ?, ?, ?, ?)`)
      .run(webSearch.mode, webSearch.maxResults, webSearch.tavilyApiKey, webSearch.updatedAt)
  }

  database.exec(`
    INSERT INTO agent_preset_contents(presetId, kind, content)
      SELECT id, 'usage_instructions', usageInstructions FROM agent_presets
      WHERE true
      ON CONFLICT(presetId, kind) DO UPDATE SET content = excluded.content;

    INSERT INTO agent_preset_version_contents(presetId, versionId, kind, content)
      SELECT version.presetId, version.versionId, 'usage_instructions', preset.usageInstructions
      FROM agent_preset_versions AS version
      JOIN agent_presets AS preset ON preset.id = version.presetId
      WHERE true
      ON CONFLICT(presetId, versionId, kind) DO UPDATE SET content = excluded.content;

    ALTER TABLE chat_sessions DROP COLUMN characterMode;
    ALTER TABLE characters DROP COLUMN characterMode;
    ALTER TABLE agent_presets DROP COLUMN usageInstructions;
    DROP TABLE global_tool_config;
  `)
}

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

function columnExists(database: Database.Database, table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[])
    .some((item) => item.name === column)
}

function readLegacyWebSearchSettings(row: LegacyToolConfigRow): WebSearchSettingsRow {
  let value: unknown
  try {
    value = JSON.parse(row.payloadJson)
  } catch (error) {
    throw new Error('旧联网搜索配置已损坏，无法整理。', { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('旧联网搜索配置不是对象，无法整理。')
  }
  const webSearch = (value as Record<string, unknown>).webSearch
  if (webSearch === undefined) {
    return { mode: 'provider_native', maxResults: 5, tavilyApiKey: '', updatedAt: row.updatedAt }
  }
  if (!webSearch || typeof webSearch !== 'object' || Array.isArray(webSearch)) {
    throw new Error('旧联网搜索配置格式无效，无法整理。')
  }
  const source = webSearch as Record<string, unknown>
  const mode = source.mode
  const maxResults = source.maxResults
  if (mode !== 'provider_native' && mode !== 'tavily') throw new Error('旧联网搜索模式无效，无法整理。')
  if (maxResults !== 3 && maxResults !== 5 && maxResults !== 8) throw new Error('旧联网搜索结果数量无效，无法整理。')
  if (typeof source.tavilyApiKey !== 'string') throw new Error('旧 Tavily 凭据格式无效，无法整理。')
  return { mode, maxResults, tavilyApiKey: source.tavilyApiKey, updatedAt: row.updatedAt }
}
