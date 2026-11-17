import type { Application, Request, Response } from 'express';
export {};

/**
 * 管理后台 —— 邀请奖励路由（自 qq-farm-bot admin-invite-routes.js 移植）
 * 用户侧 /api/user/invite 挂在 auth-routes；此处为管理侧概览与设置。
 */
const invite = require('../../services/invite-rewards');
const { createRequireAdminRole } = require('./middleware');

function mountAdminInviteRoutes(app: Application, ctx: any): void {
    const requireAdminRole = createRequireAdminRole(ctx);

    /** 管理后台概览 */
    app.get('/api/admin/invite/overview', requireAdminRole, (req: Request, res: Response) => {
        try {
            const limit = Number.parseInt((req.query as any).limit, 10) || 100;
            return res.json({ ok: true, data: invite.getAdminOverview({ limit }) });
        } catch (error: any) {
            return res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 管理后台保存开关与规则 */
    app.post('/api/admin/invite/settings', requireAdminRole, (req: Request, res: Response) => {
        try {
            const settings = invite.saveSettings((req.body || {}) as any);
            return res.json({ ok: true, data: { settings } });
        } catch (error: any) {
            return res.status(500).json({ ok: false, error: error.message });
        }
    });
}

module.exports = { mountAdminInviteRoutes };
