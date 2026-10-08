import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

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

export interface UsageProvider {
  id: string
  name: string
  aliases?: string[] | undefined
  origins: string[]
  url: string | ((auth: ResolvedUsageAuth) => string)
  validateAuth?:
    | ((ctx: ExtensionContext, model: Model<Api>) => void)
    | undefined
  createHeaders?:
    | ((auth: ResolvedUsageAuth) => Record<string, string>)
    | undefined
  normalize: (payload: UnknownRecord, auth: ResolvedUsageAuth) => UsageReport
}

export type ProviderChoice = Pick<UsageProvider, 'id' | 'name' | 'aliases'>
