import {
  asObject,
  finiteNumber,
  makeWindowReport,
  normalizeTimestamp,
} from '../format.ts'
import type { UnknownRecord, UsageProvider, UsageWindow } from '../types.ts'

export const kimiCodingProvider: UsageProvider = {
  id: 'kimi-coding',
  name: 'Kimi For Coding',
  aliases: ['kimi', 'kimi-coding'],
  origins: ['https://api.kimi.com'],
  url: 'https://api.kimi.com/coding/v1/usages',
  normalize: normalizeKimi,
}

export function normalizeKimi(payload: UnknownRecord) {
  const windows: UsageWindow[] = []
  const addWindow = (name: unknown, value: unknown): void => {
    const label = normalizeWindowLabel(name)
    if (!label || windows.some((window) => window.label === label)) {
      return
    }
    const window = normalizeKimiWindow(value)
    if (window) {
      windows.push({ ...window, label })
    }
  }

  if (Array.isArray(payload.limits)) {
    for (const row of payload.limits) {
      if (!row || typeof row !== 'object') {
        continue
      }
      const record = asObject(row)
      if (record) {
        addWindow(
          record.window ?? record.name ?? record.period ?? record.duration,
          record,
        )
      }
    }
  }
  for (const sourceName of ['usages', 'usage', 'limits']) {
    const rawSource = payload[sourceName]
    if (Array.isArray(rawSource)) {
      for (const row of rawSource) {
        const record = asObject(row)
        if (!record) {
          continue
        }
        addWindow(
          record.window ?? record.name ?? record.period ?? record.duration,
          record,
        )
      }
      continue
    }
    const source = asObject(rawSource)
    if (!source) {
      continue
    }
    for (const [name, value] of Object.entries(source)) {
      if (name === 'limit_month_code') {
        continue
      }
      addWindow(name, value)
    }
  }
  if (!windows.length) {
    throw new Error('Kimi returned no supported usage windows.')
  }
  const wallet =
    asObject(payload.boosterWallet) ?? asObject(payload.booster_wallet)
  return makeWindowReport(
    'Kimi For Coding',
    windows,
    wallet ? formatKimiWallet(wallet) : undefined,
  )
}

function normalizeKimiWindow(
  value: unknown,
): Omit<UsageWindow, 'label'> | undefined {
  if (typeof value === 'number') {
    return undefined
  }
  const row = asObject(value)
  if (!row) {
    return undefined
  }
  const ratio = finiteNumber(row.used_ratio ?? row.usedRatio)
  const remainingRatio = finiteNumber(row.remaining_ratio ?? row.remainingRatio)
  const total = finiteNumber(row.limit ?? row.total ?? row.limit_count)
  let remaining = finiteNumber(
    row.remaining ?? row.remains ?? row.remaining_count,
  )
  const used = finiteNumber(row.used ?? row.usage ?? row.used_count)

  if (ratio !== undefined && ratio >= 0 && ratio <= 1) {
    remaining = 1 - ratio
  } else if (
    remainingRatio !== undefined &&
    remainingRatio >= 0 &&
    remainingRatio <= 1
  ) {
    remaining = remainingRatio
  } else if (total !== undefined && total > 0) {
    if (remaining !== undefined) {
      remaining /= total
    } else if (used !== undefined) {
      remaining = 1 - used / total
    } else if (remaining === undefined) {
      remaining = 1
    }
  }

  if (remaining === undefined || remaining < 0 || remaining > 1) {
    return undefined
  }
  return {
    remainingPercent: Math.round(remaining * 100),
    resetAt: normalizeTimestamp(row.reset_time ?? row.resetAt ?? row.resets_at),
  }
}

function normalizeWindowLabel(value: unknown): string | undefined {
  const name = String(value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
  if (
    name.includes('5h') ||
    name.includes('5 hour') ||
    name.includes('hourly')
  ) {
    return '5h'
  }
  if (name.includes('week')) {
    return 'week'
  }
  if (name.includes('month')) {
    return 'month'
  }
  const seconds = finiteNumber(value)
  if (seconds === 18_000) {
    return '5h'
  }
  if (seconds === 604_800) {
    return 'week'
  }
  return undefined
}

function formatKimiWallet(wallet: UnknownRecord): string | undefined {
  const amount = formatKimiFixedUnits(wallet.amountLeft ?? wallet.amount_left)
  const currency =
    typeof wallet.currency === 'string' ? wallet.currency : undefined
  if (!amount || !currency) {
    return undefined
  }
  return `${currency} ${amount} booster wallet remaining`
}

function formatKimiFixedUnits(value: unknown): string | undefined {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    (typeof value === 'number' && !Number.isSafeInteger(value)) ||
    !/^\d+$/.test(String(value))
  ) {
    return undefined
  }
  try {
    const units = BigInt(value)
    const unitsPerCurrency = 100_000_000n
    const whole = units / unitsPerCurrency
    const fraction = (units % unitsPerCurrency).toString().padStart(8, '0')
    const trimmedFraction = fraction.replace(/0+$/, '')
    return trimmedFraction ? `${whole}.${trimmedFraction}` : whole.toString()
  } catch {
    return undefined
  }
}
