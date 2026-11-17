<script setup lang="ts">
import { ref } from 'vue'

/**
 * 农场实景视图：按提供的游戏截图 1:1 展示（原始比例 1084×590）。
 * 与 FarmLandCard 的卡片列表是同一位置的两种呈现，由外层切换。
 */
const props = withDefaults(defineProps<{
  lands?: any[]
  interactive?: boolean
}>(), {
  lands: () => [],
  interactive: false,
})

const emit = defineEmits<{
  open: [land: any]
}>()

const previewVisible = ref(false)
const sceneSrc = '/scene/farm-scene.jpg'

function openPreview() {
  previewVisible.value = true
}
</script>

<template>
  <div class="farm-scene" role="region" aria-label="农场实景视图">
    <div class="farm-scene__scroll custom-scrollbar">
      <img
        class="farm-scene__image"
        :src="sceneSrc"
        alt="农场实景"
        draggable="false"
        @click="openPreview"
      >
    </div>
    <p class="farm-scene__hint">实景视图按游戏截图 1:1 展示 · 点击查看大图</p>

    <Teleport to="body">
      <Transition name="farm-scene-fade">
        <div v-if="previewVisible" class="farm-scene__overlay" role="dialog" aria-modal="true" aria-label="农场实景大图" @click="previewVisible = false">
          <img class="farm-scene__preview" :src="sceneSrc" alt="农场实景大图" @click.stop>
          <button type="button" class="farm-scene__close" aria-label="关闭大图" @click="previewVisible = false">
            <span class="i-carbon-close" aria-hidden="true" />
          </button>
        </div>
      </Transition>
    </Teleport>
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
  padding: 8px;
  overflow: auto;
  border-radius: 16px;
  background: color-mix(in srgb, var(--ui-surface-strong) 40%, transparent);
}

.farm-scene__image {
  display: block;
  width: 100%;
  max-width: 1084px;
  height: auto;
  border-radius: 10px;
  cursor: zoom-in;
}

.farm-scene__hint {
  margin: 0;
  color: var(--ui-subtle);
  font-size: 12px;
  text-align: center;
}

.farm-scene__overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.82);
  cursor: zoom-out;
}

.farm-scene__preview {
  display: block;
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  border-radius: 8px;
  cursor: default;
}

.farm-scene__close {
  position: fixed;
  top: 20px;
  right: 20px;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  color: #fff;
  background: rgba(255, 255, 255, 0.16);
  font-size: 22px;
  cursor: pointer;
}

.farm-scene__close:hover {
  background: rgba(255, 255, 255, 0.28);
}

.farm-scene-fade-enter-active,
.farm-scene-fade-leave-active {
  transition: opacity 0.18s ease;
}

.farm-scene-fade-enter-from,
.farm-scene-fade-leave-to {
  opacity: 0;
}
</style>
