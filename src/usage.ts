import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { UsageCacheOptions } from './usage/cache.ts'
import { withUsageCache } from './usage/cache.ts'
import {
  assertOfficialOrigin,
  createRequestHeaders,
  fetchJson,
} from './usage/http.ts'
import { USAGE_PROVIDERS } from './usage/providers/index.ts'
import type { ProviderChoice, ResolvedUsageAuth } from './usage/types.ts'

export type { UsageCacheOptions } from './usage/cache.ts'
export { USAGE_CACHE_TTL_MS } from './usage/cache.ts'
export { renderReport, renderStatus } from './usage/format.ts'
export type { UsageReport } from './usage/types.ts'

export function getSupportedProviders(): ProviderChoice[] {
  return USAGE_PROVIDERS.map(({ id, name, aliases }) => ({
    id,
    name,
    aliases,
  }))
}

export async function queryUsage(
  ctx: ExtensionContext,
  model: Model<Api>,
  fetchImpl: typeof fetch = globalThis.fetch,
  cacheOptions: UsageCacheOptions = {},
) {
  const provider = USAGE_PROVIDERS.find((item) => item.id === model?.provider)
  if (!provider) {
    throw new Error('This provider does not have a usage adapter.')
  }

  provider.validateAuth?.(ctx, model)
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
  if (!auth?.ok) {
    throw new Error(
      `No valid ${provider.name} credentials were found. Sign in again or check the provider setup.`,
    )
  }

  assertOfficialOrigin(provider, model, auth)
  const headers = createRequestHeaders(provider, auth)
  const url =
    typeof provider.url === 'function' ? provider.url(auth) : provider.url
  if (!url) {
    throw new Error(`${provider.name} usage endpoint is not configured.`)
  }

  return withUsageCache(
    provider,
    async () => {
      const payload = await fetchJson(url, headers, fetchImpl)
      return provider.normalize(payload, auth as ResolvedUsageAuth)
    },
    cacheOptions,
  )
}
