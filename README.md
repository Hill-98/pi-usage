# Pi Usage

A Pi extension that shows provider-specific subscription quotas and API balances. It keeps unlike metrics separate: a plan window, an API balance, and API spend are not treated as interchangeable.

Inspired by [`@narumitw/pi-usage`](https://www.npmjs.com/package/@narumitw/pi-usage).

## Install and use

Install the published package with Pi:

```sh
pi install npm:@hill-98/pi-usage
```

Run `/usage` to query the active provider. If the active model is not supported, `/usage` offers configured providers; you can also request one explicitly, for example `/usage kimi-coding`.

For local development, build with TypeScript 7 and tsdown, then load the generated extension:

```sh
pnpm install
pnpm build
pi --extension ./dist/index.js
```

After granting project trust, the project's `.pi/settings.json` loads the TypeScript source directly for local development. The published package uses the tsdown build in `dist/index.js`.

The status bar refreshes on session start, model changes, and every five minutes while a supported provider is active.

## Supported providers

| Provider ID | Data shown |
| --- | --- |
| `openai` | Shared ChatGPT plan quotas via Codex companion OAuth; separate app resets and allowance cap |
| `openai-codex` | ChatGPT subscription 5-hour and weekly windows |
| `kimi-coding` | Kimi Coding Plan windows and, when present, booster-wallet balance |
| `deepseek` | Current API balance by currency |
| `moonshotai`, `moonshotai-cn` | Current Global USD / China CNY API balance |
| `minimax`, `minimax-cn` | Token Plan quota or pay-as-you-go balance |
| `openrouter` | Per-key limit, remaining credits, and spend |
| `vercel-ai-gateway` | Gateway credits and spend |
| `opencode-go` | Rolling, weekly, and monthly plan windows |

OpenAI Pro is treated specially by both OpenAI adapters: **only weekly windows are displayed**, even if an endpoint response contains a 5-hour window. Window labels come from the returned duration, so a weekly limit in the primary slot is still recognized. Other plans display both available 5-hour and weekly windows. OpenAI API-key usage is not reported because these adapters require subscription OAuth.

### OpenAI in Pi 1.1 and newer

Pi's `openai` provider supports **Sign in with ChatGPT**, using a different authorization flow from the legacy `openai-codex` provider. Native inference stays on `openai`; a companion Codex login supplies read-only access to ChatGPT's shared plan and app usage.

Sign in to **the same ChatGPT account and workspace** for both providers:

```text
/login openai
/login openai-codex
/usage openai
```

After validating native OAuth, `/usage` and scheduled refreshes automatically query these fixed endpoints using **only the independently validated Codex companion bearer and account header**, never the native OpenAI token:

```text
GET https://chatgpt.com/backend-api/wham/usage/chatpass/apps
GET https://chatgpt.com/backend-api/wham/usage
```

The app list must contain exactly one registration matching the native OAuth `clientId` before the plan endpoint is queried. Incomplete/paginated lists, missing or duplicate matches, malformed windows, auth overrides, and endpoint failures are rejected rather than replaced with unrelated Codex quotas. Registration matching is not independent proof that the two logins belong to the same user/workspace; choosing the same account remains your responsibility.

The status bar displays **plan** remaining percentages, for example `OpenAI (ChatGPT subscription): plan 5h 75% · week 90%`. Detailed reports additionally display **app** window/reset information and an optional **App allowance** cap on shared plan usage. The cap is not remaining quota or a reserved pool. App used/remaining percentages are validated but hidden because agreement with the web UI is not independently verified.

Without a companion login, the adapter makes no quota request and shows setup guidance plus [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage); the status remains `quota unavailable · /usage`. Removing the companion login restores this fallback even if a numerical report was previously cached.

**Experimental:** these ChatGPT backend endpoints are undocumented and may change without notice. This implementation follows the [companion approach in `@narumitw/pi-usage@0.65.0`](https://cdn.jsdelivr.net/npm/@narumitw/pi-usage@0.65.0/src/providers/openai-companion-usage.ts), not a public native-token quota API. See OpenAI's [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) and [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) documentation for the native auth boundary.

The `openai-codex` adapter continues to retrieve its own numerical windows. Use `/usage codex` or `/usage openai-codex` to request that provider explicitly; `openai` is no longer a Codex alias.

## Security and limitations

- Request credentials come from Pi's freshly resolved runtime auth. For native OpenAI companion matching, Pi's public `readStoredCredential` helper supplies OAuth registration/account metadata that must match the resolved tokens; the plugin does not parse `auth.json` itself, select an account from stored tokens, or save credentials.
- Credentials are sent only to fixed provider endpoints after the active model and any resolved auth origin are checked against that provider's official origin.
- Redirects are rejected, response bodies are bounded, and provider response bodies are not included in errors.
- Normalized usage reports and refresh timestamps are cached per provider for five minutes in the system temporary directory; concurrent refreshes for the same provider are coalesced. Native OpenAI additionally isolates its cache by a hash of the native registration and companion account, separately from Codex. Auth is revalidated at each request boundary and before returning a cached native OpenAI report. Cache files use user-only permissions on POSIX; tokens and raw registration/account IDs are never cached.
- Provider usage endpoints and response formats can change. A provider without a supported numerical endpoint is reported as unsupported rather than having usage guessed.
- Anthropic, Google, GitHub Copilot, and native OpenAI API-key usage are not currently included; they do not expose a compatible usage endpoint through the provider's ordinary Pi credential.

## Development

```sh
pnpm build
pnpm test
pnpm lint
```

Use `pnpm smoke:local -- openai`, `pnpm smoke:local -- openai-codex`, or
`pnpm smoke:local -- kimi-coding` to run `/usage` through the local Pi RPC
client. The OpenAI smoke check requires a numerical companion report; missing
companion setup is a failure, not a successful quota check. Smoke tests print
window labels only, never credential values or quota percentages.
