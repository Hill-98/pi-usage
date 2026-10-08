import type { Api, Model } from '@earendil-works/pi-ai'
import { createBearerHeaders } from './auth.ts'
import type {
  ResolvedUsageAuth,
  UnknownRecord,
  UsageProvider,
} from './types.ts'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 1024 * 1024

export function assertOfficialOrigin(
  provider: UsageProvider,
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

export function createRequestHeaders(
  provider: UsageProvider,
  auth: ResolvedUsageAuth,
): Record<string, string> {
  return (
    provider.createHeaders?.(auth) ?? createBearerHeaders(auth, provider.name)
  )
}

export async function fetchJson(
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

function parseOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}
