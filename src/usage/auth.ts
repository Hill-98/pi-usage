import type { ResolvedUsageAuth } from './types.ts'

export function getCredential(auth: ResolvedUsageAuth): string | undefined {
  if (typeof auth.apiKey === 'string' && auth.apiKey.trim()) {
    return stripBearer(auth.apiKey.trim())
  }
  const authorization = readHeader(auth.headers, 'authorization')
  return authorization ? stripBearer(authorization) : undefined
}

export function readHeader(
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

export function createBearerHeaders(
  auth: ResolvedUsageAuth,
  providerName: string,
): Record<string, string> {
  const authorization = readHeader(auth.headers, 'authorization')
  const credential = getCredential(auth)
  if (!authorization && !credential) {
    throw new Error(`No valid ${providerName} credentials were found.`)
  }
  return {
    Accept: 'application/json',
    Authorization: authorization || `Bearer ${credential}`,
  }
}

function stripBearer(value: string): string {
  return value.replace(/^Bearer\s+/i, '')
}
