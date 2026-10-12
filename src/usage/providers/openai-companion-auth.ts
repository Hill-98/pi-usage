import type { Api, AuthResult, Model } from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { readStoredCredential } from '@earendil-works/pi-coding-agent'
import { asObject } from '../format.ts'
import { assertOfficialOrigin } from '../http.ts'
import type {
  ResolvedUsageAuth,
  UnknownRecord,
  UsageCredentialReader,
} from '../types.ts'

const DIRECT_TOKEN_SCOPE = 'chatgpt.tokens.use.direct'

type RequestAuth = Pick<ResolvedUsageAuth, 'apiKey' | 'headers' | 'baseUrl'>

export interface OpenAIUsageAuth {
  nativeToken: string
  clientId: string
  companion?: {
    token: string
    accountId: string
    headers: Record<string, string>
  }
}

export async function resolveOpenAIUsageAuth(
  ctx: ExtensionContext,
  model: Model<Api>,
  selectedAuth?: ResolvedUsageAuth,
  readCredential: UsageCredentialReader = readStoredCredential,
): Promise<OpenAIUsageAuth> {
  const native = await resolveProviderAuth(ctx, 'openai')
  if (native?.source !== 'OAuth') {
    throw new Error(
      'OpenAI API-key usage is not available here. Sign in with ChatGPT through /login openai to use this adapter.',
    )
  }
  const auth = selectedAuth ?? (await resolveModelAuth(ctx, model))
  assertOfficialOrigin(
    { name: 'OpenAI', origins: ['https://api.openai.com'] },
    model,
    auth,
  )
  assertOfficialOrigin(
    { name: 'OpenAI', origins: ['https://api.openai.com'] },
    model,
    { ok: true, ...native.auth },
  )
  const nativeToken = bearerToken(auth)
  if (!nativeToken) {
    throw new Error('OpenAI ChatGPT authorization is unavailable.')
  }
  if (nativeToken !== bearerToken(native.auth)) {
    throw new Error(
      'The OpenAI model authorization does not match its current OAuth credential.',
    )
  }

  // Pi's public helper supplies registration metadata only. A stored token
  // never selects the account or replaces freshly resolved runtime auth.
  const grant = matchingGrant(readCredential, 'openai', nativeToken)
  const clientId = grant.clientId
  if (
    !validIdentifier(clientId) ||
    !Array.isArray(grant.scopes) ||
    !grant.scopes.every((scope) => typeof scope === 'string') ||
    !grant.scopes.includes(DIRECT_TOKEN_SCOPE)
  ) {
    throw new Error(
      'OpenAI ChatGPT registration metadata is unavailable. Reconnect through /login openai.',
    )
  }
  const result: OpenAIUsageAuth = { nativeToken, clientId }

  const companion = await resolveProviderAuth(ctx, 'openai-codex')
  if (!companion) {
    return result
  }
  if (companion.source !== 'OAuth') {
    throw new Error(
      'ChatGPT companion usage requires /login openai-codex OAuth, not an API key.',
    )
  }
  const companionModel =
    ctx.model?.provider === 'openai-codex'
      ? ctx.model
      : ctx.modelRegistry
          .getAll()
          .find((candidate) => candidate.provider === 'openai-codex')
  if (!companionModel) {
    throw new Error('No OpenAI Codex model is available for companion usage.')
  }
  const companionAuth = await resolveModelAuth(ctx, companionModel)
  const metadata = {
    name: 'OpenAI Codex companion',
    origins: ['https://chatgpt.com'],
  }
  assertOfficialOrigin(metadata, companionModel, companionAuth)
  assertOfficialOrigin(metadata, companionModel, {
    ok: true,
    ...companion.auth,
  })
  const token = bearerToken(companionAuth)
  if (!token || token !== bearerToken(companion.auth)) {
    throw new Error(
      'The Codex companion model authorization does not match its current OAuth credential.',
    )
  }
  const accountId = codexAccountId(token)
  const companionGrant = matchingGrant(readCredential, 'openai-codex', token)
  if (!accountId || companionGrant.accountId !== accountId) {
    throw new Error(
      'The Codex companion OAuth account could not be validated. Reconnect through /login openai-codex.',
    )
  }
  for (const requestAuth of [companionAuth, companion.auth]) {
    const accountHeader = singleHeader(requestAuth, 'chatgpt-account-id')
    if (accountHeader.present && accountHeader.value !== accountId) {
      throw new Error(
        'The Codex companion account header does not match its OAuth account.',
      )
    }
  }
  return {
    ...result,
    companion: {
      token,
      accountId,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'ChatGPT-Account-Id': accountId,
        'User-Agent': 'pi-usage-display',
      },
    },
  }
}

export function sameOpenAIUsageAuth(
  left: OpenAIUsageAuth,
  right: OpenAIUsageAuth,
): boolean {
  return (
    left.nativeToken === right.nativeToken &&
    left.clientId === right.clientId &&
    left.companion?.token === right.companion?.token &&
    left.companion?.accountId === right.companion?.accountId
  )
}

async function resolveProviderAuth(
  ctx: ExtensionContext,
  providerId: string,
): Promise<AuthResult | undefined> {
  try {
    return await ctx.modelRegistry.getProviderAuth(providerId)
  } catch {
    throw new Error(
      'OpenAI OAuth authorization could not be refreshed. Sign in again or retry shortly.',
    )
  }
}

async function resolveModelAuth(
  ctx: ExtensionContext,
  model: Model<Api>,
): Promise<ResolvedUsageAuth> {
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
    if (auth.ok) {
      return auth
    }
  } catch {
    // Provider errors can contain private OAuth response details.
  }
  throw new Error(
    'OpenAI OAuth model authorization is unavailable. Sign in again or retry shortly.',
  )
}

function matchingGrant(
  readCredential: UsageCredentialReader,
  providerId: string,
  token: string,
): UnknownRecord {
  let grant: UnknownRecord | undefined
  try {
    grant = asObject(readCredential(providerId))
  } catch {
    // Never forward storage or credential-source error details.
  }
  if (
    grant?.type !== 'oauth' ||
    grant.access !== token ||
    typeof grant.refresh !== 'string' ||
    !grant.refresh ||
    typeof grant.expires !== 'number' ||
    !Number.isFinite(grant.expires) ||
    grant.expires <= Date.now()
  ) {
    throw new Error(
      'OpenAI OAuth metadata does not match the current runtime credential. Reconnect the requested OpenAI provider.',
    )
  }
  return grant
}

function bearerToken(auth: RequestAuth): string | undefined {
  const header = singleHeader(auth, 'authorization')
  // Explicit removals/replacements must not inherit the underlying apiKey.
  const value = header.present
    ? typeof header.value === 'string'
      ? /^Bearer\s+(\S+)$/iu.exec(header.value)?.[1]
      : undefined
    : auth.apiKey
  return typeof value === 'string' &&
    value.length <= 64 * 1024 &&
    /^[\x21-\x7e]+$/u.test(value)
    ? value
    : undefined
}

function singleHeader(auth: RequestAuth, name: string) {
  const entries = Object.entries(auth.headers ?? {}).filter(
    ([key]) => key.toLowerCase() === name,
  )
  if (entries.length > 1) {
    throw new Error('OpenAI OAuth authorization headers are ambiguous.')
  }
  return { present: entries.length === 1, value: entries[0]?.[1] }
}

function codexAccountId(token: string): string | undefined {
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || !parts[1]) {
      return undefined
    }
    const claims = asObject(
      JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
    )
    const accountId = asObject(
      claims?.['https://api.openai.com/auth'],
    )?.chatgpt_account_id
    return validIdentifier(accountId) ? accountId : undefined
  } catch {
    return undefined
  }
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    /^[\x21-\x7e]+$/u.test(value)
  )
}
