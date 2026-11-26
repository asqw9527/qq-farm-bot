import type { ActivityGameplayModule } from '../types'

// 以薯换福：单一详情页，由 ActivityCenter 直接挂载 YishuHuanfuActivityPage。
export const yishuHuanfuGameplay: ActivityGameplayModule = {
  key: 'yishuhuanfu',
  defaultTab: 'yishuhuanfu',
  tabs: ['yishuhuanfu'],
}
