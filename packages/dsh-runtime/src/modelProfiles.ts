import { createHash } from 'node:crypto'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider
} from '@earendil-works/pi-ai/providers/all'
import type { PiAiModelProfile, PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type {
  DshModelIdentity,
  DshModelSettings,
  DshReasoningEffort,
  DshReasoningEfforts
} from './types'

type CatalogModel = ReturnType<typeof getBuiltinModels>[number]

export interface DshModelCapabilities {
  provider: string | null
  source: 'dsh_catalog' | 'explicit_profile' | 'provider_default'
  reasoningEfforts: DshReasoningEffort[]
}

export interface DshProviderBinding {
  provider: string
  model: string
  reasoningEffort?: DshReasoningEffort | undefined
}

export type DshProviderProfile = PiAiProviderProfile

export interface DshDeepSeekModelProfile {
  id: string
  name?: string | undefined
  contextWindow?: number | undefined
  maxTokens?: number | undefined
  inputModalities?: Array<'text' | 'image'> | undefined
}

export interface DshDeepSeekProfile {
  apiKeyEnv: string
  baseURL: string
  defaultContextWindow: number
  models: DshDeepSeekModelProfile[]
}

export interface DshProviderCatalog {
  providers: Record<string, DshProviderProfile>
  deepseek?: DshDeepSeekProfile | undefined
  credentials: Record<string, string>
  bindings: Record<string, DshProviderBinding>
}

interface NativeRoute {
  provider: BuiltinProvider
  model: CatalogModel | undefined
}

interface ConnectionGroup {
  settings: DshModelSettings[]
  native: NativeRoute | undefined
  connectionKey: string
  provider: string
  apiKeyEnv: string
}

const reasoningEfforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const deepSeekReasoningEfforts = ['off', 'low', 'high', 'max'] as const
const deepSeekPiAiReasoningEfforts = {
  off: 'none',
  low: 'low',
  high: 'high',
  max: 'max'
} as const
const deepSeekProviderRoute = 'deepseek-official'
const deepSeekApiKeyEnv = 'ELECKOI_DEEPSEEK_API_KEY'

export function describeDshModelCapabilities(identity: DshModelIdentity): DshModelCapabilities {
  if (usesOfficialDeepSeekRoute(identity)) {
    return {
      provider: deepSeekProviderRoute,
      source: 'dsh_catalog',
      reasoningEfforts: [...deepSeekReasoningEfforts]
    }
  }
  if (isDedicatedDeepSeekProvider(identity)) {
    return {
      provider: null,
      source: 'dsh_catalog',
      reasoningEfforts: [...deepSeekReasoningEfforts]
    }
  }
  const native = findNativeRoute(identity)
  const declared = declaredReasoningEfforts(identity.reasoningEfforts)
  if (declared !== undefined) {
    return {
      provider: native?.provider ?? null,
      source: 'explicit_profile',
      reasoningEfforts: declared
    }
  }
  return native?.model === undefined
    ? { provider: native?.provider ?? null, source: 'provider_default', reasoningEfforts: [] }
    : {
        provider: native.provider,
        source: 'dsh_catalog',
        reasoningEfforts: supportedReasoningEfforts(native.model)
      }
}

/** Builds the immutable process-wide DSH route directory used by every Session. */
export function createDshProviderCatalog(settingsList: readonly DshModelSettings[]): DshProviderCatalog {
  const uniqueSettings = deduplicateSettings(settingsList)
  if (uniqueSettings.length === 0) throw new Error('DSH provider catalog requires at least one model configuration.')

  const officialDeepSeek = uniqueSettings.filter(usesOfficialDeepSeekRoute)
  const piAiSettings = uniqueSettings.filter((settings) => !usesOfficialDeepSeekRoute(settings))
  const providers: Record<string, DshProviderProfile> = {}
  const credentials: Record<string, string> = {}
  const bindings: Record<string, DshProviderBinding> = {}
  const deepseek = createDeepSeekProfile(officialDeepSeek, credentials, bindings)

  const connectionGroups = new Map<string, ConnectionGroup>()
  const nativeConnectionCounts = new Map<string, Set<string>>()
  for (const settings of piAiSettings) {
    const native = findNativeRoute(settings)
    if (settings.apiFormat === 'google-generative-ai' && native === undefined) {
      throw new Error(
        '最新版 DSH 仅允许 Google Generative AI 接口使用 pi-ai 的原生 Google 路由；'
        + '自定义代理请改选代理实际支持的 OpenAI Chat、OpenAI Responses 或 Anthropic Messages 接口。'
      )
    }
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

  const usedProviders = new Set<string>(officialDeepSeek.length === 0 ? [] : [deepSeekProviderRoute])
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

  for (const group of connectionGroups.values()) {
    const inheritsCatalog = group.native?.provider === group.provider
    providers[group.provider] = providerProfile(group.settings, group.apiKeyEnv, group.native, inheritsCatalog)
    credentials[group.apiKeyEnv] = group.settings[0]!.apiKey
    for (const settings of group.settings) {
      const native = findNativeRoute(settings)
      bindings[modelBindingKey(settings)] = compact({
        provider: group.provider,
        model: runtimeModelId(settings),
        reasoningEffort: acceptedReasoningEffort(settings.reasoningEffort, native?.model, settings)
      })
    }
  }
  return { providers, deepseek, credentials, bindings }
}

export function resolveDshProviderBinding(
  catalog: DshProviderCatalog,
  settings: DshModelSettings
): DshProviderBinding {
  const binding = catalog.bindings[modelBindingKey(settings)]
  if (binding === undefined) throw new Error(`模型 ${settings.model} 不在当前 DSH provider 目录中。`)
  return binding
}

function createDeepSeekProfile(
  settingsList: readonly DshModelSettings[],
  credentials: Record<string, string>,
  bindings: Record<string, DshProviderBinding>
): DshDeepSeekProfile | undefined {
  if (settingsList.length === 0) return undefined
  const first = settingsList[0]!
  for (const settings of settingsList.slice(1)) {
    if (settings.apiKey !== first.apiKey || runtimeBaseUrl(settings) !== runtimeBaseUrl(first)) {
      throw new Error('DeepSeek 专用入口只能使用一套 API Key 和 Base URL。')
    }
  }
  credentials[deepSeekApiKeyEnv] = first.apiKey
  for (const settings of settingsList) {
    bindings[modelBindingKey(settings)] = compact({
      provider: deepSeekProviderRoute,
      model: runtimeModelId(settings),
      reasoningEffort: isDeepSeekReasoningEffort(settings.reasoningEffort)
        ? settings.reasoningEffort
        : undefined
    })
  }
  const models = new Map<string, DshDeepSeekModelProfile>()
  for (const settings of settingsList) {
    models.set(runtimeModelId(settings), compact({
      id: runtimeModelId(settings),
      contextWindow: settings.contextWindowOverride ?? settings.contextWindow,
      maxTokens: settings.maxTokens,
      inputModalities: settings.supportsImageInput ? ['text', 'image'] : ['text']
    }))
  }
  return {
    apiKeyEnv: deepSeekApiKeyEnv,
    baseURL: runtimeBaseUrl(first),
    defaultContextWindow: first.contextWindow,
    models: [...models.values()]
  }
}

function deduplicateSettings(items: readonly DshModelSettings[]): DshModelSettings[] {
  const unique = new Map<string, DshModelSettings>()
  for (const item of items) unique.set(modelBindingKey(item), item)
  return [...unique.values()]
}

function modelBindingKey(settings: DshModelSettings): string {
  return `${settings.configId || providerConnectionKey(settings, findNativeRoute(settings))}\u0000${settings.model}`
}

function findNativeRoute(identity: DshModelIdentity): NativeRoute | undefined {
  const modelId = runtimeModelId(identity)
  const endpoint = normalizeUrl(runtimeBaseUrl(identity))
  if (!modelId || endpoint === undefined) return undefined
  const routeMatches: NativeRoute[] = []
  for (const provider of getBuiltinProviders()) {
    const models = getBuiltinModels(provider)
    const model = models.find((candidate) => (
      candidate.id === modelId
      && candidate.api === identity.apiFormat
      && normalizeUrl(candidate.baseUrl) === endpoint
    ))
    if (model !== undefined) return { provider, model }
    if (models.some((candidate) => (
      candidate.api === identity.apiFormat
      && normalizeUrl(candidate.baseUrl) === endpoint
    ))) routeMatches.push({ provider, model: undefined })
  }
  return routeMatches.length === 1 ? routeMatches[0] : undefined
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

function acceptedReasoningEffort(
  value: string | undefined,
  model: CatalogModel | undefined,
  identity: DshModelIdentity
): DshReasoningEffort | undefined {
  if (!isReasoningEffort(value)) return undefined
  const supported = isDedicatedDeepSeekProvider(identity)
    ? deepSeekReasoningEfforts
    : declaredReasoningEfforts(identity.reasoningEfforts)
      ?? (model === undefined ? [] : supportedReasoningEfforts(model))
  return (supported as readonly DshReasoningEffort[]).includes(value) ? value : undefined
}

function isReasoningEffort(value: unknown): value is DshReasoningEffort {
  return typeof value === 'string' && (reasoningEfforts as readonly string[]).includes(value)
}

function isDeepSeekReasoningEffort(value: unknown): value is 'off' | 'low' | 'high' | 'max' {
  return typeof value === 'string' && (deepSeekReasoningEfforts as readonly string[]).includes(value)
}

function declaredReasoningEfforts(value: DshModelIdentity['reasoningEfforts']): DshReasoningEffort[] | undefined {
  if (value === undefined) return undefined
  if (value === false) return []
  return reasoningEfforts.filter((level) => Object.hasOwn(value, level))
}

function providerProfile(
  settingsList: readonly DshModelSettings[],
  apiKeyEnv: string,
  native: NativeRoute | undefined,
  inheritsCatalog: boolean
): DshProviderProfile {
  const first = settingsList[0]!
  return compact({
    displayName: native?.provider ?? first.configId ?? 'Custom provider',
    apiKeyEnv,
    ...(inheritsCatalog ? {} : {
      api: native?.model?.api ?? first.apiFormat,
      baseURL: native?.model?.baseUrl ?? runtimeBaseUrl(first),
      defaultContextWindow: first.contextWindow,
      defaultMaxTokens: Math.min(32_768, first.contextWindow),
      defaultInput: first.supportsImageInput ? ['text', 'image'] : ['text']
    }),
    headers: nonEmptyRecord(first.customHeaders),
    models: settingsList.map((settings) => modelProfile(settings, findNativeRoute(settings)?.model, inheritsCatalog))
  })
}

function modelProfile(
  settings: DshModelSettings,
  native: CatalogModel | undefined,
  inheritsCatalog: boolean
): PiAiModelProfile {
  if (native !== undefined && inheritsCatalog) {
    return compact({
      id: runtimeModelId(settings),
      contextWindow: settings.contextWindowOverride,
      input: settings.supportsImageInput ? ['text', 'image'] : ['text'],
      reasoningEfforts: settings.reasoningEfforts
    }) as PiAiModelProfile
  }
  return compact({
    id: runtimeModelId(settings),
    name: native?.name,
    contextWindow: settings.contextWindowOverride ?? native?.contextWindow ?? settings.contextWindow,
    input: settings.supportsImageInput ? ['text', 'image'] : ['text'],
    reasoningEfforts: isDedicatedDeepSeekProvider(settings)
      ? { ...deepSeekPiAiReasoningEfforts }
      : settings.reasoningEfforts
        ?? (native === undefined ? undefined : materializedReasoningEfforts(native)),
    compat: native?.compat
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

function usesOfficialDeepSeekRoute(identity: DshModelIdentity): boolean {
  return isDedicatedDeepSeekProvider(identity) && identity.apiFormat === 'openai-completions'
}

function isDedicatedDeepSeekProvider(identity: DshModelIdentity): boolean {
  return identity.provider === 'deepseek'
}

function providerConnectionKey(settings: DshModelSettings, native: NativeRoute | undefined): string {
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
