import type { Application, Request, Response } from 'express';
export {};

/**
 * 管理员后台 —— 普通用户管理（自 qq-farm-bot admin-user-routes.js 移植）
 */
const userStore = require('../../models/user-store');
const store = require('../../models/store');
const { USER_ROLES, isElevatedRole } = require('../../config/user-system');
const { createRequireAdminRole, requireDangerConfirmation, getAdminUserMutationError } = require('./middleware');

function parseExpiresAt(value: unknown): number | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === '' || value === 0) return null;
    const text = String(value).trim();
    if (/^\d+$/.test(text)) return Number(text);
    const normalized = text.replace(' ', 'T');
    const parsed = Date.parse(normalized.length <= 16 ? `${normalized}:00` : normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function getAccountsForAdmin(ctx: any): any[] {
    try {
        if (ctx.provider && typeof ctx.provider.getAccounts === 'function') {
            const data = ctx.provider.getAccounts();
            if (Array.isArray(data?.accounts)) return data.accounts;
        }
    } catch { /* fallthrough */ }
    const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
    return Array.isArray(data.accounts) ? data.accounts : [];
}

function mountAdminUserRoutes(app: Application, ctx: any, adminLogger: any): void {
    const requireAdminRole = createRequireAdminRole(ctx);

    /** 用户列表（附带农场账号数量） */
    app.get('/api/admin/users', requireAdminRole, (req: Request, res: Response) => {
        try {
            const users = userStore.listUsersForAdmin({
                countAccounts: (username: string) => {
                    const list = getAccountsForAdmin(ctx);
                    return list.filter((account: any) => (account.owner || account.username) === username).length;
                },
            });
            res.json({ ok: true, data: users });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 管理员直接开号 */
    app.post('/api/admin/users', requireAdminRole, (req: Request, res: Response) => {
        try {
            const {
                username, password, role, accountLimit, expiresAt, isPermanent,
                nick, email, phone, remark,
            } = (req.body || {}) as any;
            if (!username || !password) {
                return res.status(400).json({ ok: false, error: '请提供用户名和密码' });
            }
            if (role === USER_ROLES.SUPER_ADMIN && (req as any).currentUser?.role !== USER_ROLES.SUPER_ADMIN) {
                return res.status(403).json({ ok: false, error: '只有超级管理员可以创建超级管理员账号' });
            }
            const result = userStore.createUserByAdmin({
                username,
                password,
                role,
                accountLimit,
                expiresAt: parseExpiresAt(expiresAt),
                isPermanent: isPermanent === true,
                nick,
                email,
                phone,
                remark,
                operator: (req as any).currentUser?.username || '',
            });
            if (!result.ok) return res.status(400).json(result);
            adminLogger.info('管理员开号', {
                admin: (req as any).currentUser?.username || '',
                username: result.user.username,
                role: result.user.role,
            });
            res.json({ ok: true, data: result.user });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 编辑用户资料 */
    app.post('/api/admin/users/:username/edit', requireAdminRole, (req: Request, res: Response) => {
        try {
            const { username } = req.params;
            const mutationError = getAdminUserMutationError((req as any).currentUser, username);
            if (mutationError) return res.status(403).json({ ok: false, error: mutationError });

            const {
                newUsername, password, role, accountLimit, expiresAt, isPermanent,
                enabled, nick, email, phone, remark,
            } = (req.body || {}) as any;

            const targetUser = userStore.getUserByName(username);
            if (!targetUser) return res.status(404).json({ ok: false, error: '用户不存在' });

            // 角色校验：只在「角色真的发生变化」时才限制
            let nextRole;
            if (role !== undefined && role !== null && role !== '') {
                nextRole = role;
                const currentRole = targetUser.role || USER_ROLES.USER;
                if (role !== currentRole) {
                    const isSelf = String((req as any).currentUser?.username || '').trim() === String(username).trim();
                    if (isSelf) {
                        return res.status(400).json({ ok: false, error: '不能修改自己的角色，以免把自己锁在门外' });
                    }
                    if (role === USER_ROLES.SUPER_ADMIN && (req as any).currentUser?.role !== USER_ROLES.SUPER_ADMIN) {
                        return res.status(403).json({ ok: false, error: '只有超级管理员可以授予超级管理员角色' });
                    }
                    if (isElevatedRole(currentRole) && (req as any).currentUser?.role !== USER_ROLES.SUPER_ADMIN) {
                        return res.status(403).json({ ok: false, error: '只有超级管理员可以调整其他管理员的角色' });
                    }
                }
            }

            const result = userStore.editUser(username, {
                newUsername,
                password,
                role: nextRole,
                accountLimit,
                expiresAt: parseExpiresAt(expiresAt),
                isPermanent: isPermanent === true,
                enabled,
                nick,
                email,
                phone,
                remark,
            });
            if (!result.ok) return res.status(400).json(result);

            adminLogger.warn('编辑用户', {
                admin: (req as any).currentUser?.username || '',
                username,
                newUsername: result.user?.username || username,
                changedPassword: !!String(password || '').trim(),
                accountLimit: result.user?.accountLimit ?? null,
                isPermanent: isPermanent === true,
                expiresAt: result.user?.subscription?.expiresAt ?? null,
            });

            // 同步活动会话
            for (const [token, session] of ctx.sessions.entries()) {
                if (session.username === String(username)) {
                    session.username = result.user.username;
                    session.subscription = result.user.subscription;
                    session.card = result.user.subscription;
                    session.accountLimit = result.user.accountLimit;
                    session.role = result.user.role;
                    ctx.sessions.set(token, session);
                }
            }
            res.json({ ok: true, data: result.user });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 清理已过期的普通用户（注意：必须注册在 /:username 之前） */
    app.post('/api/admin/users/clear-expired', requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req as any, res, 'CLEAR_EXPIRED_USERS')) return;
            const result = userStore.clearExpiredUsers();
            if (result.ok && result.deletedCount > 0) {
                for (const username of result.deletedUsers) {
                    for (const [token, session] of ctx.sessions.entries()) {
                        if (session.username === String(username)) {
                            ctx.tokens.delete(token);
                            ctx.sessions.delete(token);
                        }
                    }
                }
                adminLogger.info('清理到期用户', {
                    admin: (req as any).currentUser?.username || '',
                    deletedCount: result.deletedCount,
                    deletedUsers: result.deletedUsers,
                });
            }
            res.json({ ok: true, data: result });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 启停 / 改有效期（危险操作） */
    app.post('/api/admin/users/:username', requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req as any, res, 'UPDATE_USER_STATUS')) return;
            const { username } = req.params;
            const mutationError = getAdminUserMutationError((req as any).currentUser, username);
            if (mutationError) return res.status(403).json({ ok: false, error: mutationError });

            const { enabled, expiresAt, isPermanent } = (req.body || {}) as any;
            const updates: any = {};
            if (enabled !== undefined) updates.enabled = enabled !== false;
            if (isPermanent === true) updates.isPermanent = true;
            if (updates.isPermanent !== true) {
                const parsed = parseExpiresAt(expiresAt);
                if (parsed !== undefined) updates.expiresAt = parsed;
            }

            const result = userStore.updateUser(String(username), updates);
            if (!result.ok) return res.status(404).json(result);

            adminLogger.warn('更新用户状态', {
                admin: (req as any).currentUser?.username || '',
                username,
                enabled: result.user?.subscription?.enabled ?? null,
                expiresAt: result.user?.subscription?.expiresAt ?? null,
                confirmation: 'UPDATE_USER_STATUS',
            });
            for (const [token, session] of ctx.sessions.entries()) {
                if (session.username === String(username)) {
                    session.subscription = result.user.subscription;
                    session.card = result.user.subscription;
                    ctx.sessions.set(token, session);
                }
            }
            res.json({ ok: true, data: result.user });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 代用户核销卡密 */
    app.post('/api/admin/users/:username/renew', requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req as any, res, 'RENEW_USER')) return;
            const { username } = req.params;
            const { cardCode } = (req.body || {}) as any;
            if (!cardCode) return res.status(400).json({ ok: false, error: '请提供卡密' });

            const result = userStore.redeemCard(username, cardCode, {
                operator: (req as any).currentUser?.username || 'admin',
            });
            if (!result.ok) return res.status(400).json(result);

            for (const [token, session] of ctx.sessions.entries()) {
                if (session.username === String(username)) {
                    session.subscription = result.subscription;
                    session.card = result.subscription;
                    session.accountLimit = result.accountLimit;
                    ctx.sessions.set(token, session);
                }
            }
            adminLogger.warn('管理员代续费', {
                admin: (req as any).currentUser?.username || '',
                username,
                cardCode,
                cardType: result.cardType || null,
                summary: result.summary || '',
                confirmation: 'RENEW_USER',
            });
            res.json({
                ok: true,
                data: {
                    subscription: result.subscription,
                    accountLimit: result.accountLimit,
                    cardType: result.cardType,
                    summary: result.summary,
                },
            });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 查看用户名下农场账号及其自动化配置 */
    app.get('/api/admin/users/:username/accounts', requireAdminRole, (req: Request, res: Response) => {
        try {
            const { username } = req.params;
            const withConfig = (req.query as any)?.withConfig === '1' || (req.query as any)?.withConfig === 'true';
            const all = getAccountsForAdmin(ctx);
            const accounts = all
                .filter((account: any) => (account.owner || account.username) === username)
                .map((account: any) => {
                    const base: any = {
                        id: account.id,
                        name: account.name || '',
                        platform: account.platform || '',
                        uin: account.uin || account.qq || '',
                        nick: account.nick || '',
                        createdAt: account.createdAt || null,
                        updatedAt: account.updatedAt || null,
                    };
                    if (!withConfig || !store || typeof store.getConfigSnapshot !== 'function') return base;
                    try {
                        const config = store.getConfigSnapshot(account.id) || {};
                        return {
                            ...base,
                            config: {
                                automation: config.automation || {},
                                intervals: config.intervals || {},
                                plantingStrategy: config.plantingStrategy || '',
                                friendQuietHours: config.friendQuietHours || null,
                                plantBlacklist: config.plantBlacklist || [],
                            },
                        };
                    } catch {
                        return base;
                    }
                });
            res.json({
                ok: true,
                data: { username, accounts, total: accounts.length },
            });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 删除用户 */
    app.delete('/api/admin/users/:username', requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req as any, res, 'DELETE_USER')) return;
            const { username } = req.params;
            const currentUser = (req as any).currentUser;
            if (currentUser && currentUser.username === username) {
                return res.status(400).json({ ok: false, error: '不能删除自己的账号' });
            }
            const mutationError = getAdminUserMutationError(currentUser, username);
            if (mutationError) return res.status(403).json({ ok: false, error: mutationError });

            const force = (req.body as any)?.force === true || (req.query as any)?.force === 'true';
            const result = userStore.deleteUser(String(username), { force });
            if (!result.ok) return res.status(400).json(result);

            adminLogger.warn('删除用户', {
                admin: currentUser?.username || '',
                username,
                confirmation: 'DELETE_USER',
            });
            for (const [token, session] of ctx.sessions.entries()) {
                if (session.username === String(username)) {
                    ctx.tokens.delete(token);
                    ctx.sessions.delete(token);
                    if (ctx.io) {
                        for (const socket of ctx.io.sockets.sockets.values()) {
                            if (String((socket.data as any).adminToken || '') === String(token)) socket.disconnect(true);
                        }
                    }
                }
            }
            res.json({ ok: true, data: result });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 用户统计概览 */
    app.get('/api/admin/users/stats', requireAdminRole, (_req: Request, res: Response) => {
        try {
            const users = userStore.getAllUsers();
            const nowTs = Date.now();
            const stats = {
                total: users.length,
                admin: 0,
                active: 0,
                expired: 0,
                disabled: 0,
                permanent: 0,
            };
            for (const user of users) {
                if (user.role !== USER_ROLES.USER) {
                    stats.admin += 1;
                    continue;
                }
                if (user.subscription?.enabled === false) {
                    stats.disabled += 1;
                    continue;
                }
                if (user.subscription?.isPermanent === true) {
                    stats.permanent += 1;
                    stats.active += 1;
                    continue;
                }
                const expiresAt = Number(user.subscription?.expiresAt || 0);
                if (expiresAt > 0 && expiresAt <= nowTs) stats.expired += 1;
                else stats.active += 1;
            }
            res.json({ ok: true, data: stats });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });
}

module.exports = { mountAdminUserRoutes };
