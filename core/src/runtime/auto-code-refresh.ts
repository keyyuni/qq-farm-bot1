export {};
const { createScheduler } = require('../services/scheduler');
const { keepWxCredentialAlive, issueFarmCodeForAccount } = require('../services/wx-credentials');
const kickGuard = require('../services/kick-guard');

/**
 * 微信定时刷新 Code / 自动重登服务（自 qq-farm-bot 移植）。
 *
 * - 定时刷新：按账号配置的间隔获取新 Code 并重启账号（仅微信扫码账号有可再生凭证）。
 * - 凭证保活：每 30 分钟滚动续期 refreshtoken，使其永不失效。
 * - 自动重登：账号被踢 / 重连失败 / Code 失效时按阶梯延迟（先快后慢）自动恢复，
 *   每日恢复次数与连续失败次数超限后熔断，避免拿凭证猛砸服务器。
 */

// 掉线后的重登阶梯：先快后慢。前四次在 5 分钟内试完，
// 超过阶梯再退回用户配置的定时间隔，避免拿凭证猛砸服务器。
const RELOGIN_LADDER_MS = [10 * 1000, 30 * 1000, 90 * 1000, 300 * 1000];

function reloginDelayMs(attempt: number, intervalMinutes: number = 60): number {
    const index = Math.max(0, (Number(attempt) || 1) - 1);
    if (index < RELOGIN_LADDER_MS.length) return RELOGIN_LADDER_MS[index];
    return Math.max(1, Number(intervalMinutes) || 60) * 60000;
}

interface AutoCodeRefreshOptions {
    store: any;
    getAccounts: () => any;
    addOrUpdateAccount: (acc: any) => any;
    resolveWorkerControls: () => { restartWorker?: (acc: any) => void };
    log: (tag: string, msg: string, extra?: any) => void;
    addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
}

function createAutoCodeRefreshService(options: AutoCodeRefreshOptions) {
    const { store, getAccounts, addOrUpdateAccount, resolveWorkerControls, log, addAccountLog } = options;

    const scheduler = createScheduler('auto_code_refresh');
    const recoveryState = new Map<string, { date: string; attempts: number; failures: number }>();
    const reloginStreak = new Map<string, number>();
    const MAX_DAILY_RECOVERIES = 8;
    const MAX_CONSECUTIVE_FAILURES = 3;

    function getRecoveryState(accountId: string) {
        const date = new Date().toISOString().slice(0, 10);
        const current = recoveryState.get(String(accountId));
        if (!current || current.date !== date) {
            const fresh = { date, attempts: 0, failures: 0 };
            recoveryState.set(String(accountId), fresh);
            return fresh;
        }
        return current;
    }

    function isRecoveryReason(reason: unknown): boolean {
        return ['ws_400', 'kickout:', 'ws_reconnect_failed:', 'refresh_failed']
            .some(prefix => String(reason || '').includes(prefix));
    }

    function getTaskName(accountId: string): string {
        return `refresh_${String(accountId || '')}`;
    }

    function getKeepaliveTaskName(accountId: string): string {
        return `wx_keepalive_${String(accountId || '')}`;
    }

    function findAccount(accountId: string): any {
        const data = getAccounts();
        const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
        return accounts.find((acc: any) => String(acc.id) === String(accountId));
    }

    function normalizeConfig(accountId: string): { enabled: boolean; intervalMinutes: number } {
        const cfg = store.getAutoCodeRefresh ? store.getAutoCodeRefresh(accountId) : null;
        return {
            enabled: cfg && cfg.enabled === true,
            intervalMinutes: Math.max(1, Math.min(1440, Number(cfg && cfg.intervalMinutes) || 60)),
        };
    }

    async function requestFarmCode(account: any): Promise<string> {
        const wxid = String(account && account.wxid || '').trim();
        if (!wxid) throw new Error('账号缺少 wxid，无法自动刷新 Code');

        if (!account.loginBuffer) throw new Error('账号缺少应用宝登录凭据，请重新扫码登录');
        if (account.refreshtoken) {
            const keepalive = await keepWxCredentialAlive(account);
            if (!keepalive.Success) throw new Error(keepalive.Message || '微信凭证续期失败');
        }
        const local = await issueFarmCodeForAccount(account);
        if (local.Success && local.Data && local.Data.code) return String(local.Data.code);
        throw new Error(local.Message || '进程内获取 Code 失败');
    }

    async function refreshAccountCode(accountId: string, reason: string = 'timer'): Promise<boolean> {
        log('系统', `[自动重登] 刷新流程进入: reason=${reason}`, {
            accountId: String(accountId),
        });
        const account = findAccount(accountId);
        if (!account) {
            log('警告', `[自动重登] 找不到账号 ${accountId}，放弃刷新`);
            return false;
        }

        // 只有微信扫码号才有可再生凭证（wxid + 登录缓冲）。
        // QQ 号没有任何本地凭据可以换新 Code，硬刷只会刷出一串「缺少 wxid」错误，
        // 所以这里直接跳过，给一条明确提示，让用户去重新扫码。
        if (String(account.platform || '') !== 'wx') {
            addAccountLog('auto_code_refresh_skipped', 'QQ 账号没有可再生凭证，需要重新扫码登录',
                account.id, account.name, { reason });
            log('警告', `QQ 账号无法自动刷新 Code，请重新扫码: ${account.name}`, {
                accountId: String(account.id),
                accountName: account.name,
            });
            return false;
        }

        const recovery = isRecoveryReason(reason) ? getRecoveryState(accountId) : null;
        if (recovery && (recovery.attempts >= MAX_DAILY_RECOVERIES
            || recovery.failures >= MAX_CONSECUTIVE_FAILURES)) {
            addAccountLog('auto_relogin_blocked', '自动重登已熔断，请检查网络或重新扫码',
                account.id, account.name, { reason, ...recovery });
            return false;
        }
        if (recovery) recovery.attempts += 1;

        try {
            const code = await requestFarmCode(account);
            const nextAccount = { ...account, code };
            addOrUpdateAccount(nextAccount);

            const controls = typeof resolveWorkerControls === 'function' ? (resolveWorkerControls() || {}) : {};
            if (typeof controls.restartWorker === 'function') controls.restartWorker(nextAccount);

            addAccountLog('auto_code_refresh', `自动刷新 Code 成功，已重启账号: ${account.name}`,
                account.id, account.name, { reason });
            log('系统', `自动刷新 Code 成功: ${account.name}`, {
                accountId: String(account.id),
                accountName: account.name,
            });
            if (recovery) recovery.failures = 0;
            reloginStreak.delete(String(accountId));
            return true;
        } catch (err: any) {
            if (recovery) recovery.failures += 1;
            addAccountLog('auto_code_refresh_failed', `自动刷新 Code 失败: ${err.message}`,
                account.id, account.name, { reason });
            log('错误', `自动刷新 Code 失败: ${account.name} - ${err.message}`, {
                accountId: String(account.id),
                accountName: account.name,
            });
            return false;
        }
    }

    function scheduleAccount(accountId: string): void {
        const cfg = normalizeConfig(accountId);
        const taskName = getTaskName(accountId);
        scheduler.clear(taskName);
        scheduler.clear(getKeepaliveTaskName(accountId));

        const account = findAccount(accountId);
        // Code refresh and credential keepalive only apply to WeChat scan-login accounts.
        // All accounts are passed through rescheduleAll(), so QQ accounts must exit quietly.
        if (!account || account.platform !== 'wx') return;

        if (!String(account.wxid || '').trim()) {
            log('系统', '自动刷新 Code 未启动: 账号缺少 wxid', {
                accountId: String(accountId),
                accountName: account.name || '',
            });
            return;
        }

        if (account.loginBuffer && account.refreshtoken) {
            scheduler.setIntervalTask(getKeepaliveTaskName(accountId), 30 * 60000, async () => {
                const latest = findAccount(accountId);
                if (!latest) return;
                const result = await keepWxCredentialAlive(latest);
                if (!result.Success) {
                    log('错误', `微信凭证保活失败: ${latest.name} - ${result.Message || '未知错误'}`, {
                        accountId: String(accountId), accountName: latest.name,
                    });
                }
            }, { preventOverlap: true });
        }

        if (!cfg.enabled) return;

        scheduler.setIntervalTask(taskName, cfg.intervalMinutes * 60000, () => {
            // 刚被其他终端顶号时先让路：刷完重启只会再被顶一次，白白耗掉一次凭证
            if (kickGuard.isRecentlyKicked(accountId)) {
                const latest = findAccount(accountId);
                log('系统', `跳过本轮自动刷新：账号 ${latest ? latest.name : accountId} 刚被其他终端顶号，先让路`, {
                    accountId: String(accountId),
                    accountName: latest ? latest.name : '',
                });
                return;
            }
            refreshAccountCode(accountId, 'timer');
        }, { preventOverlap: true });

        log('系统', `自动刷新 Code 已启用: ${account.name}，间隔 ${cfg.intervalMinutes} 分钟`, {
            accountId: String(accountId),
            accountName: account.name,
        });
    }

    function rescheduleAll(): void {
        scheduler.clearAll();
        const data = getAccounts();
        const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
        for (const account of accounts) {
            scheduleAccount(account.id);
        }
    }

    function stopAccount(accountId: string): void {
        scheduler.clear(getTaskName(accountId));
        scheduler.clear(getKeepaliveTaskName(accountId));
        scheduler.clear(`relogin_${String(accountId || '')}`);
    }

    function scheduleRelogin(accountId: string, reason: string = 'offline'): boolean {
        const cfg = normalizeConfig(accountId);
        if (!cfg.enabled) return false;
        const account = findAccount(accountId);
        if (!account || !account.loginBuffer) return false;
        const recovery = getRecoveryState(accountId);
        if (recovery.attempts >= MAX_DAILY_RECOVERIES
            || recovery.failures >= MAX_CONSECUTIVE_FAILURES) {
            addAccountLog('auto_relogin_blocked', '自动重登次数已达上限，请检查网络或重新扫码',
                account.id, account.name, { reason, ...recovery });
            return false;
        }
        const taskName = `relogin_${String(accountId || '')}`;
        scheduler.clear(taskName);
        const key = String(accountId);
        const attempt = (reloginStreak.get(key) || 0) + 1;
        reloginStreak.set(key, attempt);
        const delayMs = reloginDelayMs(attempt, cfg.intervalMinutes);
        scheduler.setTimeoutTask(taskName, delayMs, () => {
            log('系统', `[自动重登] 定时器触发: ${account.name}`, { accountId: String(accountId), reason });
            refreshAccountCode(accountId, reason);
        });
        const human = delayMs >= 60000 ? `${Math.round(delayMs / 60000)} 分钟` : `${Math.round(delayMs / 1000)} 秒`;
        log('系统', `账号 ${account.name} 将在 ${human}后自动刷新凭证并重登（第 ${attempt} 次）`, {
            accountId: String(accountId), accountName: account.name, reason, attempt, delayMs,
        });
        return true;
    }

    return {
        refreshAccountCode,
        scheduleAccount,
        rescheduleAll,
        stopAccount,
        scheduleRelogin,
        reloginDelayMs,
    };
}

module.exports = {
    createAutoCodeRefreshService,
    reloginDelayMs,
};
