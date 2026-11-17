export {};
/**
 * 抓包服务入口
 *
 * 提供两种运行方式：
 * - 嵌入模式（默认）：createCaptureCore() 在 bot 进程内运行，REST API 由
 *   controllers/admin/capture-routes 进程内直接调用（handleApiRequest），不占用独立端口；
 * - 独立模式：startCaptureServer() 额外启动 Express 监听独立端口（如 8450），
 *   供 `pnpm capture:start` / `capture-server.ts` 使用。
 *
 * 两种模式共享同一套核心：CA → 会话存储 → MITM 代理 → 好友提取器。
 */

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const {
    getCaCertDer,
    getSecureContextForHost,
    loadOrCreateRootCa,
} = require('./ca');
const { createSessionStore } = require('./session-store');
const { createMitmProxyManager } = require('./mitm-proxy');
const { createCaptureApi } = require('./api-server');
const { createFriendExtractor } = require('./friend-extractor');

export interface CaptureCore {
    config: Record<string, any>;
    dataDir: string;
    log: import('./mitm-proxy').CaptureLoggerLike;
    ready: Promise<void>;
    ca: Record<string, any>;
    sessionStore: import('./session-store').SessionStore;
    api: ReturnType<typeof createCaptureApi>;
    handleApiRequest(method: string, path: string, body?: Record<string, any>, context?: { sessionId?: string }): Promise<import('./api-server').CaptureApiResult>;
    getCaCertDer(): Buffer;
    proxyManager(): ReturnType<typeof createMitmProxyManager> | null;
    stop(): Promise<void>;
}

/** 组合并导出 CA 模块接口（供代理管理器使用） */
function buildCaModule(ca: import('./ca').RootCa) {
    return {
        getSecureContextForHost: (host: string) => getSecureContextForHost(ca, host),
        getCaCertDer: () => getCaCertDer(ca),
    };
}

/**
 * 创建抓包服务核心（不监听任何端口，可嵌入 bot 进程）。
 *
 * 同步创建并立即返回，内部异步初始化（proto 加载、代理管理器就绪），
 * 通过 `core.ready` 等待；handleApiRequest 内部会自动等待 ready。
 */
function createCaptureCore(options: { dataDir?: string; log?: import('./mitm-proxy').CaptureLoggerLike } = {}): CaptureCore {
    const { config, dataDir } = loadConfig(options);
    const log = options.log || createLogger(config.logLevel);

    const rootCa = loadOrCreateRootCa(dataDir);
    const ca = buildCaModule(rootCa);
    const sessionStore = createSessionStore({ config });

    let proxyManager: ReturnType<typeof createMitmProxyManager> | null = null;
    let cleanupTimer: NodeJS.Timeout | null = null;
    let stopRequested = false;

    const ready = (async () => {
        const friendExtractor = await createFriendExtractor();
        proxyManager = createMitmProxyManager({ config, ca, friendExtractor, sessionStore, log });
        log('info', '好友 GID 提取器就绪（proto 加载完成）');
    })();
    ready.catch((error: any) => {
        log('error', `抓包服务初始化失败: ${error.message}`);
    });

    const api = createCaptureApi({
        config,
        ca,
        sessionStore,
        proxyManager: {
            startForSession: (...args: any[]) => ready.then(() => proxyManager!.startForSession(...args as [any, any?])),
            stopForSession: (...args: any[]) => ready.then(() => proxyManager!.stopForSession(...args as [any])),
        },
        log,
    });

    cleanupTimer = setInterval(() => {
        sessionStore.cleanupExpired();
    }, 60_000);
    if (cleanupTimer.unref) cleanupTimer.unref();

    async function stop(): Promise<void> {
        if (stopRequested) return;
        stopRequested = true;
        if (cleanupTimer) clearInterval(cleanupTimer);
        await ready;
        for (const id of sessionStore.listSessions()) {
            const session = sessionStore.getSession(id);
            if (session && proxyManager) await proxyManager.stopForSession(session);
        }
        log('info', '抓包服务核心已停止');
    }

    return {
        config,
        dataDir,
        log,
        ready,
        ca,
        sessionStore,
        api,
        handleApiRequest: async (method, path, body, context) => {
            await ready;
            return api.handleApiRequest(method, path, body, context);
        },
        getCaCertDer: () => api.getCaCertDer(),
        proxyManager: () => proxyManager,
        stop,
    };
}

/**
 * 启动独立抓包服务（监听 API 端口）
 */
async function startCaptureServer(options: { dataDir?: string; log?: import('./mitm-proxy').CaptureLoggerLike } = {}) {
    const core = createCaptureCore(options);
    await core.ready;
    await core.api.start();

    return {
        config: core.config,
        dataDir: core.dataDir,
        stop: core.stop,
        apiServer: core.api,
        sessionStore: core.sessionStore,
        proxyManager: core.proxyManager(),
        ca: core.ca,
        log: core.log,
    };
}

module.exports = {
    buildCaModule,
    createCaptureCore,
    startCaptureServer,
};
