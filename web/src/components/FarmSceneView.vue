<script setup lang="ts">
import { computed } from 'vue'

/**
 * 农场实景视图：按游戏截图的 1:1 布局，用账号真实土地数据动态渲染。
 * - 地块用项目自带的等距贴图 /land-assets/{level}.png（53:29 菱形）
 * - 作物用每块地的 seedImage，按等级/状态还原金色、紫色土地
 * - 草地背景 + 泥土基座 + 白色小花 + 中间的小机器人装饰
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

// 单块菱形贴图显示尺寸（保持原始 53:29 ≈ 1.83 的比例）
const TILE_W = 106
const TILE_H = 58
// 等距排布步长：约半个菱形 + 一点间隙
const STEP_X = 56
const STEP_Y = 31

// 列数：取平方根让网格接近正方形菱形（24 块 → 5×5），贴合截图
const columns = computed(() => {
  const n = props.lands?.length || 0
  if (n <= 0) return 1
  return Math.max(1, Math.round(Math.sqrt(n)))
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
  const w = Math.max(...xs) - Math.min(...xs) + TILE_W
  const h = Math.max(...ys) - Math.min(...ys) + TILE_H
  return { width: `${w}px`, height: `${h}px` }
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
    height: `${TILE_H}px`,
    // 靠下的地块压住靠上的地块，形成前后遮挡
    zIndex: String(10 + Math.round(tile.top)),
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
        <!-- 泥土基座：贴合菱形网格外轮廓 -->
        <div class="farm-scene__base" aria-hidden="true" />
        <!-- 小机器人装饰（截图中间偏左的白色小人） -->
        <div class="farm-scene__buddy" aria-hidden="true">
          <span class="farm-scene__buddy-antenna" />
          <span class="farm-scene__buddy-face">
            <span class="farm-scene__buddy-eye" />
            <span class="farm-scene__buddy-eye" />
          </span>
          <span class="farm-scene__buddy-body" />
        </div>
        <!-- 地块 -->
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
        </component>
        <!-- 草地上的白色小花 -->
        <span class="farm-scene__flower farm-scene__flower--1" aria-hidden="true" />
        <span class="farm-scene__flower farm-scene__flower--2" aria-hidden="true" />
        <span class="farm-scene__flower farm-scene__flower--3" aria-hidden="true" />
        <span class="farm-scene__flower farm-scene__flower--4" aria-hidden="true" />
      </div>
    </div>
    <p class="farm-scene__hint">点击地块查看土地详情 · 实景按账号真实土地与作物渲染，批量操作请切换到卡片视图</p>
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
  padding: 24px 14px;
  overflow: auto;
  border-radius: 16px;
  background:
    radial-gradient(circle at 18% 20%, rgba(255, 255, 255, 0.5) 0 4px, transparent 5px),
    radial-gradient(circle at 78% 72%, rgba(255, 255, 255, 0.4) 0 3px, transparent 4px),
    radial-gradient(ellipse at 30% 10%, #cdea9e 0%, #b4dd85 45%, #9ccc6c 100%);
  box-shadow: inset 0 2px 14px rgba(60, 110, 40, 0.2);
}

.farm-scene__field {
  position: relative;
  flex: none;
  margin: 0 auto;
}

/* 泥土基座：扁菱形，略大于地块网格外轮廓 */
.farm-scene__base {
  position: absolute;
  inset: -14px -18px;
  z-index: 0;
  background: linear-gradient(160deg, #f0e2b8 0%, #e6d29a 55%, #dcc188 100%);
  clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  filter: drop-shadow(0 4px 0 rgba(150, 120, 60, 0.35));
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
  transform: translateY(-5px);
  filter: drop-shadow(0 7px 6px rgba(0, 0, 0, 0.3));
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
  filter: drop-shadow(0 0 6px rgba(255, 236, 120, 0.95));
}

.farm-scene__soil {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
  pointer-events: none;
  user-select: none;
  filter: drop-shadow(0 3px 2px rgba(40, 70, 30, 0.28));
}

.farm-scene__crop {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 66px;
  height: 66px;
  transform: translate(-50%, -62%);
  object-fit: contain;
  pointer-events: none;
  user-select: none;
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.3));
}

.farm-scene__sprout {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  color: rgba(60, 110, 40, 0.55);
  font-size: 30px;
}

/* 中间偏左的白色小机器人 */
.farm-scene__buddy {
  position: absolute;
  left: 34%;
  top: 52%;
  z-index: 8;
  width: 34px;
  height: 40px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  filter: drop-shadow(0 3px 3px rgba(0, 0, 0, 0.28));
}

.farm-scene__buddy-antenna {
  position: absolute;
  left: 50%;
  top: 0;
  width: 3px;
  height: 7px;
  transform: translateX(-50%);
  background: #9aa7b4;
  border-radius: 2px;
}

.farm-scene__buddy-face {
  position: absolute;
  left: 50%;
  top: 5px;
  width: 30px;
  height: 25px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: linear-gradient(180deg, #fff 0%, #eef3f7 100%);
  border: 1px solid #d7e0e8;
  border-radius: 50% 50% 42% 42%;
}

.farm-scene__buddy-eye {
  width: 5px;
  height: 6px;
  background: #4aa3d8;
  border-radius: 50%;
}

.farm-scene__buddy-body {
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 26px;
  height: 15px;
  transform: translateX(-50%);
  background: linear-gradient(180deg, #f7fafc 0%, #d9e3ec 100%);
  border: 1px solid #cfd9e2;
  border-radius: 45% 45% 40% 40%;
}

/* 草地上的白色小花 */
.farm-scene__flower {
  position: absolute;
  z-index: 1;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 0 2px #fff, 4px -4px 0 -1px #fff, -4px -4px 0 -1px #fff, 4px 4px 0 -1px #fff, -4px 4px 0 -1px #fff;
  pointer-events: none;
}

.farm-scene__flower::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 4px;
  transform: translate(-50%, -50%);
  background: #ffd34d;
  border-radius: 50%;
}

.farm-scene__flower--1 { left: 6%; top: 10%; }
.farm-scene__flower--2 { left: 13%; top: 6%; transform: scale(0.8); }
.farm-scene__flower--3 { left: 3%; top: 22%; transform: scale(0.7); }
.farm-scene__flower--4 { left: 20%; top: 12%; transform: scale(0.65); }

.farm-scene__hint {
  margin: 0;
  color: var(--ui-subtle);
  font-size: 12px;
  text-align: center;
}

@media (prefers-color-scheme: dark) {
  .farm-scene__scroll {
    background:
      radial-gradient(ellipse at 30% 10%, #4e7a3c 0%, #3f6a32 45%, #33592a 100%);
  }
}
</style>
