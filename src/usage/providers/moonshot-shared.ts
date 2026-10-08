import { asObject, formatAmount, makeBalanceReport } from '../format.ts'
import type { UnknownRecord, UsageProvider } from '../types.ts'

export interface MoonshotConfig {
  id: string
  name: string
  aliases?: string[]
  origin: string
  url: string
  currency: string
}

export function createMoonshotProvider(config: MoonshotConfig): UsageProvider {
  return {
    id: config.id,
    name: config.name,
    aliases: config.aliases,
    origins: [config.origin],
    url: config.url,
    normalize: (payload) => normalizeMoonshot(payload, config),
  }
}

function normalizeMoonshot(payload: UnknownRecord, provider: MoonshotConfig) {
  const data = asObject(payload.data) ?? payload
  const available = formatAmount(data.available_balance)
  if (!available) {
    throw new Error('Moonshot returned no account balance data.')
  }
  const lines = [`${provider.currency} ${available} available`]
  const voucher = formatAmount(data.voucher_balance)
  const cash = formatAmount(data.cash_balance)
  if (voucher) {
    lines.push(`${provider.currency} ${voucher} voucher balance`)
  }
  if (cash) {
    lines.push(`${provider.currency} ${cash} cash balance`)
  }
  return makeBalanceReport(provider.name, lines)
}
