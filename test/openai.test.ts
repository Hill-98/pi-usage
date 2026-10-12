import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import test from 'node:test'
import type { Api, AuthResult, Model } from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import piUsageExtension from '../src/index.ts'
import type { UnknownRecord } from '../src/usage/types.ts'
import {
  getSupportedProviders,
  queryUsage,
  USAGE_CACHE_TTL_MS,
} from '../src/usage.ts'

type AuthResolution = Awaited<
  ReturnType<ExtensionContext['modelRegistry']['getApiKeyAndHeaders']>
>

const model = {
  provider: 'openai',
  api: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
} as Model<Api>
const codexModel = {
  provider: 'openai-codex',
  api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
} as Model<Api>
const usageUrl = 'https://chatgpt.com/backend-api/wham/usage'
const appsUrl = `${usageUrl}/chatpass/apps`

test('openai selects the new adapter, not an alias of openai-codex', () => {
  const matches = getSupportedProviders().filter(
    (provider) =>
      provider.id === 'openai' || provider.aliases?.includes('openai'),
  )
  assert.deepEqual(
    matches.map((provider) => provider.id),
    ['openai'],
  )
  assert.ok(
    getSupportedProviders().some((provider) => provider.id === 'openai-codex'),
  )
})

test('OpenAI without a companion shows setup guidance without HTTP or cached Codex quotas', async (t) => {
  const fixture = await createFixture(t)
  await writeFile(
    join(fixture.options.directory, 'openai-codex.json'),
    JSON.stringify({
      version: 1,
      providerId: 'openai-codex',
      lastRefreshedAt: Date.now(),
      report: {
        provider: 'OpenAI Codex',
        lines: ['week: 99% remaining'],
        status: 'week 99%',
      },
    }),
  )
  const report = await fixture.query()

  assert.equal(fixture.requests.length, 0)
  assert.equal(report.provider, 'OpenAI (ChatGPT subscription)')
  assert.match(report.lines.join('\n'), /chatgpt\.com\/settings\/usage/)
  assert.match(report.lines.join('\n'), /\/login openai-codex.*same ChatGPT/)
  assert.doesNotMatch(JSON.stringify(report), /%|resets in|test-native-token/)
  assert.deepEqual(await readdir(fixture.options.directory), [
    'openai-codex.json',
  ])
})

test('OpenAI queries app registration then shared plan usage with companion credentials only', async (t) => {
  const fixture = await createFixture(t, true)
  const report = await fixture.query()

  assert.deepEqual(
    fixture.requests.map((request) => request.url),
    [appsUrl, usageUrl],
  )
  for (const request of fixture.requests) {
    const headers = new Headers(request.init?.headers)
    assert.equal(request.init?.method, 'GET')
    assert.equal(request.init?.redirect, 'error')
    assert.equal(
      headers.get('authorization'),
      `Bearer ${fixture.companionToken}`,
    )
    assert.equal(headers.get('chatgpt-account-id'), 'test-account')
    assert.equal(headers.has('cookie'), false)
    assert.equal(headers.has('x-native-secret'), false)
    assert.ok(request.init?.signal)
    assert.doesNotMatch(JSON.stringify(request.init), /test-native-token/)
  }
  assert.equal(report.provider, 'OpenAI (ChatGPT subscription)')
  assert.match(report.lines.join('\n'), /Plan 5h: 75% remaining/)
  assert.match(report.lines.join('\n'), /Plan week: 90% remaining/)
  assert.match(report.status, /plan 5h 75% · week 90%/)
  assert.doesNotMatch(JSON.stringify(report), /test-account|test-client/)
  assert.ok(
    report.lines
      .filter(
        (line) => line.startsWith('App ') && !line.startsWith('App allowance'),
      )
      .every((line) => !line.includes('%')),
  )
})

test('OpenAI companion reports are cached for five minutes without persisting secrets or identifiers', async (t) => {
  const fixture = await createFixture(t, true)
  let now = Date.now()
  const options = { ...fixture.options, now: () => now }
  const run = () => queryUsage(fixture.ctx, model, fixture.fetchImpl, options)
  const original = await run()
  now += USAGE_CACHE_TTL_MS - 1
  assert.deepEqual(await run(), original)
  assert.equal(fixture.requests.length, 2)
  now += 1
  await run()
  assert.equal(fixture.requests.length, 4)

  const files = await readdir(options.directory)
  assert.equal(files.length, 1)
  assert.match(files[0] ?? '', /^openai-[a-f0-9]{64}\.json$/)
  const cached = await readFile(join(options.directory, files[0] ?? ''), 'utf8')
  for (const secret of [
    'test-native-token',
    'test-native-refresh',
    'test-client',
    'test-account',
    'test-companion-refresh',
    fixture.companionToken,
    'Bearer',
  ]) {
    assert.ok(!cached.includes(secret), 'Cache must contain report data only.')
  }
})

test('concurrent OpenAI queries share one companion refresh', async (t) => {
  const fixture = await createFixture(t, true)
  const reports = await Promise.all([fixture.query(), fixture.query()])
  assert.deepEqual(reports[0], reports[1])
  assert.equal(fixture.requests.length, 2)
})

test('removing companion login restores web-only guidance instead of using cached quotas', async (t) => {
  const fixture = await createFixture(t, true)
  await fixture.query()
  fixture.providers['openai-codex'] = undefined
  fixture.grants['openai-codex'] = undefined
  const report = await fixture.query()
  assert.equal(fixture.requests.length, 2)
  assert.match(report.lines.join('\n'), /\/login openai-codex/)
  assert.doesNotMatch(report.status, /%/)
})

test('different native registrations or companion accounts cannot reuse an OpenAI cache', async (t) => {
  const fixture = await createFixture(t, true)
  await fixture.query()
  fixture.grants.openai = {
    ...fixture.grants.openai,
    clientId: 'another-client',
  }
  fixture.payloads.apps = appPayload('another-client')
  await fixture.query()
  assert.equal(fixture.requests.length, 4)

  const token = syntheticCodexToken('another-account')
  fixture.providers['openai-codex'] = {
    source: 'OAuth',
    auth: {
      apiKey: token,
      headers: { 'ChatGPT-Account-Id': 'another-account' },
    },
  }
  fixture.authByProvider['openai-codex'] = {
    ok: true,
    ...fixture.providers['openai-codex'].auth,
  }
  fixture.grants['openai-codex'] = {
    ...fixture.grants['openai-codex'],
    access: token,
    accountId: 'another-account',
  }
  await fixture.query()
  assert.equal(fixture.requests.length, 6)
  assert.equal((await readdir(fixture.options.directory)).length, 3)
})

test('OAuth token rotation for the same registration/account preserves the five-minute cache', async (t) => {
  const fixture = await createFixture(t, true)
  await fixture.query()
  fixture.providers.openai = {
    source: 'OAuth',
    auth: { apiKey: 'rotated-native-token' },
  }
  fixture.authByProvider.openai = {
    ok: true,
    ...fixture.providers.openai.auth,
  }
  fixture.grants.openai = {
    ...fixture.grants.openai,
    access: 'rotated-native-token',
    refresh: 'rotated-refresh',
  }
  await fixture.query()
  assert.equal(fixture.requests.length, 2)
})

test('OpenAI API keys are rejected before resolving or sending credentials', async (t) => {
  const fixture = await createFixture(t)
  fixture.ctx.modelRegistry.isUsingOAuth = () => false
  fixture.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
    assert.fail('API-key mode must not resolve subscription credentials.')
  }
  await assert.rejects(fixture.query(), /OpenAI API-key usage is not available/)
})

test('missing or expired OpenAI credentials return a safe sign-in error', async (t) => {
  const fixture = await createFixture(t)
  fixture.authByProvider.openai = {
    ok: false,
    error: 'private provider authentication details',
  }
  await assert.rejects(fixture.query(), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /No valid OpenAI.*credentials/)
    assert.doesNotMatch(error.message, /private provider/)
    return true
  })
})

test('a successful auth resolution without a bearer cannot claim OpenAI subscription access', async (t) => {
  const fixture = await createFixture(t)
  fixture.authByProvider.openai = { ok: true, headers: {} }
  await assert.rejects(fixture.query(), /authorization is unavailable/)
})

test('OpenAI revalidates OAuth source instead of trusting its cached OAuth flag', async (t) => {
  const fixture = await createFixture(t, true)
  fixture.providers.openai = {
    source: 'OPENAI_API_KEY',
    auth: { apiKey: 'test-native-token' },
  }
  await assert.rejects(fixture.query(), /OpenAI API-key usage/)
  assert.equal(fixture.requests.length, 0)
})

test('cached numerical reports cannot bypass a changed runtime auth source', async (t) => {
  const fixture = await createFixture(t, true)
  await fixture.query()
  fixture.providers.openai = {
    source: 'OPENAI_API_KEY',
    auth: { apiKey: 'test-native-token' },
  }
  await assert.rejects(fixture.query(), /OpenAI API-key usage/)
  assert.equal(fixture.requests.length, 2)
})

test('OpenAI requires complete native registration metadata matching runtime auth', async (t) => {
  const fixture = await createFixture(t, true)
  for (const patch of [
    { access: 'another-token' },
    { type: 'api_key' },
    { refresh: '' },
    { expires: 0 },
    { clientId: '' },
    { scopes: ['openid'] },
  ]) {
    const original = fixture.grants.openai
    fixture.grants.openai = { ...original, ...patch }
    await assert.rejects(
      fixture.query(),
      /OAuth metadata|registration metadata/,
    )
    fixture.grants.openai = original
  }
  assert.equal(fixture.requests.length, 0)
})

test('native model Authorization overrides, removals, and duplicates fail closed', async (t) => {
  const fixture = await createFixture(t, true)
  for (const headers of [
    { Authorization: 'Bearer another-token' },
    { Authorization: null },
    { Authorization: 'Basic unavailable' },
    {
      Authorization: 'Bearer test-native-token',
      authorization: 'Bearer test-native-token',
    },
  ]) {
    fixture.authByProvider.openai = {
      ok: true,
      apiKey: 'test-native-token',
      headers,
    }
    await assert.rejects(
      fixture.query(),
      /does not match|unavailable|ambiguous/,
    )
  }
  assert.equal(fixture.requests.length, 0)
})

test('OpenAI rejects custom model and resolved auth origins before HTTP', async (t) => {
  const fixture = await createFixture(t, true)
  await assert.rejects(
    queryUsage(
      fixture.ctx,
      { ...model, baseUrl: 'https://proxy.example.invalid/v1' },
      fixture.fetchImpl,
      fixture.options,
    ),
    /custom or proxy endpoints/,
  )
  fixture.authByProvider.openai = {
    ok: true,
    apiKey: 'test-native-token',
    baseUrl: 'https://chatgpt.com/backend-api',
  }
  await assert.rejects(fixture.query(), /resolved auth endpoint differs/)
  assert.equal(fixture.requests.length, 0)
})

test('companion API-key auth is not treated as a missing login or valid OAuth', async (t) => {
  const fixture = await createFixture(t, true)
  fixture.providers['openai-codex'] = {
    source: 'OPENAI_CODEX_API_KEY',
    auth: { apiKey: fixture.companionToken },
  }
  await assert.rejects(fixture.query(), /companion.*OAuth, not an API key/)
  assert.equal(fixture.requests.length, 0)
})

test('companion credentials, account IDs, and Authorization headers must match runtime auth', async (t) => {
  const fixture = await createFixture(t, true)
  const original = fixture.authByProvider['openai-codex']
  assert.ok(original)
  for (const headers of [
    { Authorization: 'Bearer another-token' },
    { Authorization: null },
    { 'ChatGPT-Account-Id': 'another-account' },
    { 'ChatGPT-Account-Id': null },
    {
      'ChatGPT-Account-Id': 'test-account',
      'chatgpt-account-id': 'test-account',
    },
  ]) {
    fixture.authByProvider['openai-codex'] = {
      ok: true,
      apiKey: fixture.companionToken,
      headers,
    }
    await assert.rejects(fixture.query(), /does not match|ambiguous/)
  }
  fixture.authByProvider['openai-codex'] = original
  fixture.grants['openai-codex'] = {
    ...fixture.grants['openai-codex'],
    accountId: 'another-account',
  }
  await assert.rejects(fixture.query(), /account could not be validated/)
  assert.equal(fixture.requests.length, 0)
})

test('companion custom model or resolved auth origins are rejected', async (t) => {
  const fixture = await createFixture(t, true)
  fixture.ctx.model = {
    ...codexModel,
    baseUrl: 'https://proxy.example.invalid',
  }
  await assert.rejects(fixture.query(), /custom or proxy endpoints/)
  fixture.ctx.model = model
  fixture.authByProvider['openai-codex'] = {
    ok: true,
    apiKey: fixture.companionToken,
    baseUrl: 'https://proxy.example.invalid',
  }
  await assert.rejects(fixture.query(), /resolved auth endpoint differs/)
  assert.equal(fixture.requests.length, 0)
})

test('missing or duplicate app registrations stop before reading plan quotas', async (t) => {
  const fixture = await createFixture(t, true)
  const matching = appPayload().items as unknown[]
  for (const items of [[], [matching[0], matching[0]]]) {
    fixture.payloads.apps = { items }
    await assert.rejects(fixture.query(), /not uniquely found/)
  }
  assert.deepEqual(
    fixture.requests.map((request) => request.url),
    [appsUrl, appsUrl],
  )
})

test('account changes during a companion query stop before the next request', async (t) => {
  const fixture = await createFixture(t, true)
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await fixture.fetchImpl(input, init)
    fixture.providers['openai-codex'] = undefined
    fixture.grants['openai-codex'] = undefined
    return response
  }
  await assert.rejects(
    queryUsage(fixture.ctx, model, fetchImpl, fixture.options),
    /authorization changed/,
  )
  assert.equal(fixture.requests.length, 1)
  assert.deepEqual(await readdir(fixture.options.directory), [])
})

test('companion endpoint and auth-resolution failures never expose secrets or stale quotas', async (t) => {
  const fixture = await createFixture(t, true)
  await assert.rejects(
    queryUsage(
      fixture.ctx,
      model,
      async () =>
        new Response('private body: test-native-token', { status: 401 }),
      fixture.options,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /HTTP 401/)
      assert.doesNotMatch(error.message, /private body|test-native-token/)
      return true
    },
  )
  fixture.ctx.modelRegistry.getProviderAuth = async () => {
    throw new Error(`private refresh failure: ${fixture.companionToken}`)
  }
  await assert.rejects(fixture.query(), /could not be refreshed/)
  assert.deepEqual(await readdir(fixture.options.directory), [])
})

test('model-auth and metadata-reader exceptions are safely redacted', async (t) => {
  const fixture = await createFixture(t, true)
  const getAuth = fixture.ctx.modelRegistry.getApiKeyAndHeaders
  fixture.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
    throw new Error('test-native-token: private auth error')
  }
  await assert.rejects(fixture.query(), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /No valid OpenAI/)
    assert.doesNotMatch(error.message, /test-native-token|private auth/)
    return true
  })
  fixture.ctx.modelRegistry.getApiKeyAndHeaders = getAuth
  await assert.rejects(
    queryUsage(fixture.ctx, model, fixture.fetchImpl, {
      ...fixture.options,
      readCredential: () => {
        throw new Error('test-native-refresh: private metadata error')
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /OAuth metadata/)
      assert.doesNotMatch(error.message, /test-native-refresh|private metadata/)
      return true
    },
  )
  assert.equal(fixture.requests.length, 0)
})

test('the extension handles numerical OpenAI reports at startup and through /usage openai', {
  timeout: 5000,
}, async (t) => {
  const fixture = await createFixture(t, true)
  type Command = Parameters<ExtensionAPI['registerCommand']>[1]
  type EventHandler = (event: unknown, ctx: ExtensionContext) => void
  const handlers = new Map<string, EventHandler>()
  let command: Command | undefined
  const statuses: Array<string | undefined> = []
  const notifications: string[] = []
  const ready = Promise.withResolvers<void>()
  const ctx = {
    ...fixture.ctx,
    hasUI: true,
    ui: {
      setStatus: (_key: string, text: string | undefined) => {
        statuses.push(text)
        if (text?.startsWith('OpenAI (ChatGPT subscription): plan ')) {
          ready.resolve()
        }
      },
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionCommandContext
  const pi = {
    registerCommand: (name: string, definition: Command) => {
      if (name === 'usage') {
        command = definition
      }
    },
    on: (event: string, handler: EventHandler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI

  piUsageExtension(pi, (context, selected) =>
    queryUsage(context, selected, fixture.fetchImpl, fixture.options),
  )
  t.after(() => handlers.get('session_shutdown')?.({}, ctx))
  handlers.get('session_start')?.({}, ctx)
  await ready.promise
  assert.deepEqual(statuses, [
    'usage…',
    'OpenAI (ChatGPT subscription): plan 5h 75% · week 90%',
  ])

  assert.ok(command)
  await command.handler('', ctx)
  await command.handler('openai', ctx)
  assert.equal(notifications.length, 2)
  assert.equal(fixture.requests.length, 2)
  for (const message of notifications) {
    assert.match(message, /^OpenAI \(ChatGPT subscription\) usage/)
    assert.match(message, /Plan week: 90% remaining/)
  }
  assert.equal(statuses.filter((status) => status === 'usage…').length, 1)
})

async function createFixture(t: TestContext, withCompanion = false) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-usage-openai-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const companionToken = syntheticCodexToken('test-account')
  const providers: Record<string, AuthResult | undefined> = {
    openai: {
      source: 'OAuth',
      auth: { apiKey: 'test-native-token' },
    },
    'openai-codex': withCompanion
      ? {
          source: 'OAuth',
          auth: {
            apiKey: companionToken,
            headers: { 'ChatGPT-Account-Id': 'test-account' },
          },
        }
      : undefined,
  }
  const authByProvider: Record<string, AuthResolution> = {
    openai: {
      ok: true,
      apiKey: 'test-native-token',
      headers: { 'x-native-secret': 'must-not-be-forwarded' },
    },
    'openai-codex': {
      ok: true,
      apiKey: companionToken,
      headers: {
        'ChatGPT-Account-Id': 'test-account',
        Cookie: 'must-not-be-forwarded',
      },
    },
  }
  const grants: Record<string, UnknownRecord | undefined> = {
    openai: {
      type: 'oauth',
      access: 'test-native-token',
      refresh: 'test-native-refresh',
      expires: Date.now() + 3_600_000,
      clientId: 'test-client',
      scopes: ['openid', 'chatgpt.tokens.use.direct'],
    },
    'openai-codex': withCompanion
      ? {
          type: 'oauth',
          access: companionToken,
          refresh: 'test-companion-refresh',
          expires: Date.now() + 3_600_000,
          accountId: 'test-account',
        }
      : undefined,
  }
  const ctx = {
    model,
    modelRegistry: {
      isUsingOAuth: () => true,
      getAll: () => [model, codexModel],
      getAvailable: () => [model, codexModel],
      getProviderAuth: async (providerId: string) => providers[providerId],
      getApiKeyAndHeaders: async (selected: Model<Api>) =>
        authByProvider[selected.provider] ?? {
          ok: false,
          error: 'unavailable',
        },
    },
  } as unknown as ExtensionContext
  const options = {
    directory,
    readCredential: (providerId: string) => grants[providerId],
  }
  const payloads = {
    apps: appPayload(),
    plan: {
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18_000,
          reset_at: 1_800_000_000,
        },
        secondary_window: {
          used_percent: 10,
          limit_window_seconds: 604_800,
          reset_at: 1_800_100_000,
        },
      },
    } as UnknownRecord,
  }
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    assert.ok(url === appsUrl || url === usageUrl)
    return new Response(
      JSON.stringify(url === appsUrl ? payloads.apps : payloads.plan),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  return {
    ctx,
    options,
    providers,
    authByProvider,
    grants,
    companionToken,
    payloads,
    requests,
    fetchImpl,
    query: () => queryUsage(ctx, model, fetchImpl, options),
  }
}

function appPayload(clientId = 'test-client') {
  return {
    items: [
      {
        id: clientId,
        allowed_usage_percent: 50,
        windows: [
          {
            used_percent: 40,
            remaining_percent: 60,
            limit_window_seconds: 18_000,
            reset_at: 1_800_000_000,
          },
          {
            used_percent: 20,
            limit_window_seconds: 604_800,
            reset_at: 1_800_100_000,
          },
        ],
      },
    ],
  } as UnknownRecord
}

function syntheticCodexToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url')
  return `synthetic.${payload}.signature`
}
