import { getCredential, readHeader } from '../auth.ts'
import {
  asObject,
  finiteNumber,
  makeWindowReport,
  normalizeTimestamp,
} from '../format.ts'
import type { UnknownRecord, UsageProvider, UsageWindow } from '../types.ts'

export const openAICodexProvider: UsageProvider = {
  id: 'openai-codex',
  name: 'OpenAI Codex',
  aliases: ['openai', 'codex'],
  origins: ['https://chatgpt.com'],
  url: 'https://chatgpt.com/backend-api/wham/usage',
  validateAuth: (ctx, model) => {
    if (!ctx.modelRegistry.isUsingOAuth(model)) {
      throw new Error(
        'OpenAI API-key usage is not available here. This adapter requires OpenAI Codex subscription OAuth.',
      )
    }
  },
  createHeaders: (auth) => {
    const authorization = readHeader(auth.headers, 'authorization')
    const credential = getCredential(auth)
    if (!authorization && !credential) {
      throw new Error('OpenAI Codex authorization is unavailable.')
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: authorization || `Bearer ${credential}`,
      'User-Agent': 'pi-usage-display',
    }
    const accountId = readHeader(auth.headers, 'chatgpt-account-id')
    if (accountId) {
      headers['ChatGPT-Account-Id'] = accountId
    }
    return headers
  },
  normalize: normalizeCodex,
}

export function normalizeCodex(payload: UnknownRecord) {
  const rateLimit = asObject(payload.rate_limit)
  const planType =
    typeof payload.plan_type === 'string' ? payload.plan_type : ''
  const isPro = isOpenAIProPlan(planType)
  const windows: UsageWindow[] = []
  const candidates = [
    normalizeCodexWindow(rateLimit?.primary_window, '5h'),
    normalizeCodexWindow(rateLimit?.secondary_window, 'week'),
  ]
  for (const candidate of candidates) {
    if (!candidate || (isPro && candidate.label !== 'week')) {
      continue
    }
    if (!windows.some((window) => window.label === candidate.label)) {
      windows.push(candidate)
    }
  }

  if (!windows.length) {
    throw new Error('OpenAI returned no supported usage windows.')
  }
  return makeWindowReport(isPro ? 'OpenAI Codex Pro' : 'OpenAI Codex', windows)
}

export function isOpenAIProPlan(planType: unknown): boolean {
  const normalized = String(planType ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
  return (
    normalized === 'pro' ||
    normalized === 'chatgpt_pro' ||
    normalized.startsWith('chatgpt_pro_') ||
    normalized.endsWith('_pro')
  )
}

function normalizeCodexWindow(
  value: unknown,
  fallbackLabel: '5h' | 'week',
): UsageWindow | undefined {
  const row = asObject(value)
  const normalized = normalizePercentWindow(row)
  if (!row || !normalized) {
    return undefined
  }

  const duration = finiteNumber(row.limit_window_seconds)
  const label =
    duration === 5 * 60 * 60
      ? '5h'
      : duration === 7 * 24 * 60 * 60
        ? 'week'
        : fallbackLabel
  return { ...normalized, label }
}

function normalizePercentWindow(
  value: unknown,
): Omit<UsageWindow, 'label'> | undefined {
  const row = asObject(value)
  if (!row) {
    return undefined
  }
  const usedPercent = finiteNumber(row.used_percent)
  if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) {
    return undefined
  }
  return {
    usedPercent: Math.round(usedPercent),
    remainingPercent: Math.round(100 - usedPercent),
    resetAt: normalizeTimestamp(row.reset_at),
  }
}
