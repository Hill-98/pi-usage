import { createMiniMaxProvider } from './minimax-shared.ts'

export const miniMaxChinaProvider = createMiniMaxProvider({
  id: 'minimax-cn',
  name: 'MiniMax China',
  aliases: ['minimax-china'],
  origin: 'https://api.minimaxi.com',
  region: 'china',
})
