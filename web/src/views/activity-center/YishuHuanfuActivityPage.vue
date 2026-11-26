<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import ActivityHeader from '@/components/activity/ActivityHeader.vue'
import ActivityShell from '@/components/activity/ActivityShell.vue'
import YishuHuanfuView from '@/components/activity/gameplays/yishuhuanfu/YishuHuanfuActivityPanel.vue'
import { useAccountStore } from '@/stores/account'
import { useYishuHuanfuStore } from '@/stores/yishuhuanfu'
import { useActivityClock } from './useActivityClock'

const emit = defineEmits<{ back: [] }>()
const accountStore = useAccountStore()
const yshfStore = useYishuHuanfuStore()
const { currentAccountId } = storeToRefs(accountStore)
const { state, loading, error } = storeToRefs(yshfStore)
const { remaining } = useActivityClock()
const remainingText = remaining(computed(() => state.value?.endTime ?? null))

function accountId() {
  return String(currentAccountId.value || '')
}
function refreshActivity() {
  return yshfStore.load(accountId(), true)
}
</script>

<template>
  <ActivityShell theme="day">
    <div class="activity-center">
      <ActivityHeader
        :title="state?.name || '以薯换福'"
        :remaining="remainingText"
        :balance="state?.luckCoin?.balance || '0'"
        currency-name="福气币"
        :loading="loading"
        show-refresh
        @back="emit('back')"
        @refresh="refreshActivity"
      />
      <div v-if="!currentAccountId" class="activity-state detail-state">
        <strong>请先选择账号</strong><span>活动数据按当前账号加载</span>
      </div>
      <div v-else-if="error" class="activity-message" role="status">
        <span>{{ error }}</span>
      </div>
      <main class="activity-content gameplay-content">
        <YishuHuanfuView />
      </main>
    </div>
  </ActivityShell>
</template>
