import type { UnknownRecord, UsageReport, UsageWindow } from './types.ts'

export function asObject(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function formatAmount(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return undefined
  }
  const text = String(value).trim()
  if (!/^-?\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) {
    return undefined
  }
  return text
}

export function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const number = finiteNumber(value)
  if (number === undefined || number < 0) {
    return undefined
  }
  return number < 100_000_000_000 ? number * 1000 : number
}

export function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback
  }
  const clean = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 0x1f && codePoint !== 0x7f
    })
    .join('')
    .trim()
    .slice(0, 80)
  return clean || fallback
}

export function makeWindowReport(
  provider: string,
  windows: UsageWindow[],
  extraLine?: string,
): UsageReport {
  const lines = windows.map((window) => {
    const used = window.usedPercent ?? 100 - (window.remainingPercent ?? 0)
    const remaining = window.remainingPercent ?? 100 - (window.usedPercent ?? 0)
    const reset = window.resetAt
      ? ` · resets in ${formatCountdown(window.resetAt)}`
      : ''
    return `${window.label}: ${remaining}% remaining (${used}% used)${reset}`
  })
  if (extraLine) {
    lines.push(extraLine)
  }
  const status = windows
    .map(
      (window) =>
        `${window.label} ${window.remainingPercent ?? Math.round(100 - (window.usedPercent ?? 0))}%`,
    )
    .join(' · ')
  return { provider, lines, status }
}

export function makeBalanceReport(
  provider: string,
  lines: string[],
): UsageReport {
  const firstLine = lines[0] ?? 'usage data available'
  return {
    provider,
    lines,
    status: firstLine.length > 50 ? `${provider} balance available` : firstLine,
  }
}

export function renderReport(report: UsageReport): string {
  return [
    `${report.provider} usage`,
    ...report.lines.map((line) => `• ${line}`),
  ].join('\n')
}

export function renderStatus(report: UsageReport): string {
  return `${report.provider}: ${report.status}`
}

function formatCountdown(timestamp: number): string {
  const seconds = Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const extraMinutes = minutes % 60
  if (hours < 24) {
    return extraMinutes ? `${hours}h${extraMinutes}m` : `${hours}h`
  }
  const days = Math.floor(hours / 24)
  const extraHours = hours % 24
  return extraHours ? `${days}d${extraHours}h` : `${days}d`
}
