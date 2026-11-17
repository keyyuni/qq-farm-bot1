export {};

/**
 * 全局邮件服务 SMTP 发送（自 qq-farm-bot push.js 的 sendSmtpEmail 移植）
 */
const nodemailer = require('nodemailer');

interface SmtpEmailOptions {
    smtpHost?: string;
    smtpPort?: number | string;
    smtpUser?: string;
    smtpPass?: string;
    senderName?: string;
    recipientEmail?: string;
    subject?: string;
    content?: string;
}

async function sendSmtpEmail(options: SmtpEmailOptions = {}): Promise<any> {
    const smtpHost = String(options.smtpHost || '').trim();
    const smtpPort = Number(options.smtpPort) || 465;
    const smtpUser = String(options.smtpUser || '').trim();
    const smtpPass = String(options.smtpPass || '').trim();
    const senderName = String(options.senderName || '').trim();
    const recipientEmail = String(options.recipientEmail || '').trim();
    const subject = String(options.subject || '下线提醒').trim();
    const content = String(options.content || '').trim();

    if (!smtpHost) throw new Error('SMTP服务器地址不能为空');
    if (!smtpUser) throw new Error('邮箱账号不能为空');
    if (!smtpPass) throw new Error('授权码不能为空');
    if (!recipientEmail) throw new Error('收件人邮箱不能为空');
    if (!content) throw new Error('邮件内容不能为空');

    const from = senderName ? `"${senderName}" <${smtpUser}>` : smtpUser;

    const transport = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465, // 465 端口使用 SSL
        auth: {
            user: smtpUser,
            pass: smtpPass,
        },
    });

    const raw = await transport.sendMail({
        from,
        to: recipientEmail,
        subject,
        text: content,
    });
    return {
        ok: true,
        messageId: raw && raw.messageId,
        response: raw && raw.response,
        msg: '发送成功',
    };
}

module.exports = { sendSmtpEmail };
