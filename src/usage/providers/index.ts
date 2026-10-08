import { deepSeekProvider } from './deepseek.ts'
import { kimiCodingProvider } from './kimi-coding.ts'
import { miniMaxGlobalProvider } from './minimax.ts'
import { miniMaxChinaProvider } from './minimax-cn.ts'
import { moonshotGlobalProvider } from './moonshotai.ts'
import { moonshotChinaProvider } from './moonshotai-cn.ts'
import { openAICodexProvider } from './openai-codex.ts'
import { openCodeGoProvider } from './opencode-go.ts'
import { openRouterProvider } from './openrouter.ts'
import { vercelAIGatewayProvider } from './vercel-ai-gateway.ts'

export const USAGE_PROVIDERS = [
  openAICodexProvider,
  kimiCodingProvider,
  deepSeekProvider,
  moonshotGlobalProvider,
  moonshotChinaProvider,
  miniMaxGlobalProvider,
  miniMaxChinaProvider,
  openRouterProvider,
  vercelAIGatewayProvider,
  openCodeGoProvider,
]
