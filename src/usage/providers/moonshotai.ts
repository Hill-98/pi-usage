import { createMoonshotProvider } from './moonshot-shared.ts'

export const moonshotGlobalProvider = createMoonshotProvider({
  id: 'moonshotai',
  name: 'Moonshot AI Global',
  aliases: ['moonshot', 'moonshot-global'],
  origin: 'https://api.moonshot.ai',
  url: 'https://api.moonshot.ai/v1/users/me/balance',
  currency: 'USD',
})
