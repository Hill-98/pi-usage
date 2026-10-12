import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { UsageCacheOptions } from './cache.ts'

export type UnknownRecord = Record<string, unknown>

export interface UsageWindow {
  label: string
  usedPercent?: number | undefined
  remainingPercent?: number | undefined
  resetAt?: number | undefined
}

export interface UsageReport {
  provider: string
  lines: string[]
  status: string
}

export type ResolvedUsageAuth = Extract<
  Awaited<ReturnType<ExtensionContext['modelRegistry']['getApiKeyAndHeaders']>>,
  { ok: true }
>

interface UsageProviderMetadata {
  id: string
  name: string
  aliases?: string[] | undefined
  origins: string[]
  validateAuth?:
    | ((ctx: ExtensionContext, model: Model<Api>) => void)
    | undefined
}

export interface HttpUsageProvider extends UsageProviderMetadata {
  url: string | ((auth: ResolvedUsageAuth) => string)
  createHeaders?:
    | ((auth: ResolvedUsageAuth) => Record<string, string>)
    | undefined
  normalize: (payload: UnknownRecord, auth: ResolvedUsageAuth) => UsageReport
}

export type UsageCredentialReader = (providerId: string) => unknown

export interface UsageQueryOptions extends UsageCacheOptions {
  readCredential?: UsageCredentialReader | undefined
}

export interface UsageQueryContext {
  ctx: ExtensionContext
  model: Model<Api>
  auth: ResolvedUsageAuth
  fetchImpl: typeof fetch
  options: UsageQueryOptions
}

export interface CustomUsageProvider extends UsageProviderMetadata {
  query: (context: UsageQueryContext) => Promise<UsageReport>
}

export type UsageProvider = HttpUsageProvider | CustomUsageProvider

export type ProviderChoice = Pick<UsageProvider, 'id' | 'name' | 'aliases'>
