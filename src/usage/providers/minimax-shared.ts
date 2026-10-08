import { getCredential } from '../auth.ts'
import {
  asObject,
  finiteNumber,
  formatAmount,
  makeBalanceReport,
  safeLabel,
} from '../format.ts'
import type {
  ResolvedUsageAuth,
  UnknownRecord,
  UsageProvider,
} from '../types.ts'

export interface MiniMaxConfig {
  id: string
  name: string
  aliases?: string[]
  origin: string
  region: 'global' | 'china'
}

export function createMiniMaxProvider(config: MiniMaxConfig): UsageProvider {
  const apiRoot = config.origin
  return {
    id: config.id,
    name: config.name,
    aliases: config.aliases,
    origins: [config.origin],
    url: (auth) => getMiniMaxUrl(auth, config, apiRoot),
    normalize: (payload, auth) =>
      normalizeMiniMax(payload, config, getCredential(auth) ?? ''),
  }
}

function getMiniMaxUrl(
  auth: ResolvedUsageAuth,
  provider: MiniMaxConfig,
  apiRoot: string,
): string {
  const key = getCredential(auth)
  if (!key) {
    throw new Error(`No valid ${provider.name} API key was found.`)
  }
  return key.startsWith('sk-api-')
    ? `${apiRoot}/account/query_balance`
    : `${apiRoot}/v1/token_plan/remains`
}

function normalizeMiniMax(
  payload: UnknownRecord,
  provider: MiniMaxConfig,
  apiKey: string,
) {
  const data = asObject(payload.data) ?? payload
  if (apiKey.startsWith('sk-api-')) {
    const balance =
      formatAmount(data.balance) ??
      formatAmount(data.available_balance) ??
      formatAmount(data.cash_balance)
    if (!balance) {
      throw new Error('MiniMax returned no API balance data.')
    }
    const currency = provider.region === 'china' ? 'CNY' : 'USD'
    const lines: string[] = [`${currency} ${balance} available`]
    const voucher = formatAmount(data.voucher_balance)
    if (voucher) {
      lines.push(`${currency} ${voucher} voucher balance`)
    }
    return makeBalanceReport(`${provider.name} API`, lines)
  }

  const rows = Array.isArray(data.model_remains)
    ? data.model_remains
    : Array.isArray(data.remains)
      ? data.remains
      : []
  const lines: string[] = []
  for (const item of rows) {
    const row = asObject(item)
    if (!row) {
      continue
    }
    const name = safeLabel(
      row.model_name ?? row.name ?? row.model,
      'Token plan',
    )
    const remain = formatAmount(row.remains ?? row.remain)
    const used = finiteNumber(row.current_interval_usage_count ?? row.used)
    const total = finiteNumber(row.current_interval_total_count ?? row.total)
    if (remain) {
      const percent =
        total !== undefined && total > 0 && used !== undefined
          ? ` (${Math.round((1 - used / total) * 100)}% remaining)`
          : ''
      lines.push(`${name}: ${remain} remaining${percent}`)
    } else if (total !== undefined && total > 0 && used !== undefined) {
      lines.push(`${name}: ${Math.max(0, total - used)} / ${total} remaining`)
    }
  }
  if (!lines.length) {
    throw new Error('MiniMax returned no Token Plan quota data.')
  }
  return makeBalanceReport(`${provider.name} Token Plan`, lines)
}
