export {};
const { getNativeWxLoginCode } = require('./wx-login/native-protocol');
const { WxLoginService } = require('./wx-login/service');

/** 农场小程序 AppID（与 wx-login 路由的 TARGET_APP_ID 一致） */
const FARM_APP_ID = 'wx5306c5978fdb76e4';

/**
 * 微信可再生凭证服务（自 qq-farm-bot 移植）。
 *
 * 微信扫码账号保存了 loginBuffer（可换发 Code）与 refreshtoken（滚动续期凭证）：
 * - loginBuffer 实际有效期 > 2h，refreshtoken 约 2h 过期——必须每 30 分钟主动续期，
 *   否则 loginBuffer 失效时 refreshtoken 已过期，只能重新扫码。
 * - refreshtoken 是滚动凭证：每次刷新后旧值立即失效，无论成功失败都要持久化新值。
 */

const wxLoginService = new WxLoginService();

/** 同一账号的凭证操作串行化，避免保活/刷新/重登并发滚动凭证互相覆盖 */
const accountCredentialLocks = new Map<string, Promise<any>>();
/** 去重并发发起的同一账号换 Code 请求 */
const farmCodeRequests = new Map<string, Promise<any>>();

function withAccountCredentialLock<T>(openid: string, accountId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${String(openid || '')}:${String(accountId || '')}`;
    const prev = accountCredentialLocks.get(key) || Promise.resolve();
    const next = prev.then(operation, operation);
    accountCredentialLocks.set(key, next.finally(() => {
        if (accountCredentialLocks.get(key) === next) accountCredentialLocks.delete(key);
    }).catch(() => undefined));
    return next;
}

function errorMessage(error: unknown): string {
    return (error instanceof Error) ? error.message : String(error || 'unknown');
}

/** MMTLS 握手失败等错误 → 可读指引（区分凭证失效与网络波动），并抹除 token 内容 */
function humanizeWxCodeError(raw: unknown): string {
    const s = String(raw || '').replace(/(\btoken\s+)[^\s,;]+/gi, '$1[REDACTED]');
    if (s.includes('ManualAuth rejected')) {
        return '微信登录凭证已失效，请在面板重新扫码登录';
    }
    if (s.includes('socket read timeout') || s.includes('Unable to establish') || s.includes('invalid HTTP response')) {
        return '无法连接微信服务器（网络波动），请稍后重试；若持续失败请重新扫码登录';
    }
    return s;
}

function asRotatedCredentialError(error: unknown): Error & { refreshtoken?: string; accesstoken?: string } {
    return (error instanceof Error ? error : new Error(String(error))) as Error & { refreshtoken?: string; accesstoken?: string };
}

function persistAccountFields(addOrUpdateAccount: (acc: any) => any, account: any, updates: Record<string, any>): void {
    if (!addOrUpdateAccount || !account || !account.id) return;
    try {
        addOrUpdateAccount({ id: account.id, ...updates });
    } catch (error) {
        // 持久化失败只记录，不影响主流程
    }
}

/**
 * 微信凭证主动保活：用 refreshtoken 换新 loginBuffer + refreshtoken（滚动续期）。
 * 每 30 分钟调用一次：refreshtoken 2h 窗口内滚动续期，永不失效。
 */
async function keepWxCredentialAlive(account: any): Promise<{ Success: boolean; Message?: string }> {
    const acc = account || {};
    if (!acc.wxid || !acc.refreshtoken || !acc.loginBuffer) {
        return { Success: false, Message: '缺少微信凭证（refreshtoken/loginBuffer），请重新扫码登录' };
    }
    const store = require('../models/store');
    return withAccountCredentialLock(acc.wxid, acc.id, async () => {
        try {
            const refreshed = await wxLoginService.refreshLoginBuffer({
                openid: String(acc.wxid),
                refreshtoken: String(acc.refreshtoken),
                accesstoken: String(acc.accesstoken || ''),
                cookies: new Map(),
            });
            persistAccountFields(store.addOrUpdateAccount, acc, {
                loginBuffer: refreshed.loginBuffer,
                refreshtoken: refreshed.refreshtoken,
                accesstoken: refreshed.accesstoken || acc.accesstoken || '',
            });
            return { Success: true };
        } catch (error) {
            const rotatedError = asRotatedCredentialError(error);
            const updates: Record<string, any> = {};
            if (rotatedError.refreshtoken) updates.refreshtoken = rotatedError.refreshtoken;
            if (rotatedError.accesstoken) updates.accesstoken = rotatedError.accesstoken;
            if (Object.keys(updates).length > 0) {
                persistAccountFields(store.addOrUpdateAccount, acc, updates);
            }
            return { Success: false, Message: humanizeWxCodeError(rotatedError.message) };
        }
    });
}

/**
 * 用账号持久化凭证换发新 Code：
 * 1) 有 refreshtoken → 先保活续期；2) loginBuffer → issueCode；
 * 3) loginBuffer 失效（ManualAuth rejected）→ 用 refreshtoken 自动续期后重试。
 * 成功后把滚动凭证持久化到账号。
 */
async function issueFarmCodeForAccount(account: any): Promise<{ Success: boolean; Data?: { code: string }; Message?: string }> {
    const acc = account || {};
    const wxid = String(acc.wxid || '').trim();
    if (!wxid) return { Success: false, Message: '账号缺少 wxid，无法自动刷新 Code' };
    if (!acc.loginBuffer) return { Success: false, Message: '账号缺少登录凭证（loginBuffer），请重新扫码登录' };

    const store = require('../models/store');
    const requestKey = `account:${String(acc.id || wxid)}`;
    const inFlight = farmCodeRequests.get(requestKey);
    if (inFlight) return inFlight;

    const operation = withAccountCredentialLock(wxid, String(acc.id || ''), async () => {
        // 拿锁后重读最新账号，避免使用已被其他操作滚动过的旧凭证
        let latest: any = acc;
        try {
            const data = store.getAccounts();
            const found = (data.accounts || []).find((a: any) => String(a.id) === String(acc.id));
            if (found) latest = found;
        } catch { /* keep acc */ }

        try {
            // 注意：这里已经持有 withAccountCredentialLock 锁，绝不能调用同样加锁的
            // keepWxCredentialAlive（同 key 重入会死锁）。直接调用底层无锁的
            // refreshLoginBuffer 做主动续期（对齐源项目 qq-farm-bot 的做法）。
            if (latest.refreshtoken) {
                const refreshed = await wxLoginService.refreshLoginBuffer({
                    openid: String(latest.wxid),
                    refreshtoken: String(latest.refreshtoken),
                    accesstoken: String(latest.accesstoken || ''),
                    cookies: new Map(),
                });
                persistAccountFields(store.addOrUpdateAccount, latest, {
                    loginBuffer: refreshed.loginBuffer,
                    refreshtoken: refreshed.refreshtoken,
                    accesstoken: refreshed.accesstoken || latest.accesstoken || '',
                });
                // 保活成功后重读（loginBuffer/refreshtoken 已滚动）
                latest = { ...latest, ...refreshed };
            }

            let code = '';
            try {
                code = await getNativeWxLoginCode(String(latest.loginBuffer), FARM_APP_ID);
                return { Success: true, Data: { code } };
            } catch (issueError) {
                const msg = errorMessage(issueError);
                const refreshable = latest.refreshtoken && String(latest.refreshtoken).trim();
                if (!refreshable || !msg.includes('ManualAuth rejected')) {
                    return { Success: false, Message: `获取 Code 失败: ${humanizeWxCodeError(msg)}` };
                }
                // loginBuffer 失效 → 用 refreshtoken 续期后重试
                try {
                    const refreshed = await wxLoginService.refreshLoginBuffer({
                        openid: String(latest.wxid),
                        refreshtoken: String(latest.refreshtoken),
                        accesstoken: String(latest.accesstoken || ''),
                        cookies: new Map(),
                    });
                    persistAccountFields(store.addOrUpdateAccount, latest, {
                        loginBuffer: refreshed.loginBuffer,
                        refreshtoken: refreshed.refreshtoken,
                        accesstoken: refreshed.accesstoken || latest.accesstoken || '',
                    });
                    code = await getNativeWxLoginCode(refreshed.loginBuffer, FARM_APP_ID);
                    return { Success: true, Data: { code } };
                } catch (refreshError) {
                    const rotatedError = asRotatedCredentialError(refreshError);
                    const updates: Record<string, any> = {};
                    if (rotatedError.refreshtoken) updates.refreshtoken = rotatedError.refreshtoken;
                    if (rotatedError.accesstoken) updates.accesstoken = rotatedError.accesstoken;
                    if (Object.keys(updates).length > 0) {
                        // token 刷新成功后凭证已滚动；即使换 loginBuffer 失败，也必须保存新 token
                        persistAccountFields(store.addOrUpdateAccount, latest, updates);
                    }
                    return {
                        Success: false,
                        Message: `获取 Code 失败: ${humanizeWxCodeError(rotatedError.message)}（自动续期失败，请重新扫码登录）`,
                    };
                }
            }
        } catch (error) {
            return { Success: false, Message: `获取 Code 失败: ${humanizeWxCodeError(errorMessage(error))}` };
        }
    });

    farmCodeRequests.set(requestKey, operation);
    operation.finally(() => {
        if (farmCodeRequests.get(requestKey) === operation) farmCodeRequests.delete(requestKey);
    });
    return operation;
}

module.exports = {
    humanizeWxCodeError,
    keepWxCredentialAlive,
    issueFarmCodeForAccount,
};
