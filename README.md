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
| `openai-codex` | ChatGPT subscription 5-hour and weekly windows |
| `kimi-coding` | Kimi Coding Plan windows and, when present, booster-wallet balance |
| `deepseek` | Current API balance by currency |
| `moonshotai`, `moonshotai-cn` | Current Global USD / China CNY API balance |
| `minimax`, `minimax-cn` | Token Plan quota or pay-as-you-go balance |
| `openrouter` | Per-key limit, remaining credits, and spend |
| `vercel-ai-gateway` | Gateway credits and spend |
| `opencode-go` | Rolling, weekly, and monthly plan windows |

OpenAI Codex Pro is treated specially: **only its weekly window is displayed**, even if an endpoint response contains a primary window. Other plans display both available 5-hour and weekly windows. OpenAI API-key usage is not reported because these subscription endpoints require Codex OAuth.

## Security and limitations

- The extension uses Pi's runtime-resolved credentials; it does not read `auth.json` directly or save credentials.
- Credentials are sent only to fixed provider endpoints after the active model and any resolved auth origin are checked against that provider's official origin.
- Redirects are rejected, response bodies are bounded, and provider response bodies are not included in errors.
- Provider usage endpoints and response formats can change. A provider without a supported numerical endpoint is reported as unsupported rather than having usage guessed.
- Anthropic, Google, GitHub Copilot, and native OpenAI API-key usage are not currently included; they do not expose a compatible usage endpoint through the provider's ordinary Pi credential.

## Development

```sh
pnpm build
pnpm test
pnpm lint
```

Use `pnpm smoke:local -- openai-codex` or `pnpm smoke:local -- kimi-coding`
to run `/usage` through the local Pi RPC client. The smoke test reports the
returned window labels only; it does not print credential values or quota
percentages.
