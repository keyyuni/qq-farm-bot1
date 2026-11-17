import type { Application, Request, Response } from 'express';
export {};

/**
 * 系统公告接口（自 qq-farm-bot announcement-routes.js 移植）
 *
 * - GET  /api/announcement        当前登录用户拉取公告（含是否需要弹出）
 * - POST /api/announcement/read   标记已读
 * - GET  /api/admin/announcement  管理员读取公告设置
 * - POST /api/admin/announcement  管理员保存公告内容
 */
const featuresStore = require('../../models/user-features-store');
const { createRequireAdminRole } = require('./middleware');

function mountAnnouncementRoutes(app: Application, ctx: any): void {
    const requireAdminRole = createRequireAdminRole(ctx);
    const authRequired = require('./middleware').createAuthRequired(ctx);

    app.get('/api/announcement', authRequired, (req: any, res: Response) => {
        try {
            const username = String(req.currentUser?.username || '').trim();
            const announcement = featuresStore.getAnnouncement();
            res.json({
                ok: true,
                data: {
                    content: announcement.content,
                    showOnce: announcement.showOnce,
                    updatedAt: announcement.updatedAt,
                    shouldShow: username ? featuresStore.shouldShowAnnouncement(username) : false,
                },
            });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/announcement/read', authRequired, (req: any, res: Response) => {
        try {
            const username = String(req.currentUser?.username || '').trim();
            if (!username) {
                res.status(401).json({ ok: false, error: '未登录' });
                return;
            }
            featuresStore.markAnnouncementRead(username);
            res.json({ ok: true });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.get('/api/admin/announcement', requireAdminRole, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: featuresStore.getAnnouncement() });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/announcement', requireAdminRole, (req: Request, res: Response) => {
        try {
            const body = (req.body || {}) as any;
            const content = String(body.content ?? '').trim();
            const showOnce = body.showOnce !== false;
            res.json({ ok: true, data: featuresStore.setAnnouncement(content, showOnce) });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });
}

module.exports = { mountAnnouncementRoutes };
