import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { normalizeKimi } from '../src/usage/providers/kimi-coding.ts'
import {
  isOpenAIProPlan,
  normalizeCodex,
} from '../src/usage/providers/openai-codex.ts'
import { queryUsage, USAGE_CACHE_TTL_MS } from '../src/usage.ts'

test('OpenAI non-Pro reports both the 5-hour and weekly windows', () => {
  const report = normalizeCodex({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 35, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 20, reset_at: 1_800_100_000 },
    },
  })

  assert.deepEqual(
    report.lines.map((line) => line.split(':')[0]),
    ['5h', 'week'],
  )
  assert.match(report.lines[0] ?? '', /65% remaining \(35% used\)/)
  assert.match(report.lines[1] ?? '', /80% remaining \(20% used\)/)
})

test('OpenAI Pro reports weekly only, even if the API includes a primary window', () => {
  const report = normalizeCodex({
    plan_type: 'pro',
    rate_limit: {
      primary_window: { used_percent: 90, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 12, reset_at: 1_800_100_000 },
    },
  })

  assert.deepEqual(
    report.lines.map((line) => line.split(':')[0]),
    ['week'],
  )
  assert.match(report.provider, /Pro/)
})

test('OpenAI window duration can place the weekly limit in the primary slot', () => {
  const report = normalizeCodex({
    plan_type: 'pro',
    rate_limit: {
      primary_window: {
        used_percent: 42,
        limit_window_seconds: 604_800,
        reset_at: 1_800_100_000,
      },
      secondary_window: null,
    },
  })

  assert.deepEqual(
    report.lines.map((line) => line.split(':')[0]),
    ['week'],
  )
  assert.match(report.lines[0] ?? '', /58% remaining/)
})

test('OpenAI Pro plan names are recognized without matching unrelated plans', () => {
  assert.equal(isOpenAIProPlan('pro'), true)
  assert.equal(isOpenAIProPlan('chatgpt-pro'), true)
  assert.equal(isOpenAIProPlan('plus'), false)
})

test('Kimi ratio windows are rendered as remaining quota', () => {
  const report = normalizeKimi({
    usages: {
      limit_5h: { used_ratio: 0.25, reset_time: 1_800_000_000 },
      limit_week: { used_ratio: 0.6, reset_time: 1_800_100_000 },
    },
  })

  assert.deepEqual(
    report.lines.map((line) => line.split(':')[0]),
    ['5h', 'week'],
  )
  assert.match(report.lines[0] ?? '', /75% remaining/)
  assert.match(report.lines[1] ?? '', /40% remaining/)
})

test('Kimi count windows derive remaining counts from the limit', () => {
  const report = normalizeKimi({
    limits: [
      { window: '5h', limit: 100, used: 20 },
      { window: 'weekly', limit: 500, remaining: 300 },
    ],
  })

  assert.match(report.lines[0] ?? '', /80% remaining/)
  assert.match(report.lines[1] ?? '', /60% remaining/)
})

test('Kimi booster wallet fixed-point amount is converted to currency units', () => {
  const report = normalizeKimi({
    usages: {
      limit_week: { used_ratio: 0.2 },
    },
    boosterWallet: {
      amountLeft: 123_456_789,
      currency: 'USD',
    },
  })

  assert.equal(report.lines[1], 'USD 1.23456789 booster wallet remaining')
})

test('OpenAI requests forward only the bearer and optional account header', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-usage-cache-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let sentHeaders: HeadersInit | undefined
  const ctx = {
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        apiKey: 'fake-token',
        headers: {
          Authorization: 'Bearer fake-token',
          'ChatGPT-Account-Id': 'fake-account',
          Cookie: 'must-not-be-forwarded',
        },
      }),
    },
  } as unknown as ExtensionContext
  const model = {
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
  } as Model<Api>

  const report = await queryUsage(
    ctx,
    model,
    async (_url, init) => {
      sentHeaders = init?.headers
      return new Response(
        JSON.stringify({
          plan_type: 'pro',
          rate_limit: {
            primary_window: { used_percent: 90 },
            secondary_window: { used_percent: 20 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
    { directory },
  )

  const headers = new Headers(sentHeaders)
  assert.equal(headers.get('authorization'), 'Bearer fake-token')
  assert.equal(headers.get('chatgpt-account-id'), 'fake-account')
  assert.equal(headers.has('cookie'), false)
  assert.deepEqual(
    report.lines.map((line) => line.split(':')[0]),
    ['week'],
  )
})

test('custom provider endpoints are rejected before credentials are sent', async () => {
  let fetchCalled = false
  const ctx = {
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        apiKey: 'fake-token',
        headers: {},
      }),
    },
  } as unknown as ExtensionContext
  const model = {
    provider: 'openai-codex',
    baseUrl: 'https://proxy.example.invalid',
  } as Model<Api>

  await assert.rejects(
    queryUsage(ctx, model, async () => {
      fetchCalled = true
      return new Response('{}')
    }),
    /custom or proxy endpoints/,
  )
  assert.equal(fetchCalled, false)
})

test('usage reports are cached per provider for five minutes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-usage-cache-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  let now = Date.now()
  let fetchCalls = 0
  const options = { directory, now: () => now }
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1
    return jsonResponse({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 25 },
        secondary_window: { used_percent: 10 },
      },
    })
  }
  const ctx = createUsageContext()
  const model = createUsageModel(
    'openai-codex',
    'https://chatgpt.com/backend-api/codex',
  )

  const original = await queryUsage(ctx, model, fetchImpl, options)
  now += USAGE_CACHE_TTL_MS - 1
  const cached = await queryUsage(ctx, model, fetchImpl, options)
  assert.deepEqual(cached, original)
  assert.equal(fetchCalls, 1)

  now += 1
  await queryUsage(ctx, model, fetchImpl, options)
  assert.equal(fetchCalls, 2)

  const cachedFile = await readFile(
    join(directory, 'openai-codex.json'),
    'utf8',
  )
  assert.doesNotMatch(cachedFile, /test-usage-token|Bearer/)
  if (process.platform !== 'win32') {
    const info = await stat(join(directory, 'openai-codex.json'))
    assert.equal(info.mode & 0o777, 0o600)
  }
})

test('usage cache files are isolated by provider', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-usage-cache-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const calls = { openai: 0, kimi: 0 }
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).startsWith('https://chatgpt.com/')) {
      calls.openai += 1
      return jsonResponse({
        plan_type: 'plus',
        rate_limit: {
          primary_window: { used_percent: 25 },
          secondary_window: { used_percent: 10 },
        },
      })
    }
    calls.kimi += 1
    return jsonResponse({
      usages: {
        limit_5h: { used_ratio: 0.25 },
        limit_week: { used_ratio: 0.5 },
      },
    })
  }
  const ctx = createUsageContext()
  const options = { directory }
  const openai = createUsageModel(
    'openai-codex',
    'https://chatgpt.com/backend-api/codex',
  )
  const kimi = createUsageModel('kimi-coding', 'https://api.kimi.com/coding/v1')

  await queryUsage(ctx, openai, fetchImpl, options)
  await queryUsage(ctx, kimi, fetchImpl, options)
  await queryUsage(ctx, openai, fetchImpl, options)
  await queryUsage(ctx, kimi, fetchImpl, options)

  assert.deepEqual(calls, { openai: 1, kimi: 1 })
  await stat(join(directory, 'openai-codex.json'))
  await stat(join(directory, 'kimi-coding.json'))
})

test('concurrent requests share one provider refresh', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-usage-cache-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  let fetchCalls = 0
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 50))
    return jsonResponse({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 25 },
        secondary_window: { used_percent: 10 },
      },
    })
  }
  const ctx = createUsageContext()
  const model = createUsageModel(
    'openai-codex',
    'https://chatgpt.com/backend-api/codex',
  )
  const options = { directory }

  await Promise.all([
    queryUsage(ctx, model, fetchImpl, options),
    queryUsage(ctx, model, fetchImpl, options),
  ])

  assert.equal(fetchCalls, 1)
})

function createUsageContext(): ExtensionContext {
  return {
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        apiKey: 'test-usage-token',
        headers: { Authorization: 'Bearer test-usage-token' },
      }),
    },
  } as unknown as ExtensionContext
}

function createUsageModel(provider: string, baseUrl: string): Model<Api> {
  return { provider, baseUrl } as Model<Api>
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
