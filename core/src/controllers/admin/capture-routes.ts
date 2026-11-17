import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * 抓包登录（Code/GID 抓取服务）管理路由
 *
 * 自 qq-farm-bot 的 admin-capture-routes.js 移植，适配上游单管理员（token 鉴权）结构：
 * - 嵌入模式（默认）：进程内 createCaptureCore() 直接调用 handleApiRequest，不占独立端口；
 * - 独立模式：抓包服务独立部署时，通过 apiBase + apiToken 调用其 REST API。
 *
 * 路由：
 * - GET  /api/admin/capture-config            查询抓包服务配置
 * - POST /api/admin/capture-config/test       测试抓包服务连通性
 * - POST /api/admin/capture-config            保存抓包服务配置
 * - GET  /api/capture/config                  面板登录页查询抓包登录是否可用
 * - POST /api/capture/sessions                创建抓包会话并启动 MITM 代理
 * - GET  /api/capture/sessions/:flowId        查询抓取进度
 * - POST /api/capture/sessions/:flowId/complete 用抓到的 Code 添加/更新账号
 * - DELETE /api/capture/sessions/:flowId      取消抓取任务
 * - GET  /api/public/capture-certificate/...  下载根 CA 证书（手机安装信任用）
 */

const crypto = require('node:crypto');
const store = require('../../models/store');
const { updateRuntimeConfig, getRuntimeConfig } = require('../../config/config');
const { createAuthRequired, createRequireSuperAdminRole, handleApiError, getAccountList } = require('./middleware');
const { isSuperAdminRole } = require('../../config/user-system');
const { createCaptureCore } = require('../../capture/index');

const CAPTURE_REQUEST_TIMEOUT_MS = 15_000;
const CAPTURE_FLOW_TTL_MS = 15 * 60 * 1000;
const QQ_FRIEND_COLLECTION_MAX_MS = 15_000;
const QQ_FRIEND_COLLECTION_POLL_MS = 1500;
const CAPTURE_ACCOUNT_START_DELAY_MS = 1500;
const COMPLETE_QQ_FRIEND_SOURCES = new Set([
    'gamepb.friendpb.FriendService.GetAll',
    'gamepb.friendpb.FriendService.SyncAll',
]);

interface CaptureFlow {
    id: string;
    remoteSessionId: string;
    certificateToken: string;
    owner: string;
    accountId: string;
    platform: string;
    code: string;
    clientVersion: string;
    accountGid: string;
    openId: string;
    friendGids: Set<number>;
    friendSource: string;
    friendListComplete: boolean;
    publicInfo: Record<string, any>;
    proxy: Record<string, any>;
    captureStatus: string;
    completed: boolean;
    completing?: boolean;
    cancelled?: boolean;
    friendCollectionScheduled?: boolean;
    result: Record<string, any> | null;
    createdAt: number;
    updatedAt: number;
}

const captureFlows = new Map<string, CaptureFlow>();

// ---------- 嵌入模式抓包核心 ----------

let embeddedCaptureCore: Record<string, any> | null = null;
let embeddedCaptureStarting: Promise<Record<string, any> | null> | null = null;

function captureLog(level: string, message: string, extra?: Record<string, unknown> | string | null): void {
    const text = `${message}${extra && typeof extra === 'object' ? ` ${JSON.stringify(extra)}` : (extra ? ` ${extra}` : '')}`;
    console.log(`[capture] [${String(level).toUpperCase()}] ${text}`);
}

/** 确保进程内抓包服务核心已启动（enabled 且 embedded 时） */
function ensureEmbeddedCaptureService(): Record<string, any> | null {
    const captureConfig = store.getCaptureConfig();
    if (captureConfig.enabled !== true) return null;
    if (captureConfig.embedded === false) return null;
    if (embeddedCaptureCore) return embeddedCaptureCore;
    if (!embeddedCaptureStarting) {
        embeddedCaptureStarting = (async () => {
            try {
                const core = createCaptureCore({ log: captureLog });
                await core.ready;
                embeddedCaptureCore = core;
                return core;
            } catch (error: any) {
                captureLog('error', `抓包服务启动失败: ${error?.message || error}`);
                return null;
            } finally {
                embeddedCaptureStarting = null;
            }
        })();
    }
    void embeddedCaptureStarting;
    return embeddedCaptureCore;
}

async function stopEmbeddedCaptureService(): Promise<void> {
    const core = embeddedCaptureCore;
    embeddedCaptureCore = null;
    embeddedCaptureStarting = null;
    if (core) {
        try {
            await core.stop();
        } catch (error: any) {
            captureLog('warn', `抓包服务停止失败: ${error?.message || error}`);
        }
    }
}

// ---------- 请求配置解析 ----------

function normalizeApiBase(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 500) throw new Error('抓包服务地址无效');
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('抓包服务地址格式无效');
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
        throw new Error('抓包服务地址仅支持不含账号密码的 http(s) 地址');
    }
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
}

function resolveCaptureConfig(override: Record<string, any> = {}): Record<string, any> {
    const saved: Record<string, any> = store.getCaptureConfig();
    return {
        ...saved,
        ...override,
        apiBase: normalizeApiBase(override.apiBase || saved.apiBase),
        apiToken: String(override.apiToken || saved.apiToken || '').trim(),
    };
}

function isEmbeddedMode(): boolean {
    return !!embeddedCaptureCore;
}

async function captureRequest(config: Record<string, any>, path: string, options: {
    method?: string;
    body?: Record<string, any>;
    sessionId?: string;
    timeout?: number;
    headers?: Record<string, string>;
} = {}): Promise<Record<string, any>> {
    // 嵌入模式：进程内直接调用（不经过 HTTP，apiToken 无意义）
    if (embeddedCaptureCore) {
        const result = await embeddedCaptureCore.handleApiRequest(
            options.method || 'GET',
            path,
            options.body,
            { sessionId: options.sessionId },
        );
        const data = result?.body || {};
        if (result?.status >= 400 || data?.ok === false) {
            const error: any = new Error(data?.error || `抓包服务请求失败（${result?.status || 500}）`);
            error.captureStatus = result?.status;
            throw error;
        }
        return data;
    }

    if (!config.apiToken) throw new Error('抓包服务 API Token 未配置');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || CAPTURE_REQUEST_TIMEOUT_MS);
    try {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${config.apiToken}`,
            Accept: 'application/json',
            ...options.headers,
        };
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        if (options.sessionId) headers['x-capture-session-id'] = options.sessionId;
        const response = await fetch(`${config.apiBase}${path}`, {
            method: options.method || 'GET',
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal,
        });
        const text = await response.text();
        let data: any = null;
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            throw new Error(`抓包服务返回了无效响应（HTTP ${response.status}）`);
        }
        if (!response.ok || data?.ok === false) {
            throw new Error(data?.error || `抓包服务请求失败（HTTP ${response.status}）`);
        }
        return data;
    } catch (error: any) {
        if (error && error.name === 'AbortError') throw new Error('抓包服务请求超时');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

// ---------- Flow 管理 ----------

function getFlowOwner(req: Request): string {
    // 上游为单管理员 token 鉴权：以面板会话 token 作为任务归属标识
    return String((req as any).adminToken || '').trim() || 'admin';
}

function findOwnedFlow(flowId: unknown, owner: string): CaptureFlow | null {
    const flow = captureFlows.get(String(flowId || ''));
    if (!flow || flow.owner !== owner) return null;
    return flow;
}

function isCertificateTokenValid(flow: CaptureFlow, token: unknown): boolean {
    const expected = Buffer.from(String(flow?.certificateToken || ''), 'utf8');
    const supplied = Buffer.from(String(token || ''), 'utf8');
    return expected.length > 0
        && expected.length === supplied.length
        && crypto.timingSafeEqual(expected, supplied);
}

function mergeKnownFriendGids(existingGids: unknown, capturedGids: number[], accountGid: string): number[] {
    const ownGid = Number(accountGid);
    return [...new Set<number>([
        ...(Array.isArray(existingGids) ? existingGids : []).map(Number),
        ...capturedGids,
    ])].filter(
        gid => Number.isSafeInteger(gid) && gid > 0 && gid !== ownGid,
    );
}

function isCompleteQqFriendSource(source: unknown): boolean {
    return COMPLETE_QQ_FRIEND_SOURCES.has(String(source || '').trim());
}

function isSameAccountInstance(accountId: unknown, accountCreatedAt: unknown): boolean {
    const account = store.getAccounts().accounts.find(
        (item: any) => String(item.id) === String(accountId),
    );
    return !!account && String(account.createdAt || '') === String(accountCreatedAt || '');
}

function findDuplicateCapturedAccount(accounts: any[], flow: CaptureFlow, excludedAccountId = ''): any | null {
    const code = String(flow?.code || '').trim();
    const gid = String(flow?.accountGid || '').trim();
    const platform = flow?.platform === 'wx' ? 'wx' : 'qq';
    return (Array.isArray(accounts) ? accounts : []).find((account) => {
        if (String(account?.id || '') === String(excludedAccountId || '')) return false;
        if ((account?.platform === 'wx' ? 'wx' : 'qq') !== platform) return false;
        return (code && String(account?.code || '').trim() === code)
            || (gid && String(account?.gid || '').trim() === gid);
    }) || null;
}

function addCapturedValues(flow: CaptureFlow, snapshot: any): void {
    const data = snapshot?.data || snapshot?.state || snapshot;
    if (!data || typeof data !== 'object') return;
    const channel = data.channels?.[flow.platform];
    const entries = Array.isArray(channel?.codes) ? channel.codes : [];
    const codeEntry = entries.find((item: any) => String(item?.code || '').trim());
    const gidEntry = entries.find((item: any) => String(item?.gid || '').trim());
    const openIdEntry = entries.find((item: any) => String(item?.openid || item?.open_id || '').trim());
    if (!flow.code && codeEntry) flow.code = String(codeEntry.code).trim();
    const versionEntry = entries.find((item: any) => String(item?.code || '').trim() === flow.code
        && /^\d+(?:\.\d+){2,4}_\d{8}$/.test(String(item?.clientVersion || '')));
    if (versionEntry) flow.clientVersion = versionEntry.clientVersion;
    if (!flow.accountGid && gidEntry) flow.accountGid = String(gidEntry.gid).trim();
    if (!flow.openId && openIdEntry) {
        flow.openId = String(openIdEntry.openid || openIdEntry.open_id).trim();
    }

    const friends = Array.isArray(data.friends?.items) ? data.friends.items : [];
    for (const friend of friends) {
        const gid = Number(friend?.gid);
        if (Number.isSafeInteger(gid) && gid > 0) flow.friendGids.add(gid);
    }
    const friendSource = String(data.friends?.source || '').trim();
    if (friendSource) flow.friendSource = friendSource;
    if (isCompleteQqFriendSource(friendSource)) flow.friendListComplete = true;

    flow.publicInfo = data.publicInfo || flow.publicInfo;
    flow.proxy = data.proxy || flow.proxy;
    flow.captureStatus = channel?.status || flow.captureStatus;
    flow.updatedAt = Date.now();
}

async function refreshFlow(flow: CaptureFlow): Promise<CaptureFlow> {
    const config = resolveCaptureConfig();
    const snapshot = await captureRequest(
        config,
        `/api/sessions/${encodeURIComponent(flow.remoteSessionId)}/state`,
        { sessionId: flow.remoteSessionId },
    );
    addCapturedValues(flow, snapshot);
    return flow;
}

function serializeFlow(flow: CaptureFlow): Record<string, any> {
    const autoStopSec = Number(flow.publicInfo?.mitmProxyAutoStopSec) || 0;
    const startedAt = Date.parse(flow.proxy?.startedAt || '');
    const elapsedSec = Number.isFinite(startedAt) ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    return {
        id: flow.id,
        platform: flow.platform,
        codeCaptured: !!flow.code,
        accountGid: flow.accountGid,
        friendCount: flow.friendGids.size,
        captureStatus: flow.captureStatus,
        proxy: {
            running: flow.proxy?.running === true,
            status: String(flow.proxy?.status || ''),
            error: String(flow.proxy?.error || ''),
        },
        publicInfo: {
            host: String(flow.publicInfo?.host || ''),
            addresses: Array.isArray(flow.publicInfo?.addresses) ? flow.publicInfo.addresses : [],
            mitmPort: Number(flow.publicInfo?.mitmPort) || 0,
            mitmProxyAutoStopSec: autoStopSec,
            remainingSec: autoStopSec ? Math.max(0, autoStopSec - elapsedSec) : 0,
            certificateUrl: `/api/public/capture-certificate/${encodeURIComponent(flow.id)}/${encodeURIComponent(flow.certificateToken)}`,
        },
        completed: flow.completed === true,
        result: flow.result || null,
    };
}

async function stopRemoteFlow(flow: CaptureFlow): Promise<boolean> {
    const config = resolveCaptureConfig();
    let lastError: any = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            await captureRequest(
                config,
                `/api/sessions/${encodeURIComponent(flow.remoteSessionId)}`,
                { method: 'DELETE', sessionId: flow.remoteSessionId },
            );
            return true;
        } catch (error) {
            lastError = error;
        }

        try {
            await captureRequest(config, '/api/capture/stop', {
                method: 'POST',
                sessionId: flow.remoteSessionId,
                body: {},
            });
            return true;
        } catch (error) {
            lastError = error;
        }

        if (attempt < 3) await waitForNextCollectionPoll(attempt * 500);
    }
    throw lastError || new Error('抓包服务代理释放失败');
}

function scheduleRemoteStop(flow: CaptureFlow, delayMs = 5000): void {
    const timer = setTimeout(() => {
        void stopRemoteFlow(flow).catch((error) => {
            captureLog('warn', '抓包服务代理释放失败', {
                remoteSessionId: flow.remoteSessionId,
                error: error.message,
            });
        });
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
}

function waitForNextCollectionPoll(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        if (typeof timer.unref === 'function') timer.unref();
    });
}

async function collectQqFriendGids(options: {
    flow: CaptureFlow;
    accountId: string;
    accountCreatedAt: unknown;
    broadcastConfig?: (accountId: string) => void;
}): Promise<number> {
    const { flow, accountId, accountCreatedAt } = options;
    const deadline = Date.now() + QQ_FRIEND_COLLECTION_MAX_MS;
    let lastRefreshError: any = null;

    try {
        while (!flow.cancelled && Date.now() < deadline) {
            if (!isSameAccountInstance(accountId, accountCreatedAt)) {
                flow.cancelled = true;
                captureLog('info', '账号已删除或替换，停止旧的好友 GID 后台同步', { accountId });
                return 0;
            }
            if (flow.friendListComplete) break;

            try {
                await refreshFlow(flow);
                lastRefreshError = null;
            } catch (error) {
                lastRefreshError = error;
            }
            if (flow.friendListComplete) break;

            const remainingMs = deadline - Date.now();
            if (remainingMs > 0) await waitForNextCollectionPoll(Math.min(QQ_FRIEND_COLLECTION_POLL_MS, remainingMs));
        }

        if (flow.cancelled || !isSameAccountInstance(accountId, accountCreatedAt)) return 0;
        const knownGids = store.getKnownFriendGids(accountId);
        const gids = mergeKnownFriendGids(knownGids, [...flow.friendGids], flow.accountGid);
        const previousGids = new Set((Array.isArray(knownGids) ? knownGids : []).map(Number));
        const importedFriendCount = gids.filter(gid => !previousGids.has(gid)).length;
        if (importedFriendCount > 0) {
            store.setKnownFriendGids(accountId, gids);
            if (typeof options.broadcastConfig === 'function') {
                options.broadcastConfig(accountId);
            }
        }
        if (flow.result) flow.result.importedFriendCount = importedFriendCount;
        captureLog('info', '抓包登录好友 GID 后台同步完成', {
            accountId,
            capturedFriendCount: flow.friendGids.size,
            importedFriendCount,
            friendSource: flow.friendSource || '',
            completeFriendList: flow.friendListComplete === true,
            refreshError: lastRefreshError?.message || '',
        });
        return importedFriendCount;
    } finally {
        await stopRemoteFlow(flow);
        if (captureFlows.get(flow.id) === flow) captureFlows.delete(flow.id);
    }
}

function scheduleQqFriendCollection(options: {
    flow: CaptureFlow;
    accountId: string;
    accountCreatedAt: unknown;
    broadcastConfig?: (accountId: string) => void;
}): void {
    const { flow } = options;
    if (flow.friendCollectionScheduled) return;
    flow.friendCollectionScheduled = true;
    void collectQqFriendGids(options).catch((error) => {
        captureLog('warn', '抓包登录账号已添加，但好友 GID 后台同步失败', {
            accountId: options.accountId,
            error: error.message,
        });
    });
}

function scheduleCapturedAccountStart(options: {
    ctx: AdminContext;
    flow: CaptureFlow;
    accountId: string;
    isUpdate: boolean;
    wasRunning: boolean;
    delayMs?: number;
}): void {
    const { ctx, flow, accountId, isUpdate, wasRunning } = options;
    const timer = setTimeout(() => {
        try {
            // 抓包登录完成即视为一次全新登录：更新已有账号时无论之前是否在运行都启动（运行中的重启）
            if (isUpdate && wasRunning)
                ctx.provider.restartAccount(accountId);
            else
                ctx.provider.startAccount(accountId);
        } catch (error: any) {
            const startError = error.message || '账号启动失败';
            if (flow.result) flow.result.startError = startError;
            captureLog('warn', '抓包登录账号已添加，但延迟启动失败', {
                accountId,
                error: startError,
            });
        }
    }, options.delayMs ?? CAPTURE_ACCOUNT_START_DELAY_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
}

async function stopCaptureBeforeAccountStart(flow: CaptureFlow, start: () => void): Promise<void> {
    await stopRemoteFlow(flow);
    if (captureFlows.get(flow.id) === flow) captureFlows.delete(flow.id);
    start();
}

async function removeExistingOwnerFlows(owner: string): Promise<void> {
    const existing = [...captureFlows.values()].filter(
        flow => flow.owner === owner && !flow.completed,
    );
    for (const flow of existing) {
        await stopRemoteFlow(flow);
        captureFlows.delete(flow.id);
    }
}

async function cleanupExpiredFlows(): Promise<void> {
    const cutoff = Date.now() - CAPTURE_FLOW_TTL_MS;
    const expired = [...captureFlows.values()].filter(flow => flow.updatedAt < cutoff);
    for (const flow of expired) {
        if (!flow.completed) await stopRemoteFlow(flow);
        captureFlows.delete(flow.id);
    }
}

// ---------- 请求头工具（与浏览器访问面板地址对齐） ----------

function extractHostFromValue(raw: string): string {
    try {
        return new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).hostname
            .replace(/^\[|\]$/g, '')
            .toLowerCase();
    } catch {
        return '';
    }
}

/** 嵌入 Docker 时网卡自动探测只能看到容器 IP；此时使用浏览器访问面板的地址。 */
function getCaptureAdvertiseHost(req: Request): string {
    const values = [
        req.headers['x-forwarded-host'],
        req.headers.host,
        req.headers.origin,
        req.headers.referer,
        req.hostname,
    ];
    for (const value of values) {
        const raw = String(value || '').split(',')[0].trim();
        if (!raw) continue;
        const host = extractHostFromValue(raw);
        if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') return host;
    }
    return '';
}

function getCaptureBypassHosts(req: Request): string[] {
    const values = [
        req.hostname,
        req.headers['x-forwarded-host'],
        req.headers.host,
        req.headers.origin,
        req.headers.referer,
    ];
    const hosts: string[] = [];
    for (const value of values) {
        const raw = String(value || '').split(',')[0].trim();
        if (!raw) continue;
        const host = extractHostFromValue(raw);
        if (host && !hosts.includes(host)) hosts.push(host);
    }
    return hosts.slice(0, 8);
}

// ---------- 路由挂载 ----------

function mountCaptureRoutes(app: Application, ctx: AdminContext): void {
    const requireAuth = createAuthRequired(ctx);

    const cleanupTimer = setInterval(() => {
        void cleanupExpiredFlows().catch((error: any) => {
            captureLog('warn', '过期抓包任务清理失败', { error: error.message });
        });
    }, 60_000);
    if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

    // API: 查询抓包服务配置（管理设置页；全局服务配置仅超级管理员）
    const requireSuperAdmin = createRequireSuperAdminRole(ctx);
    app.get('/api/admin/capture-config', requireSuperAdmin, (req: Request, res: Response) => {
        try {
            const config = store.getCaptureConfig();
            res.json({
                ok: true,
                data: {
                    enabled: config.enabled === true,
                    embedded: config.embedded !== false,
                    running: isEmbeddedMode(),
                    apiBase: config.apiBase,
                    apiToken: '',
                    tokenConfigured: !!config.apiToken,
                    autoImportQqGids: config.autoImportQqGids !== false,
                },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 测试抓包服务连通性（仅超级管理员）
    app.post('/api/admin/capture-config/test', requireSuperAdmin, async (req: Request, res: Response) => {
        try {
            const config = resolveCaptureConfig((req.body || {}) as Record<string, any>);
            const health = await captureRequest(config, '/api/health');
            const data = health?.data || {};
            res.json({
                ok: true,
                data: {
                    uptime: Number(data.uptime) || 0,
                    sessions: Number(data.sessions) || 0,
                    portPoolSize: Array.isArray(data.portPool) ? data.portPool.length : 0,
                    proxyPort: Array.isArray(data.portPool) ? Number(data.portPool[0]) || 0 : 0,
                },
            });
        } catch (e: any) {
            res.status(502).json({ ok: false, error: e.message });
        }
    });

    // API: 保存抓包服务配置（仅超级管理员）
    app.post('/api/admin/capture-config', requireSuperAdmin, async (req: Request, res: Response) => {
        try {
            const input = (req.body || {}) as Record<string, any>;
            const apiBase = normalizeApiBase(input.apiBase || store.DEFAULT_CAPTURE_CONFIG.apiBase);
            const current = store.getCaptureConfig();
            const apiToken = String(input.apiToken || current.apiToken || '').trim();
            const wantsEmbedded = input.embedded !== false;
            // 嵌入模式无需 API Token；独立模式启用前必须填写
            if (input.enabled === true && !wantsEmbedded && !apiToken) {
                return res.status(400).json({ ok: false, error: '启用前请填写 API Token' });
            }
            const data = store.setCaptureConfig({ ...input, apiBase, apiToken });
            if (data.enabled === true && data.embedded !== false) {
                ensureEmbeddedCaptureService();
            } else {
                await stopEmbeddedCaptureService();
                captureFlows.clear();
            }
            captureLog('warn', '更新 Code/GID 抓取服务配置', {
                enabled: data.enabled === true,
                apiBase: data.apiBase,
                autoImportQqGids: data.autoImportQqGids !== false,
            });
            res.json({
                ok: true,
                data: {
                    enabled: data.enabled,
                    embedded: data.embedded !== false,
                    running: isEmbeddedMode(),
                    apiBase: data.apiBase,
                    apiToken: '',
                    tokenConfigured: !!data.apiToken,
                    autoImportQqGids: data.autoImportQqGids,
                },
            });
        } catch (e: any) {
            res.status(400).json({ ok: false, error: e.message });
        }
    });

    // API: 面板登录页查询抓包登录是否可用（与源项目保持一致的公开接口）
    app.get('/api/capture/config', (_req: Request, res: Response) => {
        const config = store.getCaptureConfig();
        res.json({
            ok: true,
            data: {
                enabled: config.enabled === true
                    && ((config.embedded !== false && isEmbeddedMode()) || (!!config.apiBase && !!config.apiToken)),
            },
        });
    });

    // API: 创建抓包会话并启动代理
    app.post('/api/capture/sessions', requireAuth, async (req: Request, res: Response) => {
        const owner = getFlowOwner(req);
        const platform = (req.body as any)?.platform === 'wx' ? 'wx' : 'qq';
        try {
            const accountRef = String((req.body as any)?.accountId || '').trim();
            let accountId = accountRef
                ? String((ctx.provider.resolveAccountId ? ctx.provider.resolveAccountId(accountRef) : '') || accountRef)
                : '';
            if (accountId) {
                // 用户隔离：普通用户只能把抓包流程绑定到自己的账号（防止更新他人账号凭据）
                const sessionUser = (req as any).currentUser || null;
                if (sessionUser && !isSuperAdminRole(sessionUser.role)) {
                    const owned = getAccountList(ctx, sessionUser).some(
                        (account: any) => String(account.id || '') === accountId,
                    );
                    if (!owned) {
                        return res.status(403).json({ ok: false, error: '无权操作该账号' });
                    }
                }
                const existing = store.getAccounts().accounts.find(
                    (account: any) => String(account.id) === accountId,
                );
                if (!existing) {
                    return res.status(404).json({ ok: false, error: '目标账号不存在' });
                }
            }
            const config = resolveCaptureConfig();
            if (!config.enabled) {
                return res.status(403).json({ ok: false, error: '抓包登录添加账号未启用' });
            }
            await removeExistingOwnerFlows(owner);

            const flowId = crypto.randomBytes(18).toString('base64url');
            const remoteSessionId = crypto.randomBytes(18).toString('base64url');
            const session = await captureRequest(config, '/api/sessions', {
                method: 'POST',
                sessionId: remoteSessionId,
                body: { sessionId: remoteSessionId },
            });
            const flow: CaptureFlow = {
                id: flowId,
                remoteSessionId,
                certificateToken: crypto.randomBytes(24).toString('base64url'),
                owner,
                accountId,
                platform,
                code: '',
                clientVersion: '',
                accountGid: '',
                openId: '',
                friendGids: new Set<number>(),
                friendSource: '',
                friendListComplete: false,
                publicInfo: {},
                proxy: {},
                captureStatus: 'idle',
                completed: false,
                result: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            addCapturedValues(flow, session);
            captureFlows.set(flowId, flow);
            try {
                const started = await captureRequest(config, '/api/capture/start', {
                    method: 'POST',
                    sessionId: remoteSessionId,
                    body: {
                        mode: platform,
                        bypassHosts: getCaptureBypassHosts(req),
                        advertiseHost: isEmbeddedMode() ? getCaptureAdvertiseHost(req) : '',
                    },
                    timeout: 30_000,
                });
                addCapturedValues(flow, started);
            } catch (error) {
                captureFlows.delete(flowId);
                await stopRemoteFlow(flow);
                throw error;
            }
            res.json({ ok: true, data: serializeFlow(flow) });
        } catch (error: any) {
            captureLog('warn', '启动抓包登录失败', { platform, error: error.message });
            res.status(502).json({ ok: false, error: error.message });
        }
    });

    // API: 查询抓取进度
    app.get('/api/capture/sessions/:flowId', requireAuth, async (req: Request, res: Response) => {
        const flow = findOwnedFlow(req.params.flowId, getFlowOwner(req));
        if (!flow) return res.status(404).json({ ok: false, error: '抓取任务不存在或已过期' });
        try {
            if (!flow.completed) await refreshFlow(flow);
            res.json({ ok: true, data: serializeFlow(flow) });
        } catch (error: any) {
            res.status(502).json({ ok: false, error: error.message, data: serializeFlow(flow) });
        }
    });

    // API: 下载根 CA 证书（公开链接，flowId + token 鉴权，供手机直接访问）
    app.get('/api/public/capture-certificate/:flowId/:token', async (req: Request, res: Response) => {
        const flow = captureFlows.get(String(req.params.flowId || ''));
        if (!flow || !isCertificateTokenValid(flow, req.params.token)) {
            return res.status(404).json({ ok: false, error: '证书链接不存在或已过期' });
        }
        try {
            const config = resolveCaptureConfig();
            const certPath = String(flow.publicInfo?.certUrl || '/cert/mitmproxy-ca-cert.cer');
            if (!certPath.startsWith('/') || certPath.startsWith('//')) {
                throw new Error('抓包服务证书地址无效');
            }
            // 嵌入模式：直接取进程内 CA 证书
            if (embeddedCaptureCore && typeof embeddedCaptureCore.getCaCertDer === 'function') {
                const der = embeddedCaptureCore.getCaCertDer();
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('Content-Type', 'application/x-x509-ca-cert');
                res.setHeader('Content-Disposition', 'inline; filename="mitmproxy-ca-cert.cer"');
                res.send(der);
                return;
            }
            const response = await fetch(`${config.apiBase}${certPath}` as any, { timeout: CAPTURE_REQUEST_TIMEOUT_MS } as any);
            if (!response.ok) throw new Error(`证书下载失败（HTTP ${response.status}）`);
            const buffer = Buffer.from(await response.arrayBuffer());
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Type', 'application/x-x509-ca-cert');
            res.setHeader('Content-Disposition', 'inline; filename="mitmproxy-ca-cert.cer"');
            res.send(buffer);
        } catch (error: any) {
            res.status(502).json({ ok: false, error: error.message });
        }
    });

    // API: 用抓到的 Code 添加/更新账号
    app.post('/api/capture/sessions/:flowId/complete', requireAuth, async (req: Request, res: Response) => {
        const flow = findOwnedFlow(req.params.flowId, getFlowOwner(req));
        if (!flow) return res.status(404).json({ ok: false, error: '抓取任务不存在或已过期' });
        if (flow.completed) return res.json({ ok: true, data: flow.result });
        if (flow.completing) return res.status(409).json({ ok: false, error: '账号正在添加中' });
        flow.completing = true;
        try {
            if (!flow.code) await refreshFlow(flow);
            if (!flow.code) return res.status(400).json({ ok: false, error: '尚未获取到 Code' });

            const isUpdate = !!flow.accountId;
            const allAccounts = store.getAccounts().accounts;
            const duplicate = findDuplicateCapturedAccount(allAccounts, flow, flow.accountId);
            if (duplicate) {
                flow.cancelled = true;
                captureFlows.delete(flow.id);
                captureLog('warn', '抓包登录检测到重复账号，已停止本次添加', {
                    platform: flow.platform,
                    duplicateAccountId: duplicate.id,
                });
                res.status(409).json({
                    ok: false,
                    code: 'DUPLICATE_CAPTURE_ACCOUNT',
                    error: '检测到当前仍是已添加的账号，请先切换到目标 QQ，再重新开始抓取',
                });
                scheduleRemoteStop(flow, 0);
                return;
            }

            // 用户隔离：普通用户不能把抓包流程绑定到他人账号上
            const captureUser = (req as any).currentUser || null;
            const captureOwnerName = String(captureUser?.username || '').trim();
            if (isUpdate && captureUser && !isSuperAdminRole(captureUser.role)) {
                const owned = getAccountList(ctx, captureUser).some((a: any) => String(a.id || '') === String(flow.accountId));
                if (!owned) return res.status(403).json({ ok: false, error: '无权操作该账号' });
            }

            const name = String((req.body as any)?.name || '').trim();
            const existing = isUpdate
                ? allAccounts.find((account: any) => String(account.id) === flow.accountId)
                : null;
            if (isUpdate && !existing) throw new Error('目标账号不存在');
            const wasRunning = isUpdate && ctx.provider.isAccountRunning
                ? ctx.provider.isAccountRunning(flow.accountId)
                : false;
            const accountPayload: Record<string, any> = {
                ...(isUpdate ? { id: flow.accountId } : {}),
                name: name || existing?.name || '',
                code: flow.code,
                platform: flow.platform,
                loginType: 'capture',
                // 用户隔离：新增账号时写入归属（与 /api/accounts 行为一致）
                ...(!isUpdate && captureOwnerName ? { owner: captureOwnerName } : {}),
                ...(flow.accountGid ? { gid: flow.accountGid } : {}),
                ...(flow.openId ? { openId: flow.openId } : {}),
            };
            const accounts = store.addOrUpdateAccount(accountPayload as any);
            const created = isUpdate
                ? accounts.accounts.find((account: any) => String(account.id) === flow.accountId)
                : accounts.accounts.at(-1);
            if (!created) throw new Error('账号保存失败');

            // 抓包获得更新客户端版本时，同步到系统配置并广播给 worker
            if (flow.clientVersion) {
                try {
                    const saved = store.setSystemConfig({ clientVersion: flow.clientVersion });
                    updateRuntimeConfig(saved);
                    if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                        ctx.provider.broadcastConfig('');
                    }
                    captureLog('info', `已同步抓包客户端版本: ${flow.clientVersion}`);
                } catch (error: any) {
                    captureLog('warn', '同步抓包客户端版本失败', { error: error.message });
                }
            }
            flow.completed = true;
            flow.result = {
                accountId: created.id,
                name: created.name,
                platform: flow.platform,
                importedFriendCount: 0,
                startError: '',
            };

            try {
                if (ctx.provider.addAccountLog) {
                    ctx.provider.addAccountLog(
                        isUpdate ? 'update' : 'add',
                        `抓包登录${isUpdate ? '更新' : '添加'}账号: ${created.name || created.id}`,
                        created.id,
                        created.name || '',
                        { platform: flow.platform },
                    );
                }
            } catch { /* 忽略日志失败 */ }

            flow.result = {
                accountId: created.id,
                name: created.name,
                platform: flow.platform,
                importedFriendCount: 0,
                startError: '',
                updated: isUpdate,
            };
            flow.updatedAt = Date.now();
            res.json({ ok: true, data: flow.result });
            const startAccount = () => scheduleCapturedAccountStart({
                ctx,
                flow,
                accountId: created.id,
                isUpdate,
                wasRunning,
            });
            const config = store.getCaptureConfig();
            if (flow.platform === 'qq' && config.autoImportQqGids !== false) {
                scheduleQqFriendCollection({
                    flow,
                    accountId: created.id,
                    accountCreatedAt: created.createdAt,
                    broadcastConfig: (accountId: string) => {
                        if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                            ctx.provider.broadcastConfig(accountId);
                        }
                    },
                });
            } else {
                void stopCaptureBeforeAccountStart(flow, startAccount).catch((error) => {
                    captureLog('warn', '抓包服务代理释放失败，账号未启动', {
                        accountId: created.id,
                        remoteSessionId: flow.remoteSessionId,
                        error: error.message,
                    });
                });
            }
        } catch (error: any) {
            captureLog('warn', '抓包登录添加账号失败', {
                platform: flow.platform,
                error: error.message,
            });
            res.status(500).json({ ok: false, error: error.message });
        } finally {
            flow.completing = false;
        }
    });

    // API: 取消抓取任务
    app.delete('/api/capture/sessions/:flowId', requireAuth, async (req: Request, res: Response) => {
        const flow = findOwnedFlow(req.params.flowId, getFlowOwner(req));
        if (!flow) return res.json({ ok: true });
        flow.cancelled = true;
        captureFlows.delete(flow.id);
        res.json({ ok: true });
        scheduleRemoteStop(flow, 0);
    });
}

module.exports = {
    addCapturedValues,
    ensureEmbeddedCaptureService,
    findDuplicateCapturedAccount,
    getCaptureAdvertiseHost,
    getCaptureBypassHosts,
    isCertificateTokenValid,
    isCompleteQqFriendSource,
    isEmbeddedMode,
    mergeKnownFriendGids,
    mountCaptureRoutes,
    normalizeApiBase,
    stopEmbeddedCaptureService,
};
