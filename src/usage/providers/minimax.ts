import { createMiniMaxProvider } from './minimax-shared.ts'

export const miniMaxGlobalProvider = createMiniMaxProvider({
  id: 'minimax',
  name: 'MiniMax Global',
  aliases: ['minimax-global'],
  origin: 'https://api.minimax.io',
  region: 'global',
})
