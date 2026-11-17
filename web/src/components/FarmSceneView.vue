<script setup lang="ts">
import { computed } from 'vue'

/**
 * 农场实景视图：用游戏等距贴图（/land-assets/{level}.png）和作物图还原游戏里的
 * 俯视农场效果。每块地按其等级选贴图，作物叠在菱形中央，点击可打开土地详情。
 * 与 FarmLandCard 的卡片列表是同一份 lands 数据的两种呈现。
 */
const props = withDefaults(defineProps<{
  lands: any[]
  interactive?: boolean
}>(), {
  interactive: false,
})

const emit = defineEmits<{
  open: [land: any]
}>()

// 单块贴图显示尺寸与等距排布步长（菱形宽高比约 2:1）
const TILE_W = 92
const TILE_H = 46
const STEP_X = 44
const STEP_Y = 24

// 列数：尽量拼成宽菱形（接近游戏里 6 列 × 4 行的样子）
const columns = computed(() => {
  const n = props.lands?.length || 0
  if (n <= 0) return 1
  if (n <= 6) return Math.max(1, n)
  return Math.min(8, Math.max(4, Math.round(n / 4)))
})

interface SceneTile {
  land: any
  key: string
  left: number
  top: number
}

const tiles = computed<SceneTile[]>(() => (props.lands || []).map((land, index) => {
  const row = Math.floor(index / columns.value)
  const col = index % columns.value
  return {
    land,
    key: String(land?.id ?? index),
    left: (col - row) * STEP_X,
    top: (col + row) * STEP_Y,
  }
}))

const offsets = computed(() => {
  if (!tiles.value.length) return { x: 0, y: 0 }
  return {
    x: -Math.min(...tiles.value.map(t => t.left)),
    y: -Math.min(...tiles.value.map(t => t.top)),
  }
})

const boardStyle = computed(() => {
  if (!tiles.value.length) return {}
  const xs = tiles.value.map(t => t.left)
  const ys = tiles.value.map(t => t.top)
  return {
    width: `${Math.max(...xs) - Math.min(...xs) + TILE_W}px`,
    height: `${Math.max(...ys) - Math.min(...ys) + TILE_H + 26}px`,
  }
})

function soilImage(land: any) {
  const lv = Number(land?.level) || 1
  return `/land-assets/${lv >= 1 && lv <= 6 ? lv : 1}.png`
}

function safeImage(url: string) {
  return url && url.startsWith('http://') ? url.replace('http://', 'https://') : url
}

function isLocked(land: any) {
  return land?.status === 'locked' || land?.unlocked === false
}

function isEmpty(land: any) {
  return !isLocked(land) && (land?.status === 'empty' || !String(land?.plantName || '').trim())
}

function isRipe(land: any) {
  return land?.status === 'harvestable' || land?.status === 'stealable'
}

function tileStyle(tile: SceneTile) {
  return {
    left: `${offsets.value.x + tile.left}px`,
    top: `${offsets.value.y + tile.top}px`,
    width: `${TILE_W}px`,
    height: `${TILE_H + 26}px`,
    // 靠下的地块压住靠上的地块，形成前后遮挡
    zIndex: String(10 + tile.top),
  }
}

function activate(land: any) {
  if (props.interactive) emit('open', land)
}
</script>

<template>
  <div class="farm-scene" role="region" aria-label="农场实景视图">
    <div class="farm-scene__scroll custom-scrollbar">
      <div class="farm-scene__field" :style="boardStyle">
        <component
          :is="interactive ? 'button' : 'div'"
          v-for="tile in tiles"
          :key="tile.key"
          class="farm-scene__tile"
          :class="{
            'is-interactive': interactive,
            'is-locked': isLocked(tile.land),
            'is-empty': isEmpty(tile.land),
            'is-ripe': isRipe(tile.land),
          }"
          :style="tileStyle(tile)"
          :type="interactive ? 'button' : undefined"
          :aria-label="`第 ${tile.land?.id} 块地${tile.land?.plantName ? ` ${tile.land.plantName}` : ''}`"
          @click="activate(tile.land)"
        >
          <img class="farm-scene__soil" :src="soilImage(tile.land)" alt="" draggable="false">
          <img
            v-if="!isLocked(tile.land) && !isEmpty(tile.land) && tile.land?.seedImage"
            class="farm-scene__crop"
            :src="safeImage(tile.land.seedImage)"
            alt=""
            draggable="false"
            loading="lazy"
            referrerpolicy="no-referrer"
          >
          <span v-else-if="!isLocked(tile.land) && !isEmpty(tile.land)" class="farm-scene__sprout i-carbon-sprout" />
          <span class="farm-scene__no">#{{ tile.land?.id }}</span>
        </component>
      </div>
    </div>
    <p class="farm-scene__hint">点击地块查看土地详情 · 实景视图仅作展示，批量操作请切换到卡片视图</p>
  </div>
</template>

<style scoped>
.farm-scene {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.farm-scene__scroll {
  display: flex;
  justify-content: center;
  width: 100%;
  padding: 18px 10px;
  overflow: auto;
  border-radius: 16px;
  background:
    radial-gradient(circle at 25% 15%, rgba(255, 255, 255, 0.55) 0 6px, transparent 7px),
    radial-gradient(circle at 70% 80%, rgba(255, 255, 255, 0.4) 0 5px, transparent 6px),
    linear-gradient(160deg, #bfe8a2 0%, #a7dd8b 40%, #94d179 100%);
  box-shadow: inset 0 2px 12px rgba(60, 110, 40, 0.18);
}

.farm-scene__field {
  position: relative;
  flex: none;
  margin: 0 auto;
}

.farm-scene__tile {
  position: absolute;
  display: block;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: default;
  transition: transform 0.15s ease, filter 0.15s ease;
}

.farm-scene__tile.is-interactive {
  cursor: pointer;
}

.farm-scene__tile.is-interactive:hover {
  transform: translateY(-4px);
  filter: drop-shadow(0 6px 6px rgba(0, 0, 0, 0.28));
}

.farm-scene__tile.is-interactive:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
  border-radius: 8px;
}

.farm-scene__tile.is-locked {
  filter: grayscale(0.75) opacity(0.65);
}

.farm-scene__tile.is-ripe .farm-scene__soil {
  filter: drop-shadow(0 0 5px rgba(255, 236, 120, 0.95));
}

.farm-scene__soil {
  position: absolute;
  inset: 0;
  width: 92px;
  height: 92px;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
  filter: drop-shadow(0 3px 2px rgba(40, 70, 30, 0.28));
}

.farm-scene__crop {
  position: absolute;
  left: 50%;
  top: 14px;
  width: 62px;
  height: 62px;
  transform: translateX(-50%);
  object-fit: contain;
  pointer-events: none;
  user-select: none;
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.3));
}

.farm-scene__sprout {
  position: absolute;
  left: 50%;
  top: 26px;
  transform: translateX(-50%);
  color: rgba(60, 110, 40, 0.5);
  font-size: 28px;
}

.farm-scene__no {
  position: absolute;
  left: 50%;
  bottom: 2px;
  transform: translateX(-50%);
  color: rgba(30, 60, 20, 0.72);
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 1px rgba(255, 255, 255, 0.7);
  white-space: nowrap;
}

.farm-scene__hint {
  margin: 0;
  color: var(--ui-subtle);
  font-size: 12px;
  text-align: center;
}

.dark .farm-scene__scroll {
  background:
    radial-gradient(circle at 25% 15%, rgba(255, 255, 255, 0.12) 0 6px, transparent 7px),
    linear-gradient(160deg, #3f6b3a 0%, #335a30 100%);
}

.dark .farm-scene__no {
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
</style>
