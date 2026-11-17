import type { Application, Request, Response } from 'express';
export {};

/**
 * 管理员后台 —— 登录审计日志（自 qq-farm-bot admin-login-log-routes.js 移植）
 */
const userStore = require('../../models/user-store');
const { createRequireAdminRole, requireDangerConfirmation } = require('./middleware');

function mountAdminLoginLogRoutes(app: Application, ctx: any, adminLogger: any): void {
    const requireAdminRole = createRequireAdminRole(ctx);

    app.get('/api/admin/login-logs', requireAdminRole, (req: Request, res: Response) => {
        try {
            const { limit, offset, username, event } = (req.query || {}) as any;
            const result = userStore.getLoginLogs({
                limit: Number.parseInt(limit) || 100,
                offset: Number.parseInt(offset) || 0,
                username: username || '',
                event: event || '',
            });
            res.json({ ok: true, data: result });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.delete('/api/admin/login-logs', requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req as any, res, 'CLEAR_LOGIN_LOGS')) return;
            const result = userStore.clearLoginLogs();
            adminLogger.warn('清空登录日志', {
                admin: (req as any).currentUser?.username || '',
                confirmation: 'CLEAR_LOGIN_LOGS',
            });
            res.json({ ok: true, data: result });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });
}

module.exports = { mountAdminLoginLogRoutes };
