import {
  asObject,
  finiteNumber,
  makeWindowReport,
  normalizeTimestamp,
} from '../format.ts'
import type { UnknownRecord, UsageProvider, UsageWindow } from '../types.ts'

export const openCodeGoProvider: UsageProvider = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  aliases: ['opencode'],
  origins: ['https://opencode.ai'],
  url: 'https://opencode.ai/zen/go/v1/usage',
  normalize: normalizeOpenCodeGo,
}

export function normalizeOpenCodeGo(payload: UnknownRecord) {
  const data = asObject(payload.data) ?? payload
  const entries: UsageWindow[] = []
  for (const [key, label] of [
    ['rolling', 'rolling'],
    ['weekly', 'week'],
    ['monthly', 'month'],
    ['rolling_window', 'rolling'],
    ['weekly_window', 'week'],
    ['monthly_window', 'month'],
  ] as const) {
    const row = asObject(data[key])
    if (!row) {
      continue
    }
    const used = finiteNumber(row.usedPercent ?? row.used_percent ?? row.used)
    if (used === undefined || used < 0 || used > 100) {
      continue
    }
    const remaining = row.remainingPercent ?? row.remaining_percent
    entries.push({
      label,
      usedPercent: used,
      remainingPercent: finiteNumber(remaining) ?? 100 - used,
      resetAt: normalizeTimestamp(
        row.resetsAt ?? row.reset_at ?? row.resets_at,
      ),
    })
  }
  if (!entries.length) {
    throw new Error('OpenCode Go returned no supported usage windows.')
  }
  return makeWindowReport('OpenCode Go', entries)
}
