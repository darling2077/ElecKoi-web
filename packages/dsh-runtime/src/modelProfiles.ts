import { createHash } from 'node:crypto'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider
} from '@earendil-works/pi-ai/providers/all'
import type { PiAiModelProfile, PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { DshModelIdentity, DshModelSettings, DshReasoningEffort } from './types'

type CatalogModel = ReturnType<typeof getBuiltinModels>[number]

export interface DshModelCapabilities {
  provider: string | null
  source: 'dsh_catalog' | 'provider_default'
  reasoningEfforts: DshReasoningEffort[]
}

export interface DshProviderBinding {
  provider: string
  model: string
  reasoningEffort?: DshReasoningEffort | undefined
}

export type DshProviderProfile = PiAiProviderProfile

export interface DshProviderCatalog {
  providers: Record<string, DshProviderProfile>
  credentials: Record<string, string>
  bindings: Record<string, DshProviderBinding>
}

/** @deprecated Small facade retained for focused provider-profile callers. */
export interface DshProviderPlan {
  providers: Record<string, DshProviderProfile>
  main: DshProviderBinding
  subagent: DshProviderBinding
}

interface NativeMatch {
  provider: BuiltinProvider
  model: CatalogModel
}

interface ConnectionGroup {
  settings: DshModelSettings[]
  native: NativeMatch | undefined
  connectionKey: string
  provider: string
  apiKeyEnv: string
}

const reasoningEfforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export function describeDshModelCapabilities(identity: DshModelIdentity): DshModelCapabilities {
  const native = findNativeModel(identity)
  return native === undefined
    ? { provider: null, source: 'provider_default', reasoningEfforts: [] }
    : {
        provider: native.provider,
        source: 'dsh_catalog',
        reasoningEfforts: supportedReasoningEfforts(native.model)
      }
}

/** Builds the immutable process-wide provider directory used by every Session. */
export function createDshProviderCatalog(settingsList: readonly DshModelSettings[]): DshProviderCatalog {
  const uniqueSettings = deduplicateSettings(settingsList)
  if (uniqueSettings.length === 0) throw new Error('DSH provider catalog requires at least one model configuration.')

  const connectionGroups = new Map<string, ConnectionGroup>()
  const nativeConnectionCounts = new Map<string, Set<string>>()
  for (const settings of uniqueSettings) {
    const native = findNativeModel(settings)
    const connectionKey = providerConnectionKey(settings, native)
    if (native !== undefined) {
      const keys = nativeConnectionCounts.get(native.provider) ?? new Set<string>()
      keys.add(connectionKey)
      nativeConnectionCounts.set(native.provider, keys)
    }
    const existing = connectionGroups.get(connectionKey)
    if (existing) existing.settings.push(settings)
    else connectionGroups.set(connectionKey, {
      settings: [settings], native, connectionKey, provider: '', apiKeyEnv: ''
    })
  }

  const usedProviders = new Set<string>()
  for (const group of connectionGroups.values()) {
    const directNative = group.native !== undefined
      && nativeConnectionCounts.get(group.native.provider)?.size === 1
    const base = directNative
      ? group.native!.provider
      : group.native?.provider ?? apiRouteName(group.settings[0]!.apiFormat)
    group.provider = uniqueProviderName(base, group.connectionKey, usedProviders, directNative)
    group.apiKeyEnv = `ELECKOI_MODEL_KEY_${hash(group.connectionKey).toUpperCase()}`
    usedProviders.add(group.provider)
  }

  const providers: Record<string, DshProviderProfile> = {}
  const credentials: Record<string, string> = {}
  const bindings: Record<string, DshProviderBinding> = {}
  for (const group of connectionGroups.values()) {
    const inheritsCatalog = group.native?.provider === group.provider
    providers[group.provider] = providerProfile(group.settings, group.apiKeyEnv, group.native, inheritsCatalog)
    credentials[group.apiKeyEnv] = group.settings[0]!.apiKey
    for (const settings of group.settings) {
      bindings[modelBindingKey(settings)] = compact({
        provider: group.provider,
        model: runtimeModelId(settings),
        reasoningEffort: acceptedReasoningEffort(settings.reasoningEffort, findNativeModel(settings))
      })
    }
  }
  return { providers, credentials, bindings }
}

export function resolveDshProviderBinding(
  catalog: DshProviderCatalog,
  settings: DshModelSettings
): DshProviderBinding {
  const binding = catalog.bindings[modelBindingKey(settings)]
  if (binding === undefined) throw new Error(`模型 ${settings.model} 不在当前 DSH provider 目录中。`)
  return binding
}

export function createDshProviderPlan(
  mainSettings: DshModelSettings,
  subagentSettings: DshModelSettings = mainSettings
): DshProviderPlan {
  const catalog = createDshProviderCatalog([mainSettings, subagentSettings])
  return {
    providers: catalog.providers,
    main: resolveDshProviderBinding(catalog, mainSettings),
    subagent: resolveDshProviderBinding(catalog, subagentSettings)
  }
}

function deduplicateSettings(items: readonly DshModelSettings[]): DshModelSettings[] {
  const unique = new Map<string, DshModelSettings>()
  for (const item of items) unique.set(modelBindingKey(item), item)
  return [...unique.values()]
}

function modelBindingKey(settings: DshModelSettings): string {
  return `${settings.configId || providerConnectionKey(settings, findNativeModel(settings))}\u0000${settings.model}`
}

function findNativeModel(identity: DshModelIdentity): NativeMatch | undefined {
  const modelId = runtimeModelId(identity)
  const endpoint = normalizeUrl(runtimeBaseUrl(identity))
  if (!modelId || endpoint === undefined) return undefined
  for (const provider of getBuiltinProviders()) {
    const model = getBuiltinModels(provider).find((candidate) => (
      candidate.id === modelId
      && candidate.api === identity.apiFormat
      && normalizeUrl(candidate.baseUrl) === endpoint
    ))
    if (model !== undefined) return { provider, model }
  }
  return undefined
}

function normalizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim())
    const pathname = url.pathname.replace(/\/+$/, '')
    return `${url.protocol}//${url.host}${pathname}`.toLowerCase()
  } catch {
    return undefined
  }
}

function supportedReasoningEfforts(model: CatalogModel): DshReasoningEffort[] {
  if (!model.reasoning) return []
  return getSupportedThinkingLevels(model).filter(isReasoningEffort)
}

function acceptedReasoningEffort(value: string | undefined, native: NativeMatch | undefined): DshReasoningEffort | undefined {
  if (!isReasoningEffort(value)) return undefined
  return native !== undefined && supportedReasoningEfforts(native.model).includes(value) ? value : undefined
}

function isReasoningEffort(value: unknown): value is DshReasoningEffort {
  return typeof value === 'string' && (reasoningEfforts as readonly string[]).includes(value)
}

function providerProfile(
  settingsList: readonly DshModelSettings[],
  apiKeyEnv: string,
  native: NativeMatch | undefined,
  inheritsCatalog: boolean
): DshProviderProfile {
  const first = settingsList[0]!
  return compact({
    displayName: native?.provider ?? first.configId ?? 'Custom provider',
    apiKeyEnv,
    ...(inheritsCatalog ? {} : {
      api: native?.model.api ?? first.apiFormat,
      baseURL: native?.model.baseUrl ?? runtimeBaseUrl(first),
      defaultContextWindow: first.contextWindow,
      defaultMaxTokens: Math.min(32_768, first.contextWindow),
      defaultInput: first.supportsImageInput ? ['text', 'image'] : ['text']
    }),
    headers: nonEmptyRecord(first.customHeaders),
    models: settingsList.map((settings) => modelProfile(settings, findNativeModel(settings), inheritsCatalog))
  })
}

function modelProfile(
  settings: DshModelSettings,
  native: NativeMatch | undefined,
  inheritsCatalog: boolean
): PiAiModelProfile {
  if (native !== undefined && inheritsCatalog) {
    return compact({
      id: runtimeModelId(settings),
      contextWindow: settings.contextWindowOverride,
      input: settings.supportsImageInput ? ['text', 'image'] : ['text']
    }) as PiAiModelProfile
  }
  const model = native?.model
  return compact({
    id: runtimeModelId(settings),
    name: model?.name,
    contextWindow: settings.contextWindowOverride ?? model?.contextWindow ?? settings.contextWindow,
    input: settings.supportsImageInput ? ['text', 'image'] : ['text'],
    reasoningEfforts: model === undefined ? false : materializedReasoningEfforts(model),
    compat: model?.compat
  }) as PiAiModelProfile
}

function materializedReasoningEfforts(model: CatalogModel): false | Record<string, string | null> {
  const supported = supportedReasoningEfforts(model)
  if (supported.length === 0) return false
  return Object.fromEntries(supported.map((level) => [
    level,
    level === 'off' ? null : model.thinkingLevelMap?.[level] ?? level
  ]))
}

function providerConnectionKey(settings: DshModelSettings, native: NativeMatch | undefined): string {
  return JSON.stringify({
    provider: native?.provider ?? 'custom',
    apiKey: settings.apiKey,
    api: settings.apiFormat,
    baseUrl: normalizeUrl(runtimeBaseUrl(settings)) ?? runtimeBaseUrl(settings),
    headers: settings.customHeaders,
    proxyUrl: settings.proxyUrl ?? ''
  })
}

function runtimeModelId(identity: DshModelIdentity): string {
  const model = identity.model.trim()
  return identity.apiFormat === 'google-generative-ai'
    ? model.replace(/^models\//i, '')
    : model
}

function runtimeBaseUrl(identity: DshModelIdentity): string {
  const configured = identity.baseUrl.trim().replace(/\/+$/, '')
  if (identity.apiFormat !== 'google-generative-ai') return configured
  try {
    const url = new URL(configured)
    const rootPath = url.pathname
      .replace(/\/+$/, '')
      .replace(/\/v1beta\/openai$/i, '')
      .replace(/\/v1beta$/i, '')
      .replace(/\/v1$/i, '')
    url.pathname = `${rootPath}/v1beta`.replace(/\/+/g, '/')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return configured
  }
}

function uniqueProviderName(base: string, key: string, used: Set<string>, direct: boolean): string {
  const normalized = base.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'custom'
  if (direct && !used.has(normalized)) return normalized
  const candidate = `${normalized}-${hash(key)}`
  if (!used.has(candidate)) return candidate
  let serial = 2
  while (used.has(`${candidate}-${serial}`)) serial += 1
  return `${candidate}-${serial}`
}

function apiRouteName(api: DshModelSettings['apiFormat']): string {
  return api.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom'
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function nonEmptyRecord(value: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(value).length > 0 ? value : undefined
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
