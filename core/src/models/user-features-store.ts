export {};

/**
 * 用户体系附属配置存储（自 qq-farm-bot store.js 移植）：
 *   - 系统公告（含每用户已读记录）
 *   - 全局邮件服务（SMTP）
 * 独立 JSON 文件落盘，与上游 store 解耦。
 */
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');

const ANNOUNCEMENT_FILE: string = getDataFile('announcement.json');
const MAILER_FILE: string = getDataFile('global-mailer.json');

// ==================== 系统公告 ====================

interface AnnouncementDoc {
    content: string;
    showOnce: boolean;
    updatedAt: number;
    readRecords: Record<string, number>;
}

function loadAnnouncement(): AnnouncementDoc {
    const doc = readJsonFile(ANNOUNCEMENT_FILE, () => null);
    const source = doc && typeof doc === 'object' ? doc : {};
    return {
        content: String(source.content || ''),
        showOnce: source.showOnce !== false,
        updatedAt: Number(source.updatedAt) || 0,
        readRecords: source.readRecords && typeof source.readRecords === 'object' ? source.readRecords : {},
    };
}

function getAnnouncement(): any {
    const { content, showOnce, updatedAt } = loadAnnouncement();
    return { content, showOnce, updatedAt };
}

function setAnnouncement(content: unknown, showOnce = true): any {
    const doc = loadAnnouncement();
    const next: AnnouncementDoc = {
        content: String(content || '').trim(),
        showOnce: !!showOnce,
        updatedAt: Date.now(),
        readRecords: doc.readRecords,
    };
    ensureDataDir();
    writeJsonFileAtomic(ANNOUNCEMENT_FILE, next);
    return { content: next.content, showOnce: next.showOnce, updatedAt: next.updatedAt };
}

function markAnnouncementRead(username: unknown): void {
    const name = String(username || '').trim();
    if (!name) return;
    const doc = loadAnnouncement();
    doc.readRecords[name] = Date.now();
    ensureDataDir();
    writeJsonFileAtomic(ANNOUNCEMENT_FILE, doc);
}

function shouldShowAnnouncement(username: unknown): boolean {
    const doc = loadAnnouncement();
    if (!doc.content) return false;
    const name = String(username || '').trim();
    if (!name) return false;
    if (!doc.showOnce) return true;
    return (doc.readRecords[name] || 0) < doc.updatedAt;
}

// ==================== 全局邮件服务 ====================

interface MailerConfig {
    enabled: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPass: string;
    senderName: string;
    subject: string;
    content: string;
}

function normalizeGlobalMailer(raw: any): MailerConfig {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const port = Number(cfg.smtpPort);
    return {
        enabled: cfg.enabled === true,
        smtpHost: String(cfg.smtpHost || '').trim(),
        smtpPort: Number.isFinite(port) && port > 0 ? port : 465,
        smtpUser: String(cfg.smtpUser || '').trim(),
        smtpPass: String(cfg.smtpPass || ''),
        senderName: String(cfg.senderName || '').trim(),
        subject: String(cfg.subject || '').trim(),
        content: String(cfg.content || ''),
    };
}

function isGlobalMailerReady(cfg: MailerConfig): boolean {
    return cfg.enabled === true
        && !!cfg.smtpHost
        && !!cfg.smtpUser
        && !!cfg.smtpPass
        && Number(cfg.smtpPort) > 0;
}

function loadMailer(): MailerConfig {
    return normalizeGlobalMailer(readJsonFile(MAILER_FILE, () => null));
}

function getGlobalMailer(): any {
    const cfg = loadMailer();
    return { ...cfg, ready: isGlobalMailerReady(cfg) };
}

function setGlobalMailer(patch: any = {}): any {
    const current = loadMailer();
    const merged = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
    // 授权码留空表示「不修改」，避免前端拿到打码值后回写覆盖
    if (patch && typeof patch === 'object'
        && (patch.smtpPass === undefined || patch.smtpPass === null || patch.smtpPass === '')) {
        merged.smtpPass = current.smtpPass;
    }
    const next = normalizeGlobalMailer(merged);
    ensureDataDir();
    writeJsonFileAtomic(MAILER_FILE, next);
    return getGlobalMailer();
}

module.exports = {
    getAnnouncement,
    setAnnouncement,
    markAnnouncementRead,
    shouldShowAnnouncement,
    getGlobalMailer,
    setGlobalMailer,
};
