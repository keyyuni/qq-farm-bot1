export {};
/**
 * 抓包登录服务配置存储（Code/GID 抓取服务）
 *
 * 独立 JSON 文件持久化到 <dataDir>/capture-config.json，与账号配置分离，
 * 避免写入全局配置文档。通过 store.getCaptureConfig / setCaptureConfig 暴露。
 */

const { getDataFile } = require('../../config/runtime-paths');
const { readJsonFileStrict, writeJsonFileAtomic } = require('../../services/json-db');

export interface CaptureServiceConfig {
    enabled: boolean;
    embedded: boolean;
    apiBase: string;
    apiToken: string;
    autoImportQqGids: boolean;
}

export const DEFAULT_CAPTURE_CONFIG: CaptureServiceConfig = {
    enabled: true,
    embedded: true,
    apiBase: 'http://127.0.0.1:8450',
    apiToken: '',
    autoImportQqGids: true,
};

const CAPTURE_CONFIG_FILE = getDataFile('capture-config.json');

let captureConfigCache: CaptureServiceConfig | null = null;

function normalizeCaptureConfig(raw: unknown): CaptureServiceConfig {
    const src = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
    return {
        enabled: src.enabled === true,
        embedded: src.embedded !== false,
        apiBase: String(src.apiBase ?? DEFAULT_CAPTURE_CONFIG.apiBase).trim() || DEFAULT_CAPTURE_CONFIG.apiBase,
        apiToken: String(src.apiToken ?? '').trim(),
        autoImportQqGids: src.autoImportQqGids !== false,
    };
}

function loadCaptureConfig(): CaptureServiceConfig {
    try {
        const raw = readJsonFileStrict(CAPTURE_CONFIG_FILE, () => ({ ...DEFAULT_CAPTURE_CONFIG }));
        captureConfigCache = normalizeCaptureConfig(raw);
    } catch {
        captureConfigCache = { ...DEFAULT_CAPTURE_CONFIG };
    }
    return { ...captureConfigCache };
}

function getCaptureConfig(): CaptureServiceConfig {
    return captureConfigCache ? { ...captureConfigCache } : loadCaptureConfig();
}

function setCaptureConfig(input: Partial<CaptureServiceConfig> = {}): CaptureServiceConfig {
    const current = getCaptureConfig();
    const merged = normalizeCaptureConfig({
        ...current,
        ...(input && typeof input === 'object' ? input : {}),
        // apiToken 传空字符串时保留旧值（面板不回显 token）
        apiToken: input && input.apiToken !== undefined && String(input.apiToken).trim() !== ''
            ? String(input.apiToken).trim()
            : current.apiToken,
    });
    try {
        writeJsonFileAtomic(CAPTURE_CONFIG_FILE, merged);
    } catch {
        // 无写权限时仅保留内存态
    }
    captureConfigCache = merged;
    return { ...merged };
}

module.exports = {
    DEFAULT_CAPTURE_CONFIG,
    getCaptureConfig,
    setCaptureConfig,
};
