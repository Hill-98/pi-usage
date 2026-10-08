import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

type UnknownRecord = Record<string, unknown>
type ProviderKind =
  | 'codex'
  | 'kimi'
  | 'deepseek'
  | 'moonshot'
  | 'minimax'
  | 'openrouter'
  | 'vercel'
  | 'opencode'

interface ProviderDefinition {
  id: string
  name: string
  aliases?: string[] | undefined
  origins: string[]
  url?: string | undefined
  kind: ProviderKind
  currency?: string | undefined
  region?: 'global' | 'china' | undefined
}

interface UsageWindow {
  label: string
  usedPercent?: number | undefined
  remainingPercent?: number | undefined
  resetAt?: number | undefined
}

interface UsageReport {
  provider: string
  lines: string[]
  status: string
}

type ResolvedUsageAuth = Extract<
  Awaited<ReturnType<ExtensionContext['modelRegistry']['getApiKeyAndHeaders']>>,
  { ok: true }
>

type ProviderChoice = Pick<ProviderDefinition, 'id' | 'name' | 'aliases'>

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 1024 * 1024

const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    aliases: ['openai', 'codex'],
    origins: ['https://chatgpt.com'],
    url: 'https://chatgpt.com/backend-api/wham/usage',
    kind: 'codex',
  },
  {
    id: 'kimi-coding',
    name: 'Kimi For Coding',
    aliases: ['kimi', 'kimi-coding'],
    origins: ['https://api.kimi.com'],
    url: 'https://api.kimi.com/coding/v1/usages',
    kind: 'kimi',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek API',
    origins: ['https://api.deepseek.com'],
    url: 'https://api.deepseek.com/user/balance',
    kind: 'deepseek',
  },
  {
    id: 'moonshotai',
    name: 'Moonshot AI Global',
    aliases: ['moonshot', 'moonshot-global'],
    origins: ['https://api.moonshot.ai'],
    url: 'https://api.moonshot.ai/v1/users/me/balance',
    kind: 'moonshot',
    currency: 'USD',
  },
  {
    id: 'moonshotai-cn',
    name: 'Moonshot AI China',
    aliases: ['moonshot-cn'],
    origins: ['https://api.moonshot.cn'],
    url: 'https://api.moonshot.cn/v1/users/me/balance',
    kind: 'moonshot',
    currency: 'CNY',
  },
  {
    id: 'minimax',
    name: 'MiniMax Global',
    aliases: ['minimax-global'],
    origins: ['https://api.minimax.io'],
    kind: 'minimax',
    region: 'global',
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax China',
    aliases: ['minimax-china'],
    origins: ['https://api.minimaxi.com'],
    kind: 'minimax',
    region: 'china',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    origins: ['https://openrouter.ai'],
    url: 'https://openrouter.ai/api/v1/key',
    kind: 'openrouter',
  },
  {
    id: 'vercel-ai-gateway',
    name: 'Vercel AI Gateway',
    aliases: ['vercel'],
    origins: ['https://ai-gateway.vercel.sh'],
    url: 'https://ai-gateway.vercel.sh/v1/credits',
    kind: 'vercel',
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    aliases: ['opencode'],
    origins: ['https://opencode.ai'],
    url: 'https://opencode.ai/zen/go/v1/usage',
    kind: 'opencode',
  },
]

export function getSupportedProviders(): ProviderChoice[] {
  return PROVIDERS.map(({ id, name, aliases }) => ({ id, name, aliases }))
}

export async function queryUsage(
  ctx: ExtensionContext,
  model: Model<Api>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<UsageReport> {
  const provider = PROVIDERS.find((item) => item.id === model?.provider)
  if (!provider) {
    throw new Error('This provider does not have a usage adapter.')
  }

  if (provider.kind === 'codex' && !ctx.modelRegistry.isUsingOAuth(model)) {
    throw new Error(
      'OpenAI API-key usage is not available here. This adapter requires OpenAI Codex subscription OAuth.',
    )
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
  if (!auth?.ok) {
    throw new Error(
      `No valid ${provider.name} credentials were found. Sign in again or check the provider setup.`,
    )
  }

  assertOfficialOrigin(provider, model, auth)
  const headers = createRequestHeaders(provider, auth)
  let url = provider.url

  if (provider.kind === 'minimax') {
    const key = getCredential(auth)
    if (!key) {
      throw new Error(`No valid ${provider.name} API key was found.`)
    }
    const apiRoot =
      provider.region === 'china'
        ? 'https://api.minimaxi.com'
        : 'https://api.minimax.io'
    if (key.startsWith('sk-api-')) {
      url = `${apiRoot}/account/query_balance`
    } else {
      url = `${apiRoot}/v1/token_plan/remains`
    }
  }

  if (!url) {
    throw new Error(`${provider.name} usage endpoint is not configured.`)
  }
  const payload = await fetchJson(url, headers, fetchImpl)
  const report = normalizeProviderResponse(provider, payload, {
    minimaxApiKey:
      provider.kind === 'minimax' ? getCredential(auth) : undefined,
  })
  return report
}

function assertOfficialOrigin(
  provider: ProviderDefinition,
  model: Model<Api>,
  auth: ResolvedUsageAuth,
): void {
  const modelOrigin = parseOrigin(model.baseUrl)
  const authOrigin = auth.baseUrl ? parseOrigin(auth.baseUrl) : undefined
  if (!modelOrigin || !provider.origins.includes(modelOrigin)) {
    throw new Error(
      `${provider.name} usage is disabled for custom or proxy endpoints; credentials were not sent.`,
    )
  }
  if (auth.baseUrl && (!authOrigin || authOrigin !== modelOrigin)) {
    throw new Error(
      `${provider.name} usage is disabled because the resolved auth endpoint differs from the model endpoint.`,
    )
  }
}

function createRequestHeaders(
  provider: ProviderDefinition,
  auth: ResolvedUsageAuth,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const authorization = readHeader(auth.headers, 'authorization')
  const credential = getCredential(auth)
  if (provider.kind === 'codex') {
    if (!authorization && !credential) {
      throw new Error('OpenAI Codex authorization is unavailable.')
    }
    headers.Authorization = authorization || `Bearer ${credential}`
    const accountId = readHeader(auth.headers, 'chatgpt-account-id')
    if (accountId) {
      headers['ChatGPT-Account-Id'] = accountId
    }
    headers['User-Agent'] = 'pi-usage-display'
    return headers
  }

  if (provider.kind === 'minimax') {
    if (!credential) {
      throw new Error(`No valid ${provider.name} API key was found.`)
    }
    headers.Authorization = authorization || `Bearer ${credential}`
    return headers
  }

  if (!authorization && !credential) {
    throw new Error(`No valid ${provider.name} credentials were found.`)
  }
  headers.Authorization = authorization || `Bearer ${credential}`
  return headers
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<UnknownRecord> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        `Usage request failed with HTTP ${response.status}. Check provider access or sign in again.`,
      )
    }
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel()
      throw new Error('The usage response was too large to process safely.')
    }
    const text = await readLimitedText(response, MAX_RESPONSE_BYTES)
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error()
      }
      return parsed as UnknownRecord
    } catch {
      throw new Error('The provider returned an invalid usage response.')
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('The provider usage request timed out.')
    }
    if (error instanceof Error && error.message.startsWith('Usage ')) {
      throw error
    }
    if (error instanceof Error && error.message.includes('usage response')) {
      throw error
    }
    throw new Error('Could not connect to the provider usage endpoint.')
  } finally {
    clearTimeout(timeout)
  }
}

async function readLimitedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    return ''
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new Error('The usage response was too large to process safely.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function normalizeProviderResponse(
  provider: ProviderDefinition,
  payload: UnknownRecord,
  options: { minimaxApiKey?: string | undefined } = {},
): UsageReport {
  switch (provider.kind) {
    case 'codex':
      return normalizeCodex(payload)
    case 'kimi':
      return normalizeKimi(payload)
    case 'deepseek':
      return normalizeDeepSeek(payload)
    case 'moonshot':
      return normalizeMoonshot(payload, provider)
    case 'minimax':
      return normalizeMiniMax(payload, provider, options.minimaxApiKey ?? '')
    case 'openrouter':
      return normalizeOpenRouter(payload)
    case 'vercel':
      return normalizeVercel(payload)
    case 'opencode':
      return normalizeOpenCode(payload)
    default:
      throw new Error('This provider does not have a usage normalizer.')
  }
}

export function normalizeCodex(payload: UnknownRecord): UsageReport {
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

export function normalizeKimi(payload: UnknownRecord): UsageReport {
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
      addWindow(row.window ?? row.name ?? row.period ?? row.duration, row)
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

function normalizeDeepSeek(payload: UnknownRecord): UsageReport {
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

function normalizeMoonshot(
  payload: UnknownRecord,
  provider: ProviderDefinition,
): UsageReport {
  const data = asObject(payload.data) ?? payload
  const available = formatAmount(data.available_balance)
  if (!available) {
    throw new Error('Moonshot returned no account balance data.')
  }
  const currency = provider.currency ?? 'USD'
  const lines = [`${currency} ${available} available`]
  const voucher = formatAmount(data.voucher_balance)
  const cash = formatAmount(data.cash_balance)
  if (voucher) {
    lines.push(`${currency} ${voucher} voucher balance`)
  }
  if (cash) {
    lines.push(`${currency} ${cash} cash balance`)
  }
  return makeBalanceReport(provider.name, lines)
}

function normalizeMiniMax(
  payload: UnknownRecord,
  provider: ProviderDefinition,
  apiKey: string,
): UsageReport {
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

function normalizeOpenRouter(payload: UnknownRecord): UsageReport {
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

function normalizeVercel(payload: UnknownRecord): UsageReport {
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

function normalizeOpenCode(payload: UnknownRecord): UsageReport {
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

function makeWindowReport(
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

function makeBalanceReport(provider: string, lines: string[]): UsageReport {
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

function getCredential(auth: ResolvedUsageAuth): string | undefined {
  if (typeof auth.apiKey === 'string' && auth.apiKey.trim()) {
    return stripBearer(auth.apiKey.trim())
  }
  const authorization = readHeader(auth.headers, 'authorization')
  return authorization ? stripBearer(authorization) : undefined
}

function stripBearer(value: string): string {
  return value.replace(/^Bearer\s+/i, '')
}

function readHeader(
  headers: ResolvedUsageAuth['headers'],
  target: string,
): string | undefined {
  if (!headers || typeof headers !== 'object') {
    return undefined
  }
  const key = Object.keys(headers).find((name) => name.toLowerCase() === target)
  const value = key ? headers[key] : undefined
  return value == null ? undefined : String(value)
}

function parseOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

function asObject(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function formatAmount(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return undefined
  }
  const text = String(value).trim()
  if (!/^-?\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) {
    return undefined
  }
  return text
}

function normalizeTimestamp(value: unknown): number | undefined {
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

function safeLabel(value: unknown, fallback: string): string {
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
