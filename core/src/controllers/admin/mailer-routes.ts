import type { Application, Request, Response } from 'express';
export {};

/**
 * 管理后台 - 全局邮件服务与批量通知（自 qq-farm-bot admin-mailer-routes.js 移植）
 *
 * 1. 管理员配置一套全局 SMTP；
 * 2. 用这套服务给指定用户发通知（可多选，默认跳过已过期用户）。
 */
const featuresStore = require('../../models/user-features-store');
const userStore = require('../../models/user-store');
const { sendSmtpEmail } = require('../../services/smtp-mailer');
const { createRequireAdminRole } = require('./middleware');

const MAX_RECIPIENTS_PER_REQUEST = 300;
const SEND_INTERVAL_MS = 300;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeEmail(value: unknown): string {
    const email = String(value || '').trim();
    if (!email) return '';
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function buildMailerView(config: any): any {
    const cfg = config && typeof config === 'object' ? config : {};
    return {
        enabled: cfg.enabled === true,
        smtpHost: cfg.smtpHost || '',
        smtpPort: Number(cfg.smtpPort) || 465,
        smtpUser: cfg.smtpUser || '',
        // 授权码不回传明文，只告诉前端「已设置」
        smtpPass: '',
        hasSmtpPass: !!cfg.smtpPass,
        senderName: cfg.senderName || '',
        subject: cfg.subject || '',
        content: cfg.content || '',
        ready: cfg.ready === true,
    };
}

function mountAdminMailerRoutes(app: Application, ctx: any): void {
    const adminOnly = createRequireAdminRole(ctx);

    // 读取全局邮件配置
    app.get('/api/admin/mailer', adminOnly, (_req: Request, res: Response) => {
        try {
            const config = featuresStore.getGlobalMailer();
            res.json({ ok: true, data: buildMailerView(config) });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message || '读取全局邮件设置失败' });
        }
    });

    // 保存全局邮件配置（smtpPass 留空表示不修改）
    app.post('/api/admin/mailer', adminOnly, (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {} as any;
            const patch: any = {
                enabled: body.enabled === true,
                smtpHost: body.smtpHost,
                smtpPort: body.smtpPort,
                smtpUser: body.smtpUser,
                senderName: body.senderName,
                subject: body.subject,
                content: body.content,
            };
            if (body.smtpPass !== undefined) patch.smtpPass = body.smtpPass;
            const saved = featuresStore.setGlobalMailer(patch);
            res.json({ ok: true, data: buildMailerView(saved) });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message || '保存全局邮件设置失败' });
        }
    });

    // 用全局邮件服务发一封测试邮件
    app.post('/api/admin/mailer/test', adminOnly, async (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {} as any;
            const recipientEmail = normalizeEmail(body.recipientEmail);
            if (!recipientEmail) {
                return res.status(400).json({ ok: false, error: '请填写正确的收件人邮箱' });
            }
            const config = featuresStore.getGlobalMailer();
            if (!config.ready) {
                return res.status(400).json({ ok: false, error: '请先填写并启用完整的 SMTP 配置' });
            }
            const result = await sendSmtpEmail({
                smtpHost: config.smtpHost,
                smtpPort: config.smtpPort,
                smtpUser: config.smtpUser,
                smtpPass: config.smtpPass,
                senderName: config.senderName,
                recipientEmail,
                subject: config.subject ? `${config.subject}（测试）` : '全局邮件服务测试',
                content: '这是一封来自管理后台的测试邮件，收到它说明全局邮件服务配置成功。',
            });
            if (!result || result.ok === false) {
                return res.status(400).json({ ok: false, error: (result && result.msg) || '发送失败' });
            }
            res.json({ ok: true, data: result, message: '测试邮件已发送' });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message || '测试邮件发送失败' });
        }
    });

    // 可选收件人列表：带每个用户的收件邮箱与过期状态
    app.get('/api/admin/mail-recipients', adminOnly, (_req: Request, res: Response) => {
        try {
            const users = userStore.listUsersForAdmin({});
            const data = (Array.isArray(users) ? users : []).map((user: any) => {
                const profileEmail = normalizeEmail(user.email);
                return {
                    username: user.username,
                    role: user.role,
                    nick: user.nick || '',
                    isExpired: user.isExpired === true,
                    expiresAtText: user.expiresAtText || '',
                    email: profileEmail,
                    emailSource: profileEmail ? 'profile' : '',
                };
            });
            res.json({ ok: true, data });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message || '读取收件人列表失败' });
        }
    });

    // 批量发送通知
    app.post('/api/admin/mail/send', adminOnly, async (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {} as any;
            const subject = String(body.subject || '').trim();
            const content = String(body.content || '').trim();
            const includeExpired = body.includeExpired === true;
            if (!subject) return res.status(400).json({ ok: false, error: '请填写邮件主题' });
            if (!content) return res.status(400).json({ ok: false, error: '请填写邮件内容' });

            const config = featuresStore.getGlobalMailer();
            if (!config.ready) {
                return res.status(400).json({ ok: false, error: '请先在「邮件通知」里配置并启用邮件服务' });
            }

            const users = userStore.listUsersForAdmin({});
            const allUsers = Array.isArray(users) ? users : [];

            let targets: any[] = [];
            if (body.all === true) {
                targets = allUsers;
            } else {
                const wanted = new Set(
                    (Array.isArray(body.usernames) ? body.usernames : [])
                        .map((name: any) => String(name || '').trim())
                        .filter(Boolean),
                );
                targets = allUsers.filter((user: any) => wanted.has(user.username));
            }

            if (targets.length === 0) {
                return res.status(400).json({ ok: false, error: '请选择至少一个收件用户' });
            }
            if (targets.length > MAX_RECIPIENTS_PER_REQUEST) {
                return res.status(400).json({
                    ok: false,
                    error: `一次最多发送 ${MAX_RECIPIENTS_PER_REQUEST} 个用户，请分批发送`,
                });
            }

            const results: any[] = [];
            let sent = 0;
            let failed = 0;
            const skipped: any[] = [];

            for (const user of targets) {
                if (user.isExpired === true && !includeExpired) {
                    skipped.push({ username: user.username, reason: '已过期（未勾选包含过期用户）' });
                    continue;
                }
                const email = normalizeEmail(user.email);
                if (!email) {
                    skipped.push({ username: user.username, reason: '未填写收件邮箱' });
                    continue;
                }
                try {
                    const ret = await sendSmtpEmail({
                        smtpHost: config.smtpHost,
                        smtpPort: config.smtpPort,
                        smtpUser: config.smtpUser,
                        smtpPass: config.smtpPass,
                        senderName: config.senderName,
                        recipientEmail: email,
                        subject,
                        content,
                    });
                    if (!ret || ret.ok === false) throw new Error((ret && ret.msg) || '发送失败');
                    sent += 1;
                    results.push({ username: user.username, email, ok: true });
                } catch (error: any) {
                    failed += 1;
                    results.push({ username: user.username, email, ok: false, error: error.message });
                }
                if (SEND_INTERVAL_MS > 0) await sleep(SEND_INTERVAL_MS);
            }

            res.json({
                ok: true,
                data: { sent, failed, skipped, results, total: targets.length },
                message: `发送完成：成功 ${sent}，失败 ${failed}，跳过 ${skipped.length}`,
            });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message || '批量发送失败' });
        }
    });
}

module.exports = { mountAdminMailerRoutes };
