import { asObject, formatAmount, makeBalanceReport } from '../format.ts'
import type { UnknownRecord, UsageProvider } from '../types.ts'

export const openRouterProvider: UsageProvider = {
  id: 'openrouter',
  name: 'OpenRouter',
  origins: ['https://openrouter.ai'],
  url: 'https://openrouter.ai/api/v1/key',
  normalize: normalizeOpenRouter,
}

export function normalizeOpenRouter(payload: UnknownRecord) {
  const data = asObject(payload.data) ?? payload
  const lines: string[] = []
  const remaining = formatAmount(data.limit_remaining)
  const limit = formatAmount(data.limit)
  const usage = formatAmount(data.usage)
  if (remaining) {
    lines.push(`USD ${remaining} remaining${limit ? ` of ${limit}` : ''}`)
  }
  if (usage) {
    lines.push(`USD ${usage} used`)
  }
  for (const [key, label] of [
    ['usage_daily', 'daily'],
    ['usage_weekly', 'weekly'],
    ['usage_monthly', 'monthly'],
  ] as const) {
    const amount = formatAmount(data[key])
    if (amount) {
      lines.push(`USD ${amount} ${label} spend`)
    }
  }
  if (!lines.length) {
    throw new Error('OpenRouter returned no key usage data.')
  }
  return makeBalanceReport('OpenRouter API key', lines)
}
