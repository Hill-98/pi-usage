import { createMoonshotProvider } from './moonshot-shared.ts'

export const moonshotChinaProvider = createMoonshotProvider({
  id: 'moonshotai-cn',
  name: 'Moonshot AI China',
  aliases: ['moonshot-cn'],
  origin: 'https://api.moonshot.cn',
  url: 'https://api.moonshot.cn/v1/users/me/balance',
  currency: 'CNY',
})
