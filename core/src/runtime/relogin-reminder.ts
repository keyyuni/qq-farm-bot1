export {};

interface ReloginReminderOptions {
    store: any;
    sendPushooMessage: (payload: any) => Promise<any>;
    sendSmtpEmail?: (payload: any) => Promise<any>;
    log: (tag: string, msg: string, extra?: any) => void;
}

interface OfflineReminderPayload {
    accountId?: string;
    accountName?: string;
    reason?: string;
    offlineMs?: number;
}

function createReloginReminderService(options: ReloginReminderOptions) {
    const { store, sendPushooMessage, log } = options;
    const sendSmtpEmail = options.sendSmtpEmail || null;

    function getOfflineAutoDeleteMs(): number {
        const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
        const sec = Math.max(0, Number.parseInt(cfg?.offlineDeleteSec, 10) || 0);
        return sec === 0 ? Infinity : sec * 1000;
    }

    function resolvePushChannel(): { ok: true; channel: string; endpoint: string; token: string; secret: string; cfg: any } | { ok: false; reason: string } {
        const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
        if (!cfg) return { ok: false, reason: '未找到下线提醒配置' };

        const channel = String(cfg.channel || '').trim().toLowerCase();
        const endpoint = String(cfg.endpoint || '').trim();
        const token = String(cfg.token || '').trim();
        const secret = String(cfg.secret || '').trim();
        if (!channel) return { ok: false, reason: '下线提醒配置不完整' };
        if (channel === 'smtp') {
            // SMTP 渠道：校验邮件配置完整性
            if (!String(cfg.smtpHost || '').trim()) return { ok: false, reason: 'SMTP 渠道未填写服务器地址' };
            if (!String(cfg.smtpUser || '').trim()) return { ok: false, reason: 'SMTP 渠道未填写邮箱账号' };
            if (!String(cfg.smtpPass || '').trim()) return { ok: false, reason: 'SMTP 渠道未填写授权码' };
            if (!String(cfg.recipientEmail || '').trim()) return { ok: false, reason: 'SMTP 渠道未填写收件人邮箱' };
            return { ok: true, channel, endpoint, token, secret, cfg };
        }
        if (channel === 'webhook' && !endpoint) return { ok: false, reason: 'Webhook 渠道未设置接口地址' };
        if (channel === 'dingtalk' && !endpoint && !token) return { ok: false, reason: '钉钉渠道未设置 Webhook 地址' };
        if (channel !== 'webhook' && channel !== 'dingtalk' && !token) return { ok: false, reason: '下线提醒渠道未设置 Token' };
        return { ok: true, channel, endpoint, token, secret, cfg };
    }

    async function sendConfiguredPush(payload: { title?: string; content?: string; accountId?: string; accountName?: string; reason?: string; offlineMs?: number; logLabel?: string } = {}): Promise<void> {
        const accountId = String(payload.accountId || '').trim();
        const accountName = String(payload.accountName || '').trim();
        const baseTitle = String(payload.title || '').trim();
        const baseContent = String(payload.content || '').trim();
        const logLabel = String(payload.logLabel || '事件提醒').trim() || '事件提醒';
        try {
            const channelCfg = resolvePushChannel();
            if (channelCfg.ok === false) {
                log('错误', channelCfg.reason);
                return;
            }

            if (channelCfg.channel === 'smtp') {
                // SMTP 渠道：邮件主题/正文对齐源项目结构（账号名、原因、离线时长）
                const cfg = channelCfg.cfg || {};
                const emailContent = String(cfg.emailContent || '').trim() || baseContent;
                let content = `${accountName ? `${accountName}\n` : ''}${emailContent}`;
                if (payload.reason) content += `\n原因: ${payload.reason}`;
                const minutes = Math.floor((Number(payload.offlineMs) || 0) / 60000);
                if (minutes > 0) content += `\n离线时长: ${minutes} 分钟`;
                if (!content.trim()) {
                    log('错误', 'SMTP 邮件内容为空');
                    return;
                }
                if (!sendSmtpEmail) {
                    log('错误', 'SMTP 邮件发送组件不可用');
                    return;
                }
                const ret = await sendSmtpEmail({
                    smtpHost: cfg.smtpHost,
                    smtpPort: cfg.smtpPort,
                    smtpUser: cfg.smtpUser,
                    smtpPass: cfg.smtpPass,
                    senderName: cfg.senderName,
                    recipientEmail: cfg.recipientEmail,
                    subject: accountName ? `${baseTitle} ${accountName}` : baseTitle,
                    content,
                });
                if (ret?.ok) {
                    log('系统', `${logLabel}邮件发送成功: ${accountName || accountId || baseTitle}`);
                } else {
                    log('错误', `${logLabel}邮件发送失败: ${ret?.msg || 'unknown'}`);
                }
                return;
            }

            const title = accountName ? `${baseTitle} ${accountName}` : baseTitle;
            const content = baseContent;
            if (!title || !content) {
                log('错误', '推送标题或内容为空');
                return;
            }
            const result = await sendPushooMessage({
                channel: channelCfg.channel,
                endpoint: channelCfg.endpoint,
                token: channelCfg.token,
                secret: channelCfg.secret,
                title,
                content,
            });
            if (result?.ok) {
                log('系统', `${logLabel}发送成功: ${accountName || accountId || title}`);
            } else {
                log('错误', `${logLabel}发送失败: ${result?.msg || 'unknown'}`);
            }
        } catch (e: any) {
            log('错误', `${logLabel}发送异常: ${e.message}`);
        }
    }

    async function triggerOfflineReminder(payload: OfflineReminderPayload = {}): Promise<void> {
        try {
            const accountId = String(payload.accountId || '').trim();
            const accountName = String(payload.accountName || '').trim();
            const reason = String(payload.reason || 'unknown');
            log('系统', `触发下线提醒: 账号=${accountName || accountId}, 原因=${reason}`, { accountId, accountName, reason });

            const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
            if (!cfg) {
                log('错误', '未找到下线提醒配置');
                return;
            }

            const baseTitle = String(cfg.title || '').trim();
            const content = String(cfg.msg || '').trim();
            if (!baseTitle || !content) {
                log('错误', '下线提醒配置不完整');
                return;
            }

            await sendConfiguredPush({
                title: baseTitle,
                content,
                accountId,
                accountName,
                reason,
                offlineMs: Number(payload.offlineMs) || 0,
                logLabel: '下线提醒',
            });
        } catch (e: any) {
            log('错误', `下线提醒发送异常: ${e.message}`);
        }
    }

    return { getOfflineAutoDeleteMs, triggerOfflineReminder, sendConfiguredPush };
}

module.exports = { createReloginReminderService };
