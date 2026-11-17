<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import AdminGlobalToggles from '@/components/admin/AdminGlobalToggles.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useToastStore } from '@/stores/toast'

const toast = useToastStore()

// —— 抓包登录设置（自 qq-farm-bot 移植）——
const captureConfigLoading = ref(false)
const captureConfigSaving = ref(false)
const captureTesting = ref(false)
const localCaptureConfig = ref({
  enabled: false,
  embedded: true,
  apiBase: 'http://127.0.0.1:8450',
  apiToken: '',
  tokenConfigured: false,
  autoImportQqGids: true,
  running: false,
})

function normalizeCaptureConfig(source: any) {
  return {
    enabled: source?.enabled === true,
    embedded: source?.embedded !== false,
    apiBase: typeof source?.apiBase === 'string' && source.apiBase.trim() ? source.apiBase.trim() : 'http://127.0.0.1:8450',
    apiToken: '',
    tokenConfigured: source?.tokenConfigured === true,
    autoImportQqGids: source?.autoImportQqGids !== false,
    running: source?.running === true,
  }
}

async function loadCaptureConfig() {
  captureConfigLoading.value = true
  try {
    const { data } = await api.get('/api/admin/capture-config', { skipErrorToast: true } as any)
    if (data?.ok)
      localCaptureConfig.value = normalizeCaptureConfig(data.data)
  }
  catch (e) {
    console.error('加载抓包登录配置失败:', e)
  }
  finally {
    captureConfigLoading.value = false
  }
}

async function handleSaveCaptureConfig() {
  if (localCaptureConfig.value.enabled
    && !localCaptureConfig.value.embedded
    && !localCaptureConfig.value.apiToken.trim()
    && !localCaptureConfig.value.tokenConfigured) {
    toast.error('独立模式下启用抓包登录前，请填写抓包服务 API Token')
    return
  }
  captureConfigSaving.value = true
  try {
    const { data } = await api.post('/api/admin/capture-config', {
      enabled: localCaptureConfig.value.enabled,
      embedded: localCaptureConfig.value.embedded,
      apiBase: localCaptureConfig.value.apiBase.trim(),
      autoImportQqGids: localCaptureConfig.value.autoImportQqGids,
      ...(localCaptureConfig.value.apiToken.trim() ? { apiToken: localCaptureConfig.value.apiToken.trim() } : {}),
    })
    if (data?.ok)
      localCaptureConfig.value = normalizeCaptureConfig(data.data)
    if (data?.ok)
      toast.success('抓包登录设置已保存')
    else
      toast.error(getApiErrorMessage(data, '保存失败'))
  }
  catch (e: any) {
    toast.error(`保存失败: ${getApiErrorMessage(e, '未知错误')}`)
  }
  finally {
    captureConfigSaving.value = false
  }
}

async function handleTestCapture() {
  captureTesting.value = true
  try {
    const { data } = await api.post('/api/admin/capture-config/test', {
      apiBase: localCaptureConfig.value.apiBase.trim(),
      ...(localCaptureConfig.value.apiToken.trim() ? { apiToken: localCaptureConfig.value.apiToken.trim() } : {}),
    })
    if (data?.ok)
      toast.success(`连接成功：当前 ${data.data.sessions} 个会话，端口池 ${data.data.portPoolSize} 个端口`)
    else
      toast.error(getApiErrorMessage(data, '连接失败'))
  }
  catch (e: any) {
    toast.error(`连接失败: ${getApiErrorMessage(e, '未知错误')}`)
  }
  finally {
    captureTesting.value = false
  }
}

// —— 运行环境（全局系统配置）——
const systemConfigSaving = ref(false)
const systemConfigLoading = ref(false)

const defaultDeviceInfo = {
  os: 'Windows',
  clientVersion: '',
  sysSoftware: 'Windows 10',
  network: 'wifi',
  memory: '16384',
  deviceId: 'DESKTOP-PC<WPC>',
  userAgent: '',
}

const localSystemConfig = ref({
  serverUrl: '',
  clientVersion: '',
  wxClientVersion: '',
  platform: 'qq',
  os: 'Windows',
  timeZone: 'Asia/Shanghai',
  deviceInfo: { ...defaultDeviceInfo },
})
const defaultSystemConfig = ref({
  serverUrl: '',
  clientVersion: '',
  wxClientVersion: '',
  platform: 'qq',
  os: 'Windows',
  timeZone: 'Asia/Shanghai',
  deviceInfo: { ...defaultDeviceInfo },
})

const localLoginSettings = ref({
  wechatQrLogin: true,
  qqQrLogin: false,
  napCatEndpoint: '',
  napCatSignature: '',
})
const loginSettingsSaving = ref(false)

const devicePresets = ref<any[]>([])
const selectedPresetId = ref('')
const timeZoneOptions = ref([
  { label: '北京时间 / 上海（UTC+8）', value: 'Asia/Shanghai' },
])
const platformOptions = [
  { label: 'QQ', value: 'qq' },
  { label: '微信', value: 'wx' },
]
const osOptions = [
  { label: 'Windows', value: 'Windows' },
  { label: 'iOS', value: 'iOS' },
  { label: 'Android', value: 'Android' },
]

function normalizeSystemConfig(source: any, fallback: any) {
  return {
    serverUrl: source?.serverUrl || '',
    clientVersion: source?.clientVersion || '',
    wxClientVersion: source?.wxClientVersion || fallback.wxClientVersion || '',
    platform: source?.platform || 'qq',
    os: source?.os || 'Windows',
    timeZone: source?.timeZone || fallback.timeZone || 'Asia/Shanghai',
    deviceInfo: source?.deviceInfo ? { ...fallback.deviceInfo, ...source.deviceInfo } : { ...fallback.deviceInfo },
  }
}

function normalizeLoginSettings(source: any) {
  return {
    wechatQrLogin: typeof source?.wechatQrLogin === 'boolean' ? source.wechatQrLogin : true,
    qqQrLogin: typeof source?.qqQrLogin === 'boolean' ? source.qqQrLogin : false,
    napCatEndpoint: typeof source?.napCatEndpoint === 'string' ? source.napCatEndpoint.trim() : '',
    napCatSignature: typeof source?.napCatSignature === 'string' ? source.napCatSignature.trim() : '',
  }
}

async function loadDevicePresets() {
  try {
    const { data } = await api.get('/api/settings/device-presets')
    if (data?.ok && Array.isArray(data.data))
      devicePresets.value = data.data
  }
  catch (e) {
    console.error('加载设备预设失败:', e)
  }
}

function applyDevicePreset(presetId: string) {
  const preset = devicePresets.value.find(item => item.id === presetId)
  if (!preset)
    return
  const deviceInfo = { ...defaultDeviceInfo, ...(preset.deviceInfo || {}) }
  localSystemConfig.value = {
    ...localSystemConfig.value,
    os: deviceInfo.os || 'Windows',
    clientVersion: deviceInfo.clientVersion || '',
    deviceInfo,
  }
  selectedPresetId.value = presetId
}

async function loadSystemConfig() {
  systemConfigLoading.value = true
  try {
    const { data } = await api.get('/api/settings/system-config')
    if (data?.ok) {
      if (Array.isArray(data.data.timeZones) && data.data.timeZones.length) {
        timeZoneOptions.value = data.data.timeZones.map((option: any) => ({
          label: String(option.label || option.value || ''),
          value: String(option.value || 'Asia/Shanghai'),
        }))
      }
      defaultSystemConfig.value = normalizeSystemConfig(data.data.default, defaultSystemConfig.value)
      localSystemConfig.value = normalizeSystemConfig(data.data.saved || data.data.default, defaultSystemConfig.value)
      localLoginSettings.value = normalizeLoginSettings(data.data.loginSettings)
    }
  }
  catch (e) {
    console.error('加载系统配置失败:', e)
  }
  finally {
    systemConfigLoading.value = false
  }
}

async function handleSaveLoginSettings() {
  if (localLoginSettings.value.qqQrLogin
    && (!localLoginSettings.value.napCatEndpoint.trim() || !localLoginSettings.value.napCatSignature.trim())) {
    toast.error('开启 QQ 扫码登录前，请配置 NapCat 接口地址和接口签名')
    return
  }
  loginSettingsSaving.value = true
  try {
    const { data } = await api.post('/api/settings/login-config', localLoginSettings.value)
    if (data?.ok) {
      localLoginSettings.value = normalizeLoginSettings(data.data)
      toast.success('登录设置已保存')
    }
    else {
      toast.error(getApiErrorMessage(data, '保存失败'))
    }
  }
  catch (e: any) {
    toast.error(`保存失败: ${getApiErrorMessage(e, '未知错误')}`)
  }
  finally {
    loginSettingsSaving.value = false
  }
}

async function handleSaveSystemConfig() {
  systemConfigSaving.value = true
  try {
    localSystemConfig.value.clientVersion = localSystemConfig.value.deviceInfo.clientVersion
    localSystemConfig.value.os = localSystemConfig.value.deviceInfo.os
    const { data } = await api.post('/api/settings/system-config', localSystemConfig.value)
    if (data?.ok)
      toast.success('系统配置已保存，连接参数在下次登录时生效')
    else
      toast.error(getApiErrorMessage(data, '保存失败'))
  }
  catch (e: any) {
    toast.error(`保存失败: ${getApiErrorMessage(e, '未知错误')}`)
  }
  finally {
    systemConfigSaving.value = false
  }
}

async function handleResetSystemConfig() {
  systemConfigSaving.value = true
  try {
    const { data } = await api.post('/api/settings/system-config/reset')
    if (data?.ok) {
      localSystemConfig.value = normalizeSystemConfig(data.data.saved, defaultSystemConfig.value)
      selectedPresetId.value = ''
      toast.success('系统配置已重置，连接参数在下次登录时生效')
    }
    else {
      toast.error(getApiErrorMessage(data, '重置失败'))
    }
  }
  catch (e: any) {
    toast.error(`重置失败: ${getApiErrorMessage(e, '未知错误')}`)
  }
  finally {
    systemConfigSaving.value = false
  }
}

onMounted(() => {
  loadSystemConfig()
  loadDevicePresets()
  loadCaptureConfig()
})
</script>

<template>
  <div class="space-y-4">
    <!-- 全局功能开关 -->
    <AdminGlobalToggles />

    <div class="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
      <!-- 运行环境：全局配置 -->
      <section class="farm-card rounded-lg p-4">
        <div class="mb-4 flex items-start gap-3">
          <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-400">
            <span class="i-carbon-settings-adjust text-xl" />
          </div>
          <div>
            <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
              运行环境
            </h4>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              服务器连接、时区与客户端设备参数
            </p>
          </div>
        </div>

        <div v-if="systemConfigLoading" class="py-8 text-center text-gray-500">
          <span class="i-svg-spinners-90-ring-with-bg inline-block text-2xl" />
        </div>
        <div v-else class="space-y-3">
          <div v-if="devicePresets.length" class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/30">
            <label class="mb-2 block text-sm text-gray-700 font-medium dark:text-gray-300">设备预设</label>
            <div class="flex flex-wrap gap-2">
              <NButton
                v-for="preset in devicePresets"
                :key="preset.id"
                size="small"
                :type="selectedPresetId === preset.id ? 'primary' : 'default'"
                :secondary="selectedPresetId !== preset.id"
                :title="preset.description"
                @click="applyDevicePreset(preset.id)"
              >
                {{ preset.name }}
              </NButton>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <BaseInput
              v-model="localSystemConfig.serverUrl"
              label="服务器地址"
              type="text"
              placeholder="wss://..."
            />
            <div>
              <BaseSelect
                v-model="localSystemConfig.timeZone"
                label="系统时区"
                :options="timeZoneOptions"
              />
              <p class="mt-1 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
                礼包、任务、安静时段和日志均以此时区为准。
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/30">
              <label class="mb-2 block text-sm text-gray-700 font-medium dark:text-gray-300">平台</label>
              <div class="flex flex-wrap gap-2">
                <NButton
                  v-for="option in platformOptions"
                  :key="option.value"
                  size="small"
                  :type="localSystemConfig.platform === option.value ? 'primary' : 'default'"
                  :secondary="localSystemConfig.platform !== option.value"
                  @click="localSystemConfig.platform = option.value"
                >
                  {{ option.label }}
                </NButton>
              </div>
            </div>
            <div class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/30">
              <label class="mb-2 block text-sm text-gray-700 font-medium dark:text-gray-300">系统</label>
              <div class="flex flex-wrap gap-2">
                <NButton
                  v-for="option in osOptions"
                  :key="option.value"
                  size="small"
                  :type="localSystemConfig.deviceInfo.os === option.value ? 'primary' : 'default'"
                  :secondary="localSystemConfig.deviceInfo.os !== option.value"
                  @click="localSystemConfig.deviceInfo.os = option.value; localSystemConfig.os = option.value"
                >
                  {{ option.label }}
                </NButton>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <BaseInput
              v-model="localSystemConfig.deviceInfo.clientVersion"
              label="QQ 客户端版本"
              type="text"
              :placeholder="defaultSystemConfig.deviceInfo.clientVersion || '从服务器加载中...'"
            />
            <BaseInput
              v-model="localSystemConfig.wxClientVersion"
              label="微信客户端版本"
              type="text"
              :placeholder="defaultSystemConfig.wxClientVersion || '从服务器加载中...'"
            />
            <BaseInput
              v-model="localSystemConfig.deviceInfo.sysSoftware"
              label="系统版本"
              type="text"
              placeholder="Windows 10"
            />
            <BaseInput
              v-model="localSystemConfig.deviceInfo.deviceId"
              label="设备标识"
              type="text"
              placeholder="DESKTOP-PC<WPC>"
            />
            <BaseInput
              v-model="localSystemConfig.deviceInfo.memory"
              label="内存 (MB)"
              type="text"
              placeholder="16384"
            />
            <BaseInput
              v-model="localSystemConfig.deviceInfo.network"
              label="网络"
              type="text"
              placeholder="wifi"
            />
            <BaseInput
              v-model="localSystemConfig.deviceInfo.userAgent"
              label="User-Agent"
              type="text"
              placeholder="Mozilla/5.0 ..."
            />
          </div>

          <div class="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
            <BaseButton variant="secondary" size="sm" :loading="systemConfigSaving" @click="handleResetSystemConfig">
              重置
            </BaseButton>
            <BaseButton variant="primary" size="sm" :loading="systemConfigSaving" @click="handleSaveSystemConfig">
              保存运行环境
            </BaseButton>
          </div>
        </div>
      </section>

      <div class="min-w-0 space-y-4">
        <!-- 登录设置（全局登录方式配置） -->
        <section class="farm-card rounded-lg p-4">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-900/25 dark:text-violet-400">
              <span class="i-carbon-login text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                登录设置
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                控制添加账号时可用的扫码登录方式
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/30">
              <BaseSwitch v-model="localLoginSettings.wechatQrLogin" label="微信扫码登录" />
            </div>
            <div class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/30">
              <BaseSwitch v-model="localLoginSettings.qqQrLogin" label="QQ扫码登录" />
            </div>
          </div>

          <div
            v-if="localLoginSettings.qqQrLogin"
            class="grid grid-cols-1 mt-4 gap-3 border border-gray-200 rounded-lg bg-gray-50/70 p-4 sm:grid-cols-2 dark:border-gray-700 dark:bg-gray-900/30"
          >
            <BaseInput
              v-model="localLoginSettings.napCatEndpoint"
              label="NapCat接口地址"
              type="text"
              placeholder="http://127.0.0.1:6099"
            />
            <BaseInput
              v-model="localLoginSettings.napCatSignature"
              label="NapCat接口签名"
              type="password"
              placeholder="请输入 NapCat 接口签名"
            />
          </div>

          <div class="mt-3 flex justify-end border-t pt-3 dark:border-gray-700">
            <BaseButton
              variant="primary"
              size="sm"
              :loading="loginSettingsSaving"
              @click="handleSaveLoginSettings"
            >
              保存登录设置
            </BaseButton>
          </div>
        </section>

        <!-- 抓包登录设置（全局抓包服务配置） -->
        <section class="farm-card rounded-lg p-4">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600 dark:bg-sky-900/25 dark:text-sky-400">
              <span class="i-carbon-data-connected text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                抓包登录设置
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                开启后可在添加账号时通过抓包自动获取登录 Code 和 QQ 好友 GID
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/30">
              <BaseSwitch v-model="localCaptureConfig.enabled" label="启用抓包登录" />
            </div>
            <div class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/30">
              <BaseSwitch v-model="localCaptureConfig.autoImportQqGids" label="自动导入 QQ 好友 GID" />
            </div>
          </div>

          <div
            v-if="localCaptureConfig.enabled"
            class="grid grid-cols-1 mt-4 gap-3 border border-gray-200 rounded-lg bg-gray-50/70 p-4 sm:grid-cols-2 dark:border-gray-700 dark:bg-gray-900/30"
          >
            <div class="border border-gray-200 rounded-lg bg-white/60 p-3 sm:col-span-2 dark:border-gray-700 dark:bg-gray-900/30">
              <BaseSwitch v-model="localCaptureConfig.embedded" label="内嵌模式（抓包服务随本面板启动，无需独立部署）" />
              <p v-if="localCaptureConfig.embedded" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {{ localCaptureConfig.running ? '抓包服务运行中' : '抓包服务将在保存后随面板自动启动' }}
              </p>
            </div>
            <template v-if="!localCaptureConfig.embedded">
              <BaseInput
                v-model="localCaptureConfig.apiBase"
                label="抓包服务地址"
                type="text"
                placeholder="http://127.0.0.1:8450"
              />
              <BaseInput
                v-model="localCaptureConfig.apiToken"
                label="API Token"
                type="password"
                :placeholder="localCaptureConfig.tokenConfigured ? '已配置（留空保持不变）' : '请输入抓包服务 API Token'"
              />
            </template>
          </div>

          <div class="mt-3 flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
            <BaseButton
              variant="outline"
              size="sm"
              :loading="captureTesting"
              :disabled="!localCaptureConfig.enabled"
              @click="handleTestCapture"
            >
              {{ localCaptureConfig.embedded ? '测试抓包服务' : '测试连接' }}
            </BaseButton>
            <BaseButton
              variant="primary"
              size="sm"
              :loading="captureConfigSaving"
              @click="handleSaveCaptureConfig"
            >
              保存抓包设置
            </BaseButton>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
