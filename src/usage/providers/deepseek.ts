import { asObject, formatAmount, makeBalanceReport } from '../format.ts'
import type { UnknownRecord, UsageProvider } from '../types.ts'

export const deepSeekProvider: UsageProvider = {
  id: 'deepseek',
  name: 'DeepSeek API',
  origins: ['https://api.deepseek.com'],
  url: 'https://api.deepseek.com/user/balance',
  normalize: normalizeDeepSeek,
}

export function normalizeDeepSeek(payload: UnknownRecord) {
  const data = asObject(payload.data) ?? payload
  const balances = Array.isArray(data.balance_infos) ? data.balance_infos : []
  const lines: string[] = []
  for (const item of balances) {
    const balance = asObject(item)
    if (!balance || typeof balance.currency !== 'string') {
      continue
    }
    const amount = formatAmount(balance.total_balance)
    if (!amount) {
      continue
    }
    const parts = [`${balance.currency} ${amount} available`]
    const granted = formatAmount(balance.granted_balance)
    const toppedUp = formatAmount(balance.topped_up_balance)
    if (granted) {
      parts.push(`${granted} granted`)
    }
    if (toppedUp) {
      parts.push(`${toppedUp} topped up`)
    }
    lines.push(parts.join(' · '))
  }
  if (!lines.length) {
    throw new Error('DeepSeek returned no account balance data.')
  }
  const available = data.is_available === false ? 'API unavailable' : 'DeepSeek'
  return makeBalanceReport(available, lines)
}
