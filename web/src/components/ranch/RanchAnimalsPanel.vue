<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { BUCKETS, formatCount, formatDuration, formatHours, RANCH_IMAGE, useRanchActions, useRanchClock, useRanchLoader } from '@/components/ranch/ranch-shared'
import RanchAnimalCard from '@/components/ranch/RanchAnimalCard.vue'
import RanchGate from '@/components/ranch/RanchGate.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useRanchStore } from '@/stores/ranch'

const { state, loading } = storeToRefs(useRanchStore())
const { refresh } = useRanchLoader('animals')
const { disabled, request } = useRanchActions()
const { remainingSeconds } = useRanchClock()

const pens = computed<any[]>(() => (state.value?.facilities || []).filter((f: any) => f.ranch))
const animals = computed(() => pens.value.flatMap(f => (f.ranch.animals || []).map((animal: any) => ({ animal, pen: f.name }))))
const capacity = computed(() => pens.value.reduce((sum, f) => sum + (Number(f.ranch.capacity) || 0), 0))
const shelves = computed(() => pens.value.flatMap(f => f.ranch.shelves.filter((s: any) => s.canCollect).map((s: any) => ({ ...s, pen: f.name, key: `${f.id}:${s.slot}` }))))
const hazards = computed(() => pens.value.reduce((sum, f) => sum + (f.ranch.hazards?.length || 0), 0))

const canProduce = computed(() => animals.value.some(({ animal }) => animal.canProduce))
const canHarvest = computed(() => animals.value.some(({ animal }) => animal.canHarvest) || shelves.value.length > 0)
const canFeed = computed(() => animals.value.some(({ animal }) => animal.canFeed))

const feedPickerVisible = ref(false)
/** 罐头存量按桶展示，选项顺序与单只动物的喂养菜单一致（普通 / 有机）。 */
interface FeedOption {
  id: number
  name: string
  image: string
  bucketType: 1 | 2
  seconds: number
}
const feedOptions = computed<FeedOption[]>(() => BUCKETS.map(bucket => ({
  ...bucket,
  bucketType: bucket.id === 7003 ? 2 : 1,
  seconds: Number(state.value?.buckets?.find((b: any) => Number(b.id) === bucket.id)?.seconds ?? 0),
})))

async function chooseFeed(bucketType: 1 | 2) {
  feedPickerVisible.value = false
  await request('feed', { all: true, bucketType })
}

const summary = computed(() => [
  { key: 'harvest', label: '可收获', icon: 'i-carbon-wheat text-amber-600 dark:text-amber-400', value: animals.value.filter(({ animal }) => animal.canHarvest).length },
  { key: 'produce', label: '可生产', icon: 'i-carbon-circle-dash text-green-600 dark:text-green-400', value: animals.value.filter(({ animal }) => animal.canProduce).length },
  { key: 'blocked', label: '缺草', icon: 'i-carbon-warning-alt text-amber-600 dark:text-amber-400', value: animals.value.filter(({ animal }) => animal.grassBlocked).length },
  { key: 'clean', label: '待清理', icon: 'i-carbon-clean text-violet-500 dark:text-violet-300', value: hazards.value },
])
const stock = computed(() => [
  { key: 'grass', label: '牧草', image: RANCH_IMAGE(7001), value: formatCount(state.value?.grass ?? 0) },
  ...BUCKETS.map(bucket => ({ key: bucket.id, label: bucket.name, image: bucket.image, value: formatHours(state.value?.buckets?.find((b: any) => Number(b.id) === bucket.id)?.seconds ?? 0) })),
])

/** 倒计时已到但服务器尚未推进阶段时，显示阶段名而不是“0秒”。 */
function animalRemaining(animal: any) {
  const seconds = animal.nextAtMs ? remainingSeconds(animal.nextAtMs) : 0
  return seconds > 0 ? formatDuration(seconds) : ''
}
function target(animal: any) {
  return { ranchId: animal.ranchId, animalId: animal.id }
}
</script>

<template>
  <div class="personal-panel">
    <RanchGate @retry="refresh">
      <div class="personal-panel__card farm-card rounded-2xl !p-0">
        <div class="ranch-head panel-sticky">
          <h3 class="flex items-center gap-2 text-lg font-bold">
            <span class="i-carbon-pet-image-o text-green-600" /> 动物详情
            <small class="ranch-head__count">{{ animals.length }} / {{ capacity }}</small>
          </h3>
          <div class="ranch-actions">
            <NButton :disabled="disabled || !canFeed" @click="feedPickerVisible = true">
              <span class="i-carbon-flash" />一键喂养
            </NButton>
            <NButton :disabled="disabled || !hazards" @click="request('clean')">
              <span class="i-carbon-clean" />一键清理
            </NButton>
            <NButton :disabled="disabled || !canProduce" @click="request('produce', { all: true })">
              <span class="i-carbon-circle-dash" />一键生产
            </NButton>
            <NButton type="primary" :disabled="disabled || !canHarvest" @click="request('harvest', { all: true })">
              <span class="i-carbon-flash" />一键收获
            </NButton>
            <NButton circle quaternary title="刷新牧场" aria-label="刷新牧场" :loading="loading" @click="refresh">
              <template #icon>
                <span class="i-carbon-renew" />
              </template>
            </NButton>
          </div>
        </div>

        <div class="ranch-summary">
          <div class="ranch-summary__states">
            <span v-for="item in summary" :key="item.key" class="ranch-state" :class="{ 'is-zero': !item.value }">
              <span :class="item.icon" aria-hidden="true" />{{ item.label }}<b>{{ item.value }}</b>
            </span>
          </div>
          <div class="ranch-summary__stock">
            <span v-for="item in stock" :key="item.key" :title="item.label">
              <img :src="item.image" alt="">{{ item.label }}<b>{{ item.value }}</b>
            </span>
          </div>
        </div>

        <div class="p-4 sm:p-5">
          <div v-if="!animals.length" class="ranch-empty">
            <span class="i-carbon-pet-image-o" aria-hidden="true" />
            <strong>还没有饲养动物</strong>
            <p>在牧场商店购买幼崽，到背包里放养到窝或棚。</p>
            <BaseButton variant="secondary" size="sm" to="/ranch/game-mall">
              去牧场商店
            </BaseButton>
          </div>
          <div v-else class="ranch-grid">
            <RanchAnimalCard
              v-for="{ animal, pen } in animals"
              :key="`${animal.ranchId}:${animal.id}`"
              :animal="animal"
              :pen="pen"
              :remaining="animalRemaining(animal)"
              actionable
              :disabled="disabled"
              @produce="request('produce', target(animal))"
              @harvest="request('harvest', target(animal))"
              @feed="type => request('feed', { ...target(animal), bucketType: type })"
              @release="request('release', target(animal))"
            />
          </div>

          <section v-if="shelves.length" class="ranch-shelves" aria-label="待收产物">
            <h4><span class="i-carbon-box" aria-hidden="true" />待收产物</h4>
            <div class="ranch-shelves__list">
              <template v-for="shelf in shelves" :key="shelf.key">
                <span v-for="product in shelf.products" :key="`${shelf.key}:${product.id}`" class="ranch-product" :title="`${shelf.pen} · 货架 ${shelf.slot}`">
                  <img :src="product.image" alt="">{{ product.name }}<b>×{{ formatCount(product.count) }}</b>
                </span>
              </template>
            </div>
          </section>
        </div>
      </div>
    </RanchGate>

    <NModal
      :show="feedPickerVisible"
      :auto-focus="false"
      @update:show="feedPickerVisible = $event"
    >
      <NCard class="feed-picker" role="dialog" aria-modal="true" title="一键喂养" :bordered="false" size="medium">
        <p class="feed-picker__tip">选择用于加速动物成长的罐头类型</p>
        <div class="feed-picker__options">
          <button
            v-for="option in feedOptions"
            :key="option.bucketType"
            type="button"
            class="feed-picker__option"
            :disabled="disabled || option.seconds <= 0"
            @click="chooseFeed(option.bucketType)"
          >
            <img :src="option.image" :alt="option.name">
            <span class="feed-picker__name">{{ option.name }}喂养</span>
            <span class="feed-picker__stock">{{ option.seconds > 0 ? `存量 ${formatHours(option.seconds)}` : '暂无存量' }}</span>
          </button>
        </div>
        <template #footer>
          <div class="flex justify-end">
            <BaseButton variant="secondary" @click="feedPickerVisible = false">取消</BaseButton>
          </div>
        </template>
      </NCard>
    </NModal>
  </div>
</template>

<style scoped>
.ranch-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card) var(--ui-radius-card) 0 0;
}

.ranch-head__count {
  color: var(--ui-subtle);
  font-size: 13px;
  font-weight: var(--fw-500);
  font-variant-numeric: tabular-nums;
}

.ranch-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.ranch-actions :deep(.n-button__content) {
  gap: 4px;
}

.ranch-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 13px;
}

.ranch-summary__states {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ranch-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px 3px 8px;
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-variant-numeric: tabular-nums;
}

.ranch-state b {
  margin-left: 2px;
  color: var(--ui-ink);
  font-weight: var(--fw-650);
}

.ranch-state.is-zero {
  opacity: 0.65;
}

.ranch-summary__stock {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  color: var(--ui-muted);
}

.ranch-summary__stock > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}

.ranch-summary__stock img {
  width: 16px;
  height: 16px;
  object-fit: contain;
}

.ranch-summary__stock b {
  margin-left: 2px;
  color: var(--ui-ink);
  font-weight: var(--fw-650);
}

.ranch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 12px;
}

.ranch-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 36px 16px;
  color: var(--ui-muted);
  text-align: center;
}

.ranch-empty > span {
  margin-bottom: 4px;
  color: var(--ui-subtle);
  font-size: 30px;
}

.ranch-empty strong {
  color: var(--ui-ink);
  font-size: 15px;
}

.ranch-empty p {
  margin: 0 0 8px;
  font-size: 13px;
}

.ranch-shelves {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px dashed var(--ui-border-strong);
}

.ranch-shelves h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 10px;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
}

.ranch-shelves__list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ranch-product {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 4px 4px;
  border-radius: 10px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 13px;
}

.ranch-product img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.ranch-product b {
  color: var(--ui-ink);
  font-variant-numeric: tabular-nums;
}

.feed-picker {
  width: min(420px, calc(100vw - 32px));
}

.feed-picker__tip {
  margin: 0 0 14px;
  color: var(--ui-muted);
  font-size: 13px;
}

.feed-picker__options {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.feed-picker__option {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  color: var(--ui-ink);
  background: var(--ui-surface-soft);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.feed-picker__option:hover:not(:disabled) {
  border-color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.feed-picker__option:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.feed-picker__option img {
  width: 36px;
  height: 36px;
  object-fit: contain;
}

.feed-picker__name {
  flex: 1;
  font-size: 14px;
  font-weight: var(--fw-600);
}

.feed-picker__stock {
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 639px) {
  .ranch-head,
  .ranch-summary {
    padding-inline: 16px;
  }

  .ranch-actions {
    display: grid;
    width: 100%;
    grid-template-columns: repeat(4, minmax(0, 1fr)) auto;
  }

  .ranch-actions :deep(.n-button:not(.n-button--circle)) {
    padding-inline: 8px;
  }

  .ranch-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
}

@media (max-width: 479px) {
  .ranch-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr)) auto;
  }
}

@media (max-width: 400px) {
  .ranch-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
