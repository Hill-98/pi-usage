import { asObject, formatCountdown, makeWindowReport } from '../format.ts'
import type { UnknownRecord, UsageReport, UsageWindow } from '../types.ts'
import { isOpenAIProPlan } from './openai-codex.ts'

export const OPENAI_CHATGPT_NAME = 'OpenAI (ChatGPT subscription)'
export const CHATGPT_USAGE_SETTINGS_URL = 'https://chatgpt.com/settings/usage'

export interface OpenAIAppUsage {
  windows: UsageWindow[]
  allowance?: number | undefined
}

// Experimental backend contract, also used by @narumitw/pi-usage's companion
// adapter. Registration IDs bind routing, not independent user identity.
export function parseOpenAIAppUsage(
  payload: UnknownRecord,
  clientId: string,
): OpenAIAppUsage {
  if (
    !Array.isArray(payload.items) ||
    payload.items.length > 128 ||
    Object.keys(payload).some(
      (key) => !['items', 'has_more', 'next_cursor'].includes(key),
    ) ||
    (payload.has_more !== undefined && payload.has_more !== false) ||
    (payload.next_cursor !== undefined &&
      payload.next_cursor !== null &&
      payload.next_cursor !== '')
  ) {
    throw new Error(
      'ChatGPT app usage requires a complete registration list; pagination is unsupported.',
    )
  }
  const apps = payload.items.map(asObject)
  if (
    apps.some((app) => !app || typeof app.id !== 'string' || !app.id.trim())
  ) {
    throw new Error('ChatGPT app usage returned invalid registration data.')
  }
  const matches = apps.filter((app) => app?.id === clientId)
  if (!clientId || matches.length !== 1) {
    throw new Error(
      'The OpenAI app registration was not uniquely found. Use the same ChatGPT account and workspace for /login openai and /login openai-codex.',
    )
  }
  const app = matches[0]
  if (
    !Array.isArray(app?.windows) ||
    app.windows.length === 0 ||
    app.windows.length > 32
  ) {
    throw new Error('ChatGPT app usage returned no supported windows.')
  }
  const allowance = app.allowed_usage_percent
  if (allowance !== undefined && !isPercent(allowance)) {
    throw new Error('ChatGPT app usage returned an invalid allowance.')
  }
  return {
    windows: app.windows.map(normalizeWindow),
    ...(allowance === undefined ? {} : { allowance: allowance as number }),
  }
}

export function normalizeOpenAICompanion(
  payload: UnknownRecord,
  app: OpenAIAppUsage,
): UsageReport {
  const limits = asObject(payload.rate_limit)
  const isPro = isOpenAIProPlan(payload.plan_type)
  const windows = [limits?.primary_window, limits?.secondary_window]
    .filter((window) => window !== undefined && window !== null)
    .map(normalizeWindow)
    .filter((window) => !isPro || window.label === 'week')
  if (windows.length === 0) {
    throw new Error('ChatGPT plan usage returned no supported windows.')
  }

  const report = makeWindowReport(OPENAI_CHATGPT_NAME, windows)
  const appWindows = app.windows.filter(
    (window) => !isPro || window.label === 'week',
  )
  return {
    provider: report.provider,
    status: `plan ${report.status}`,
    lines: [
      ...report.lines.map((line) => `Plan ${line}`),
      // App percentages are not independently verified against the UI.
      // Keep reset/window information separate from shared plan usage.
      ...appWindows.map(
        (window) =>
          `App ${window.label}: ${
            window.resetAt === undefined
              ? 'reset time unavailable'
              : `resets in ${formatCountdown(window.resetAt)}`
          }`,
      ),
      ...(app.allowance === undefined
        ? []
        : [
            `App allowance: ${app.allowance}% of shared plan usage (cap, not remaining quota)`,
          ]),
      'Source: experimental ChatGPT companion endpoints (Codex OAuth).',
      'Both logins must use the same account/workspace; registration matching is not independent identity proof.',
      `Manage usage: ${CHATGPT_USAGE_SETTINGS_URL}`,
    ],
  }
}

function normalizeWindow(value: unknown): UsageWindow {
  const window = asObject(value)
  const used = window?.used_percent
  const remaining = window?.remaining_percent
  const seconds = window?.limit_window_seconds
  const reset = window?.reset_at
  if (
    !isPercent(used) ||
    (remaining !== undefined &&
      (!isPercent(remaining) || Math.abs(used + remaining - 100) > 1)) ||
    typeof seconds !== 'number' ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    (reset !== undefined &&
      (typeof reset !== 'number' ||
        !Number.isSafeInteger(reset) ||
        reset < 0 ||
        reset > 8_640_000_000_000))
  ) {
    throw new Error(
      'ChatGPT usage returned an invalid or contradictory quota window.',
    )
  }
  return {
    label: windowLabel(seconds),
    usedPercent: Math.round(used * 100) / 100,
    remainingPercent: Math.round((remaining ?? 100 - used) * 100) / 100,
    ...(reset === undefined ? {} : { resetAt: (reset as number) * 1000 }),
  }
}

function isPercent(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  )
}

function windowLabel(seconds: number): string {
  if (seconds === 604_800) {
    return 'week'
  }
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400}d`
  }
  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`
  }
  return `${seconds}s`
}
