import { asObject, formatAmount, makeBalanceReport } from '../format.ts'
import type { UnknownRecord, UsageProvider } from '../types.ts'

export const vercelAIGatewayProvider: UsageProvider = {
  id: 'vercel-ai-gateway',
  name: 'Vercel AI Gateway',
  aliases: ['vercel'],
  origins: ['https://ai-gateway.vercel.sh'],
  url: 'https://ai-gateway.vercel.sh/v1/credits',
  normalize: normalizeVercelAIGateway,
}

export function normalizeVercelAIGateway(payload: UnknownRecord) {
  const data = asObject(payload.data) ?? payload
  const credit = formatAmount(
    data.credits ?? data.balance ?? data.creditBalance,
  )
  const usage = formatAmount(data.usage ?? data.totalSpent ?? data.total_spent)
  const lines: string[] = []
  if (credit) {
    lines.push(`USD ${credit} credits available`)
  }
  if (usage) {
    lines.push(`USD ${usage} lifetime spend`)
  }
  if (!lines.length) {
    throw new Error('Vercel AI Gateway returned no credit data.')
  }
  return makeBalanceReport('Vercel AI Gateway', lines)
}
