import { createHash } from 'node:crypto'
import { withUsageCache } from '../cache.ts'
import { fetchJson } from '../http.ts'
import type { CustomUsageProvider, UsageReport } from '../types.ts'
import {
  CHATGPT_USAGE_SETTINGS_URL,
  normalizeOpenAICompanion,
  OPENAI_CHATGPT_NAME,
  parseOpenAIAppUsage,
} from './openai-companion.ts'
import {
  resolveOpenAIUsageAuth,
  sameOpenAIUsageAuth,
} from './openai-companion-auth.ts'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const QUERY_TIMEOUT_MS = 15_000

export const openAIProvider: CustomUsageProvider = {
  id: 'openai',
  name: OPENAI_CHATGPT_NAME,
  origins: ['https://api.openai.com'],
  validateAuth: (ctx, model) => {
    if (!ctx.modelRegistry.isUsingOAuth(model)) {
      throw new Error(
        'OpenAI API-key usage is not available here. Sign in with ChatGPT through /login openai to use this adapter.',
      )
    }
  },
  query: async ({ ctx, model, auth, fetchImpl, options }) => {
    const resolved = await resolveOpenAIUsageAuth(
      ctx,
      model,
      auth,
      options.readCredential,
    )
    if (!resolved.companion) {
      return webOnlyReport()
    }
    const companion = resolved.companion
    const guard = async () => {
      const current = await resolveOpenAIUsageAuth(
        ctx,
        model,
        undefined,
        options.readCredential,
      )
      if (!sameOpenAIUsageAuth(resolved, current)) {
        throw new Error(
          'OpenAI authorization changed during the usage query. Run /usage again.',
        )
      }
    }
    // Stable across token refreshes, but isolated from legacy Codex and other
    // native registrations/accounts. No raw identifiers or tokens are saved.
    const identity = createHash('sha256')
      .update(JSON.stringify([resolved.clientId, companion.accountId]))
      .digest('hex')
    const report = await withUsageCache(
      { id: `openai-${identity}`, name: OPENAI_CHATGPT_NAME },
      async () => {
        const deadline = Date.now() + QUERY_TIMEOUT_MS
        const read = async (url: string) => {
          await guard()
          const payload = await fetchJson(
            url,
            companion.headers,
            fetchImpl,
            deadline - Date.now(),
          )
          await guard()
          return payload
        }
        const apps = await read(`${USAGE_URL}/chatpass/apps`)
        // Validate a unique app match before querying shared plan limits.
        const app = parseOpenAIAppUsage(apps, resolved.clientId)
        return normalizeOpenAICompanion(await read(USAGE_URL), app)
      },
      options,
    )
    // Cache hits must also validate fresh auth; removing a companion login
    // or changing accounts can never resurrect a previous numerical report.
    await guard()
    return report
  },
}

function webOnlyReport(): UsageReport {
  return {
    provider: OPENAI_CHATGPT_NAME,
    lines: [
      'ChatGPT subscription connected (native OAuth).',
      'For numerical quota, run /login openai-codex with the same ChatGPT account and workspace. Native inference stays on openai.',
      `Manage usage: ${CHATGPT_USAGE_SETTINGS_URL}`,
      'Companion queries use experimental, undocumented ChatGPT endpoints.',
    ],
    status: 'quota unavailable · /usage',
  }
}
