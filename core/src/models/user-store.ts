export {};

/**
 * 多用户账号与卡密体系 —— 数据层（自 qq-farm-bot 的 user-store.js 移植）
 *
 * 数据文件（均落在 data/ 目录）：
 *   users.json            用户表
 *   cards.json            卡密表
 *   card-redemptions.json 卡密核销流水
 *   login-attempts.json   登录失败计数（限流/锁定）
 *   login-logs.json       登录审计日志
 *
 * 设计要点：
 *   1. 密码使用 PBKDF2-SHA512(salt, 100000 iter, 64B) 存储，永不明文落盘。
 *   2. 用户有效期 = subscription.expiresAt（时间戳）；null 表示永久。
 *   3. 卡密一经核销即写入 usedBy/usedAt 并生成核销流水，不可重复使用。
 */
const crypto = require('node:crypto');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');
const {
    USER_SYSTEM_CONFIG,
    USER_ROLES,
    CARD_TYPES,
    CARD_STATUS,
    isElevatedRole,
    MINUTE_MS,
    HOUR_MS,
    DAY_MS,
} = require('../config/user-system');

const USERS_FILE: string = getDataFile('users.json');
const CARDS_FILE: string = getDataFile('cards.json');
const REDEMPTIONS_FILE: string = getDataFile('card-redemptions.json');
const LOGIN_ATTEMPTS_FILE: string = getDataFile('login-attempts.json');
const LOGIN_LOGS_FILE: string = getDataFile('login-logs.json');

const DEFAULT_ACCOUNT_LIMIT = USER_SYSTEM_CONFIG.defaultAccountLimit;
const ADMIN_ACCOUNT_LIMIT = USER_SYSTEM_CONFIG.adminAccountLimit;
const UNLIMITED = -1;

const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEY_LENGTH = 64;
const PBKDF2_DIGEST = 'sha512';

/** 卡密字母表：剔除易混淆的 0/O/1/I */
const CARD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USERNAME_RE = /^\w{3,32}$/;
const WEAK_PASSWORDS = new Set([
    'password', '123456', '12345678', 'qwerty', 'abc123',
    '111111', '000000', 'admin', 'admin123', 'iloveyou',
]);

// ==================== 小工具 ====================

function now(): number {
    return Date.now();
}

function toInt(value: any, fallback = 0): number {
    const num = Number.parseInt(value, 10);
    return Number.isFinite(num) ? num : fallback;
}

function toPositiveInt(value: any, fallback = 1): number {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallback;
    return Math.floor(num);
}

function createId(prefix = ''): string {
    return `${prefix}${now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

// ==================== 密码 ====================

function hashPassword(password: string, salt: string | null = null): string {
    const useSalt = salt || crypto.randomBytes(SALT_LENGTH).toString('hex');
    const hash = crypto
        .pbkdf2Sync(String(password), useSalt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST)
        .toString('hex');
    return `${useSalt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
    if (!stored) return false;
    const text = String(stored);
    if (text.includes(':')) {
        const [salt, hash] = text.split(':');
        const computed = crypto
            .pbkdf2Sync(String(password), salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST)
            .toString('hex');
        return computed === hash;
    }
    // 兼容早期 sha256 明文哈希，登录成功后会自动升级
    return crypto.createHash('sha256').update(String(password)).digest('hex') === text;
}

function needsRehash(stored: string): boolean {
    return !String(stored || '').includes(':');
}

function validatePasswordStrength(password: string): { valid: boolean, errors: string[] } {
    const errors: string[] = [];
    const text = String(password || '');
    if (text.length < 6) errors.push('密码长度至少 6 位');
    if (text.length > 128) errors.push('密码长度不能超过 128 位');
    if (/\s/.test(text)) errors.push('密码不能包含空格');

    let complexity = 0;
    if (/[a-z]/.test(text)) complexity += 1;
    if (/[A-Z]/.test(text)) complexity += 1;
    if (/\d/.test(text)) complexity += 1;
    if (/[^A-Z0-9]/i.test(text)) complexity += 1;
    if (complexity < 2) errors.push('密码需包含大写字母、小写字母、数字、特殊符号中的至少两种');
    if (WEAK_PASSWORDS.has(text.toLowerCase())) errors.push('密码过于简单，请更换');

    return { valid: errors.length === 0, errors };
}

// ==================== 时长归一化 ====================

function normalizeDuration(input: any = {}): any {
    const raw = input && typeof input === 'object' ? input : {};
    const isPermanent = raw.isPermanent === true
        || raw.durationUnit === 'permanent'
        || Number(raw.durationValue) === -1
        || Number(raw.days) === -1;

    if (isPermanent) {
        return { isPermanent: true, durationValue: -1, durationUnit: 'day', durationMs: null, days: -1 };
    }

    // 单位换算：周/月/年按固定毫秒折算（月=30天、年=365天），供顺延计算使用
    const UNIT_MS: Record<string, number> = {
        hour: HOUR_MS,
        day: DAY_MS,
        week: 7 * DAY_MS,
        month: 30 * DAY_MS,
        year: 365 * DAY_MS,
    };
    const durationMs = Number(raw.durationMs);
    if (Number.isFinite(durationMs) && durationMs > 0) {
        const unit = UNIT_MS[raw.durationUnit] ? raw.durationUnit : 'day';
        const divisor = UNIT_MS[unit];
        return {
            isPermanent: false,
            durationMs,
            durationUnit: unit,
            durationValue: durationMs / divisor,
            days: durationMs / DAY_MS,
        };
    }

    const unit = UNIT_MS[raw.durationUnit] ? raw.durationUnit : 'day';
    const rawValue = raw.durationValue !== undefined ? raw.durationValue : raw.days;
    const value = toPositiveInt(rawValue, 1);
    const ms = value * UNIT_MS[unit];
    return {
        isPermanent: false,
        durationMs: ms,
        durationUnit: unit,
        durationValue: value,
        days: ms / DAY_MS,
    };
}

/** 格式化时长展示，例如 "3天" / "12小时" / "永久" */
function formatDuration(duration: any): string {
    if (!duration) return '未激活';
    if (duration.isPermanent) return '永久';
    const ms = Number(duration.durationMs) || 0;
    if (ms <= 0) return '未激活';
    const totalHours = Math.round(ms / HOUR_MS);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    if (days > 0 && hours > 0) return `${days}天${hours}小时`;
    if (days > 0) return `${days}天`;
    if (hours > 0) return `${hours}小时`;
    return `${Math.round(ms / MINUTE_MS)}分钟`;
}

// ==================== 有效期计算 ====================

function computeNextExpiry(currentSubscription: any, duration: any, timestamp = now()): any {
    const current = currentSubscription && typeof currentSubscription === 'object' ? currentSubscription : {};
    if (duration.isPermanent || current.isPermanent === true) {
        return { expiresAt: null, isPermanent: true };
    }
    const previous = Number(current.expiresAt);
    const anchor = Number.isFinite(previous) && previous > timestamp ? previous : timestamp;
    return { expiresAt: anchor + duration.durationMs, isPermanent: false };
}

/** 判断订阅是否已过期（永久/无有效期视为有效） */
function isSubscriptionExpired(subscription: any, timestamp = now()): boolean {
    if (!subscription) return false;
    if (subscription.isPermanent === true) return false;
    const expiresAt = Number(subscription.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
    return expiresAt <= timestamp;
}

/** 剩余有效毫秒数，永久返回 null */
function getRemainingMs(subscription: any, timestamp = now()): number | null {
    if (!subscription) return 0;
    if (subscription.isPermanent === true) return null;
    const expiresAt = Number(subscription.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return 0;
    return Math.max(0, expiresAt - timestamp);
}

// ==================== 持久化 ====================

const emptyUsersDoc = () => ({ users: [], version: 1 });
const emptyCardsDoc = () => ({ cards: [], version: 1 });
const emptyRedemptionsDoc = () => ({ redemptions: [], counter: 0, version: 1 });
const emptyLogsDoc = () => ({ logs: [], counter: 0, version: 1 });

function loadDoc(file: string, emptyFactory: () => any): any {
    ensureDataDir();
    const doc = readJsonFile(file, emptyFactory);
    return doc && typeof doc === 'object' ? doc : emptyFactory();
}

function saveDoc(file: string, doc: any): void {
    ensureDataDir();
    writeJsonFileAtomic(file, doc);
}

function loadUsers(): any[] {
    const doc = loadDoc(USERS_FILE, emptyUsersDoc);
    return Array.isArray(doc.users) ? doc.users : [];
}

function saveUsers(users: any[]): void {
    saveDoc(USERS_FILE, { users, version: 1 });
}

function loadCards(): any[] {
    const doc = loadDoc(CARDS_FILE, emptyCardsDoc);
    return Array.isArray(doc.cards) ? doc.cards : [];
}

function saveCards(cards: any[]): void {
    saveDoc(CARDS_FILE, { cards, version: 1 });
}

function loadRedemptions(): any {
    const doc = loadDoc(REDEMPTIONS_FILE, emptyRedemptionsDoc);
    return {
        redemptions: Array.isArray(doc.redemptions) ? doc.redemptions : [],
        counter: toInt(doc.counter, 0),
    };
}

function saveRedemptions(state: any): void {
    saveDoc(REDEMPTIONS_FILE, { redemptions: state.redemptions, counter: state.counter, version: 1 });
}

// ==================== 用户对象标准化 ====================

function normalizeSubscription(raw: any, fallbackUsername = ''): any {
    const input = raw && typeof raw === 'object' ? raw : {};
    const isPermanent = input.isPermanent === true;
    const expiresAtRaw = Number(input.expiresAt);
    return {
        code: String(input.code || ''),
        description: String(input.description || ''),
        expiresAt: isPermanent || !Number.isFinite(expiresAtRaw) || expiresAtRaw <= 0 ? null : expiresAtRaw,
        isPermanent,
        enabled: input.enabled !== false,
        source: String(input.source || ''),
        activatedAt: Number(input.activatedAt) || null,
        totalAddedMs: Number(input.totalAddedMs) || 0,
        updatedAt: Number(input.updatedAt) || null,
        owner: String(input.owner || fallbackUsername || ''),
    };
}

function normalizeUser(raw: any): any {
    const input = raw && typeof raw === 'object' ? raw : {};
    // 旧的单管理员数据（role: 'admin'）自动迁移为超级管理员
    const role = input.role === 'admin'
        ? USER_ROLES.SUPER_ADMIN
        : [USER_ROLES.USER, USER_ROLES.SUPER_ADMIN].includes(input.role)
            ? input.role
            : USER_ROLES.USER;
    const accountLimitRaw = toInt(input.accountLimit, Number.NaN);
    let accountLimit = Number.isFinite(accountLimitRaw) ? accountLimitRaw : DEFAULT_ACCOUNT_LIMIT;
    if (isElevatedRole(role)) accountLimit = UNLIMITED;
    return {
        id: String(input.id || createId('u_')),
        username: String(input.username || '').trim(),
        password: String(input.password || ''),
        role,
        nick: String(input.nick || ''),
        email: String(input.email || ''),
        phone: String(input.phone || ''),
        accountLimit,
        subscription: normalizeSubscription(input.subscription || input.card, input.username),
        remark: String(input.remark || ''),
        mustChangePassword: input.mustChangePassword === true,
        createdAt: Number(input.createdAt) || now(),
        updatedAt: Number(input.updatedAt) || Number(input.createdAt) || now(),
        createdBy: String(input.createdBy || ''),
        lastLoginAt: Number(input.lastLoginAt) || null,
        lastLoginIp: String(input.lastLoginIp || ''),
    };
}

/** 对外输出的用户信息（不含密码），同时提供 card 别名以兼容旧调用方 */
function toPublicUser(user: any, extra: any = {}): any {
    if (!user) return null;
    const subscription = normalizeSubscription(user.subscription, user.username);
    const isExpired = isSubscriptionExpired(subscription);
    const remainingMs = getRemainingMs(subscription);
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        nick: user.nick || '',
        email: user.email || '',
        phone: user.phone || '',
        remark: user.remark || '',
        accountLimit: user.accountLimit,
        subscription,
        card: subscription,
        isExpired,
        remainingMs,
        remainingText: formatRemaining(remainingMs),
        expiresAtText: formatExpiresAt(subscription),
        mustChangePassword: user.mustChangePassword === true,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        createdBy: user.createdBy || '',
        lastLoginAt: user.lastLoginAt || null,
        lastLoginIp: user.lastLoginIp || '',
        ...extra,
    };
}

function formatRemaining(remainingMs: number | null): string {
    if (remainingMs === null) return '永久有效';
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '已过期';
    return formatDuration({ isPermanent: false, durationMs: remainingMs });
}

function formatExpiresAt(subscription: any): string {
    if (!subscription) return '未激活';
    if (subscription.isPermanent) return '永久有效';
    if (!subscription.expiresAt) return '未激活';
    return new Date(subscription.expiresAt).toLocaleString('zh-CN', { hour12: false });
}

function findUserRecord(users: any[], username: unknown): any | null {
    const target = String(username || '').trim();
    if (!target) return null;
    return users.find(item => item.username === target) || null;
}

// ==================== 卡密表 ====================

function generateCardCode(): string {
    const groups = Math.max(1, USER_SYSTEM_CONFIG.cardCodeGroups);
    const size = Math.max(3, USER_SYSTEM_CONFIG.cardCodeGroupLength);
    const out: string[] = [];
    for (let g = 0; g < groups; g += 1) {
        let chunk = '';
        const bytes = crypto.randomBytes(size);
        for (let i = 0; i < size; i += 1) {
            chunk += CARD_ALPHABET[bytes[i] % CARD_ALPHABET.length];
        }
        out.push(chunk);
    }
    return out.join('-');
}

function normalizeCard(raw: any): any {
    const input = raw && typeof raw === 'object' ? raw : {};
    const type = input.type === CARD_TYPES.QUOTA ? CARD_TYPES.QUOTA : CARD_TYPES.TIME;
    const usedBy = String(input.usedBy || '').trim();
    const revoked = input.revoked === true || input.status === CARD_STATUS.REVOKED;
    const enabled = revoked ? false : input.enabled !== false;
    const status = revoked
        ? CARD_STATUS.REVOKED
        : (usedBy ? CARD_STATUS.USED : (enabled ? CARD_STATUS.UNUSED : CARD_STATUS.DISABLED));

    const card: any = {
        code: String(input.code || generateCardCode()).toUpperCase(),
        type,
        description: String(input.description || ''),
        enabled,
        revoked,
        status,
        usedBy: usedBy || null,
        usedAt: Number(input.usedAt) || null,
        batchId: String(input.batchId || ''),
        createdAt: Number(input.createdAt) || now(),
        createdBy: String(input.createdBy || ''),
        updatedAt: Number(input.updatedAt) || null,
        revokedAt: Number(input.revokedAt) || null,
    };

    if (type === CARD_TYPES.QUOTA) {
        card.value = toPositiveInt(input.value ?? input.days, 1);
        card.days = card.value;
        card.durationValue = card.value;
        card.durationUnit = 'unit';
        card.durationMs = null;
        card.isPermanent = false;
    } else {
        const duration = normalizeDuration(input);
        card.durationValue = duration.durationValue;
        card.durationUnit = duration.durationUnit;
        card.durationMs = duration.durationMs;
        card.days = duration.days;
        card.isPermanent = duration.isPermanent;
        card.value = duration.isPermanent ? -1 : duration.durationValue;
    }
    card.durationText = type === CARD_TYPES.QUOTA ? `+${card.value} 额度` : formatDuration(card);
    return card;
}

/** 卡密面值展示：时间卡显示时长，额度卡显示配额 */
function describeCardValue(card: any): string {
    if (!card) return '';
    if (card.type === CARD_TYPES.QUOTA) return `+${card.value} 个账号额度`;
    if (card.isPermanent) return '永久';
    return formatDuration(card);
}

// ==================== 核销流水 ====================

function appendRedemption(payload: any): any {
    const state = loadRedemptions();
    state.counter += 1;
    const record = {
        id: String(state.counter),
        at: payload.at || now(),
        code: String(payload.code || ''),
        cardType: String(payload.cardType || CARD_TYPES.TIME),
        username: String(payload.username || ''),
        operator: String(payload.operator || payload.username || ''),
        action: String(payload.action || 'redeem'),
        summary: String(payload.summary || ''),
        before: payload.before || null,
        after: payload.after || null,
    };
    state.redemptions.push(record);
    const limit = toInt(USER_SYSTEM_CONFIG.loginLogLimit, 5000) * 2;
    if (state.redemptions.length > limit) {
        state.redemptions = state.redemptions.slice(-limit);
    }
    saveRedemptions(state);
    return record;
}

function getRedemptions({ username = '', code = '', since = 0, limit = 100, offset = 0 }: any = {}): any {
    const state = loadRedemptions();
    let list = state.redemptions.slice().reverse();
    if (username) list = list.filter((item: any) => item.username === username);
    if (code) list = list.filter((item: any) => item.code === code);
    const sinceTs = toInt(since, 0);
    if (sinceTs > 0) list = list.filter((item: any) => toInt(item.at, 0) >= sinceTs);
    const total = list.length;
    const size = Math.min(Math.max(toInt(limit, 100), 1), 500);
    const start = Math.max(toInt(offset, 0), 0);
    return { redemptions: list.slice(start, start + size), total };
}

/** 清除某用户的全部核销流水（删号/同名重注册时调用） */
function purgeRedemptionsForUser(username: unknown): void {
    const target = String(username || '').trim();
    if (!target) return;
    const state = loadRedemptions();
    const kept = state.redemptions.filter((item: any) => item.username !== target);
    if (kept.length !== state.redemptions.length) {
        state.redemptions = kept;
        saveRedemptions(state);
    }
}

// ==================== 登录限流 ====================

function loadAttempts(): any {
    const doc = loadDoc(LOGIN_ATTEMPTS_FILE, () => ({}));
    return doc && typeof doc === 'object' ? doc : {};
}

function saveAttempts(attempts: any): void {
    saveDoc(LOGIN_ATTEMPTS_FILE, attempts);
}

function cleanExpiredAttempts(attempts: any): boolean {
    const timestamp = now();
    let changed = false;
    for (const key of Object.keys(attempts)) {
        const entry = attempts[key];
        if (!entry || typeof entry !== 'object') {
            delete attempts[key];
            changed = true;
            continue;
        }
        if (entry.lockedUntil && Number(entry.lockedUntil) < timestamp) {
            delete attempts[key];
            changed = true;
            continue;
        }
        if (!entry.lockedUntil
            && Number(entry.windowStart) > 0
            && timestamp - Number(entry.windowStart) > USER_SYSTEM_CONFIG.ipRateLimitWindowMs) {
            delete attempts[key];
            changed = true;
        }
    }
    return changed;
}

function checkRateLimit(ip: string): any {
    const attempts = loadAttempts();
    cleanExpiredAttempts(attempts);
    const key = `ip:${ip}`;
    const timestamp = now();
    const entry = attempts[key];

    if (!entry) {
        attempts[key] = { count: 1, windowStart: timestamp };
        saveAttempts(attempts);
        return { allowed: true };
    }

    if (entry.lockedUntil && Number(entry.lockedUntil) > timestamp) {
        const remainingMs = Number(entry.lockedUntil) - timestamp;
        return {
            allowed: false,
            remainingMs,
            message: `该 IP 登录失败过多，请 ${Math.ceil(remainingMs / 1000)} 秒后重试`,
        };
    }

    if (timestamp - Number(entry.windowStart || 0) > USER_SYSTEM_CONFIG.ipRateLimitWindowMs) {
        attempts[key] = { count: 1, windowStart: timestamp };
        saveAttempts(attempts);
        return { allowed: true };
    }

    if (Number(entry.count) >= USER_SYSTEM_CONFIG.ipMaxAttemptsPerWindow) {
        const lockMs = USER_SYSTEM_CONFIG.ipLockoutMinutes * MINUTE_MS;
        entry.lockedUntil = timestamp + lockMs;
        saveAttempts(attempts);
        return {
            allowed: false,
            remainingMs: lockMs,
            message: `该 IP 登录失败过多，请 ${Math.ceil(lockMs / 1000)} 秒后重试`,
        };
    }

    entry.count = Number(entry.count || 0) + 1;
    saveAttempts(attempts);
    return { allowed: true };
}

function checkAccountLockout(username: string): any {
    const attempts = loadAttempts();
    cleanExpiredAttempts(attempts);
    const key = `user:${username}`;
    const entry = attempts[key];
    const timestamp = now();
    if (entry && entry.lockedUntil && Number(entry.lockedUntil) > timestamp) {
        const remainingMs = Number(entry.lockedUntil) - timestamp;
        return {
            locked: true,
            remainingMs,
            message: `账户已被锁定，请 ${Math.ceil(remainingMs / MINUTE_MS)} 分钟后重试`,
        };
    }
    return { locked: false };
}

function recordFailedAttempt(username: string): any {
    const attempts = loadAttempts();
    const key = `user:${username}`;
    const entry = attempts[key] || { count: 0 };
    entry.count = Number(entry.count || 0) + 1;
    entry.lastAttempt = now();
    attempts[key] = entry;

    if (entry.count >= USER_SYSTEM_CONFIG.maxLoginAttempts) {
        const lockMs = USER_SYSTEM_CONFIG.lockoutMinutes * MINUTE_MS;
        entry.lockedUntil = now() + lockMs;
        saveAttempts(attempts);
        return { locked: true, message: `登录失败次数过多，账户已锁定 ${USER_SYSTEM_CONFIG.lockoutMinutes} 分钟` };
    }
    saveAttempts(attempts);
    return { locked: false, remainingAttempts: USER_SYSTEM_CONFIG.maxLoginAttempts - entry.count };
}

function clearAttempts(username: string | null, ip: string | null): void {
    const attempts = loadAttempts();
    let changed = false;
    if (username && attempts[`user:${username}`]) {
        delete attempts[`user:${username}`];
        changed = true;
    }
    if (ip && attempts[`ip:${ip}`]) {
        delete attempts[`ip:${ip}`];
        changed = true;
    }
    if (changed) saveAttempts(attempts);
}

function clearIpAttempts(ip: string): void {
    clearAttempts(null, ip);
}

// ==================== 登录日志 ====================

function loadLogs(): any {
    const doc = loadDoc(LOGIN_LOGS_FILE, emptyLogsDoc);
    return {
        logs: Array.isArray(doc.logs) ? doc.logs : [],
        counter: toInt(doc.counter, 0),
    };
}

function saveLogs(state: any): void {
    saveDoc(LOGIN_LOGS_FILE, { logs: state.logs, counter: state.counter, version: 1 });
}

function addLoginLog(event: string, username: string, errorType: string | null, ip: string, userAgent: string): void {
    const state = loadLogs();
    state.counter += 1;
    state.logs.push({
        id: String(state.counter),
        timestamp: now(),
        event: String(event || ''),
        username: String(username || ''),
        errorType: errorType || null,
        ip: String(ip || 'unknown'),
        userAgent: String(userAgent || 'unknown'),
    });
    const limit = toInt(USER_SYSTEM_CONFIG.loginLogLimit, 5000);
    if (state.logs.length > limit) state.logs = state.logs.slice(-limit);
    saveLogs(state);
}

function getLoginLogs({ limit = 100, offset = 0, username = '', event = '' }: any = {}): any {
    const state = loadLogs();
    let list = state.logs.slice().reverse();
    if (username) list = list.filter((item: any) => item.username === username);
    if (event) list = list.filter((item: any) => item.event === event);
    const total = list.length;
    const size = Math.min(Math.max(toInt(limit, 100), 1), 500);
    const start = Math.max(toInt(offset, 0), 0);
    return { logs: list.slice(start, start + size), total };
}

function clearLoginLogs(): any {
    saveLogs({ logs: [], counter: 0 });
    return { ok: true };
}

// ==================== 卡密核销核心 ====================

function verifyCardUsable(card: any, { allowQuota = true, allowTime = true }: any = {}): any {
    if (!card) return { ok: false, error: '卡密不存在' };
    if (card.revoked === true) return { ok: false, error: '卡密已作废' };
    if (card.enabled === false) return { ok: false, error: '卡密已被禁用' };
    if (card.usedBy) return { ok: false, error: '卡密已被使用' };
    const type = card.type || CARD_TYPES.TIME;
    if (type === CARD_TYPES.QUOTA && !allowQuota) {
        return { ok: false, error: '此处只能使用加时卡密，额度卡密请在登录后续费使用' };
    }
    if (type === CARD_TYPES.TIME && !allowTime) {
        return { ok: false, error: '此处只能使用额度卡密' };
    }
    return { ok: true, card };
}

function findCardByCode(cards: any[], code: unknown): any | null {
    const target = String(code || '').trim().toUpperCase();
    if (!target) return null;
    return cards.find(card => String(card.code || '').toUpperCase() === target) || null;
}

/**
 * 核销一张卡密到指定用户
 * 加时卡：延长有效期；额度卡：accountLimit += value；核销即锁定并写入流水
 */
function redeemCard(username: unknown, code: unknown, { operator = '', allowQuota = true, allowTime = true }: any = {}): any {
    const target = String(username || '').trim();
    if (!target) return { ok: false, error: '请提供用户名' };
    const cardCode = String(code || '').trim();
    if (!cardCode) return { ok: false, error: '请提供卡密' };

    const users = loadUsers();
    const user = findUserRecord(users, target);
    if (!user) return { ok: false, error: '用户不存在' };

    const cards = loadCards();
    const card = findCardByCode(cards, cardCode);
    const usable = verifyCardUsable(card, { allowQuota, allowTime });
    if (!usable.ok) return usable;
    // 免费卡密（描述严格为「免费」的加时卡）只能用于注册新账号
    if (isFreeTimeCard(card)) {
        return { ok: false, error: '免费卡密仅可用于注册新账号，不能用于加时长' };
    }

    const timestamp = now();
    const type = card.type || CARD_TYPES.TIME;
    const before = {
        expiresAt: user.subscription ? user.subscription.expiresAt : null,
        isPermanent: user.subscription ? user.subscription.isPermanent === true : false,
        accountLimit: user.accountLimit,
    };

    let summary = '';
    if (type === CARD_TYPES.QUOTA) {
        const value = toPositiveInt(card.value, 1);
        if (user.accountLimit !== UNLIMITED) {
            user.accountLimit = toInt(user.accountLimit, DEFAULT_ACCOUNT_LIMIT) + value;
        }
        summary = `额度 +${value}`;
    } else {
        const duration = normalizeDuration(card);
        const next = computeNextExpiry(user.subscription, duration, timestamp);
        const subscription = normalizeSubscription(user.subscription, user.username);
        subscription.expiresAt = next.expiresAt;
        subscription.isPermanent = next.isPermanent;
        subscription.enabled = true;
        subscription.code = card.code;
        subscription.description = card.description || '';
        subscription.source = operator && operator !== user.username ? 'admin' : 'renew';
        subscription.activatedAt = subscription.activatedAt || timestamp;
        subscription.totalAddedMs = toInt(subscription.totalAddedMs, 0)
            + (duration.isPermanent ? 0 : duration.durationMs);
        subscription.updatedAt = timestamp;
        subscription.owner = user.username;
        user.subscription = subscription;
        summary = duration.isPermanent ? '永久有效' : `有效期 +${formatDuration(duration)}`;
    }

    card.usedBy = user.username;
    card.usedAt = timestamp;
    card.status = CARD_STATUS.USED;
    card.updatedAt = timestamp;
    user.updatedAt = timestamp;

    saveUsers(users);
    saveCards(cards);

    const after = {
        expiresAt: user.subscription ? user.subscription.expiresAt : null,
        isPermanent: user.subscription ? user.subscription.isPermanent === true : false,
        accountLimit: user.accountLimit,
    };

    appendRedemption({
        at: timestamp,
        code: card.code,
        cardType: type,
        username: user.username,
        operator: operator || user.username,
        action: 'redeem',
        summary,
        before,
        after,
    });

    return {
        ok: true,
        cardType: type,
        summary,
        subscription: user.subscription,
        accountLimit: user.accountLimit,
        user: toPublicUser(user),
    };
}

// ==================== 注册 ====================

function validateUsername(username: unknown): any {
    const text = String(username || '').trim();
    if (!USERNAME_RE.test(text)) {
        return { ok: false, error: '用户名需为 3-32 位字母、数字或下划线' };
    }
    return { ok: true, username: text };
}

/** 用户注册（绑定卡密），卡密面值决定初始有效期 */
function registerUser(username: unknown, password: unknown, cardCode: unknown, options: any = {}): any {
    if (!USER_SYSTEM_CONFIG.allowRegister && !options.byAdmin) {
        return { ok: false, error: '当前未开放自助注册，请联系管理员开号' };
    }
    const nameCheck = validateUsername(username);
    if (!nameCheck.ok) return nameCheck;

    const passwordText = String(password ?? '');
    const pwdCheck = validatePasswordStrength(passwordText);
    if (!pwdCheck.valid) return { ok: false, error: pwdCheck.errors.join('；') };

    const users = loadUsers();
    if (findUserRecord(users, nameCheck.username)) {
        return { ok: false, error: '用户名已存在' };
    }

    const cards = loadCards();
    const card = findCardByCode(cards, cardCode);
    const usable = verifyCardUsable(card, {
        allowQuota: options.allowQuota === true,
        allowTime: true,
    });
    if (!usable.ok) return usable;

    const timestamp = now();
    const duration = normalizeDuration(card);
    const subscription = normalizeSubscription({}, nameCheck.username);
    subscription.code = card.code;
    subscription.description = card.description || '';
    subscription.source = 'register';
    subscription.activatedAt = timestamp;
    subscription.updatedAt = timestamp;
    subscription.totalAddedMs = duration.isPermanent ? 0 : duration.durationMs;
    if (duration.isPermanent) {
        subscription.isPermanent = true;
        subscription.expiresAt = null;
    } else {
        subscription.isPermanent = false;
        subscription.expiresAt = timestamp + duration.durationMs;
    }

    const user = normalizeUser({
        username: nameCheck.username,
        password: hashPassword(passwordText),
        role: USER_ROLES.USER,
        accountLimit: DEFAULT_ACCOUNT_LIMIT,
        subscription,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: String(options.createdBy || 'register'),
    });
    users.push(user);

    card.usedBy = user.username;
    card.usedAt = timestamp;
    card.status = CARD_STATUS.USED;
    card.updatedAt = timestamp;

    saveUsers(users);
    saveCards(cards);
    clearAttempts(user.username, options.ip);

    purgeRedemptionsForUser(user.username);

    appendRedemption({
        at: timestamp,
        code: card.code,
        cardType: card.type || CARD_TYPES.TIME,
        username: user.username,
        operator: user.username,
        action: 'register',
        summary: duration.isPermanent ? '注册并激活永久' : `注册并激活 ${formatDuration(duration)}`,
        before: null,
        after: {
            expiresAt: subscription.expiresAt,
            isPermanent: subscription.isPermanent,
            accountLimit: user.accountLimit,
        },
    });

    return { ok: true, user: toPublicUser(user) };
}

/** 管理员直接开号（可不使用卡密，直接指定有效期/额度） */
function createUserByAdmin({ username, password, role = USER_ROLES.USER, accountLimit, expiresAt, isPermanent, nick, email, phone, remark, operator = '' }: any): any {
    const nameCheck = validateUsername(username);
    if (!nameCheck.ok) return nameCheck;

    const pwdCheck = validatePasswordStrength(password);
    if (!pwdCheck.valid) return { ok: false, error: pwdCheck.errors.join('；') };

    const users = loadUsers();
    if (findUserRecord(users, nameCheck.username)) {
        return { ok: false, error: '用户名已存在' };
    }

    const timestamp = now();
    const subscription = normalizeSubscription({}, nameCheck.username);
    subscription.source = 'admin';
    subscription.activatedAt = timestamp;
    subscription.updatedAt = timestamp;
    if (isPermanent === true) {
        subscription.isPermanent = true;
        subscription.expiresAt = null;
    } else if (Number.isFinite(Number(expiresAt)) && Number(expiresAt) > 0) {
        subscription.expiresAt = Number(expiresAt);
        subscription.isPermanent = false;
    } else {
        subscription.expiresAt = null;
        subscription.isPermanent = false;
    }

    const targetRole = [USER_ROLES.USER, USER_ROLES.SUPER_ADMIN].includes(role) ? role : USER_ROLES.USER;
    const user = normalizeUser({
        username: nameCheck.username,
        password: hashPassword(password),
        role: targetRole,
        nick: nick || '',
        email: email || '',
        phone: phone || '',
        remark: remark || '',
        accountLimit: isElevatedRole(targetRole)
            ? UNLIMITED
            : (Number.isFinite(Number(accountLimit)) ? toInt(accountLimit, DEFAULT_ACCOUNT_LIMIT) : DEFAULT_ACCOUNT_LIMIT),
        subscription,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: operator || 'admin',
    });
    users.push(user);
    saveUsers(users);
    return { ok: true, user: toPublicUser(user) };
}

// ==================== 登录校验 ====================

function validateUser(username: unknown, password: unknown, ip = 'unknown'): any {
    const inputName = String(username || '').trim();
    const passwordText = String(password ?? '');
    if (!inputName || !passwordText) {
        return { error: 'invalid_credentials', message: '请输入用户名和密码' };
    }

    const rate = checkRateLimit(ip);
    if (!rate.allowed) {
        return { error: 'rate_limit', message: rate.message, remainingMs: rate.remainingMs };
    }

    // 超级管理员（环境变量配置）
    const superName = String(USER_SYSTEM_CONFIG.superAdminUsername || '').trim();
    if (superName && inputName === superName) {
        if (String(password) !== String(USER_SYSTEM_CONFIG.superAdminPassword)) {
            recordFailedAttempt(inputName);
            return { error: 'invalid_credentials', message: '用户名或密码错误' };
        }
        clearAttempts(inputName, ip);
        return {
            id: 'super_admin',
            username: superName,
            role: USER_ROLES.SUPER_ADMIN,
            accountLimit: UNLIMITED,
            subscription: normalizeSubscription({ isPermanent: true, source: 'config' }, superName),
            card: normalizeSubscription({ isPermanent: true, source: 'config' }, superName),
            mustChangePassword: false,
        };
    }

    const lockout = checkAccountLockout(inputName);
    if (lockout.locked) {
        return { error: 'locked', message: lockout.message, remainingMs: lockout.remainingMs };
    }

    const users = loadUsers();
    const user = findUserRecord(users, inputName);
    if (!user) {
        recordFailedAttempt(inputName);
        return { error: 'invalid_credentials', message: '用户名或密码错误' };
    }

    if (!verifyPassword(passwordText, user.password)) {
        const result = recordFailedAttempt(inputName);
        if (result.locked) return { error: 'locked', message: result.message };
        return {
            error: 'invalid_credentials',
            message: `用户名或密码错误，剩余尝试次数: ${result.remainingAttempts}`,
        };
    }

    clearAttempts(inputName, ip);

    if (needsRehash(user.password)) {
        user.password = hashPassword(passwordText);
    }
    user.lastLoginAt = now();
    user.lastLoginIp = String(ip || '');
    saveUsers(users);

    const publicUser = toPublicUser(user);
    return {
        id: publicUser.id,
        username: publicUser.username,
        role: publicUser.role,
        accountLimit: publicUser.accountLimit,
        subscription: publicUser.subscription,
        card: publicUser.subscription,
        mustChangePassword: publicUser.mustChangePassword,
    };
}

/** 续费（登录用户自助） */
function renewUser(username: string, cardCode: string): any {
    return redeemCard(username, cardCode, { operator: username });
}

/**
 * 直接给账号加时长（不消耗卡密）。邀请奖励、活动补偿都走这里。
 */
function extendSubscriptionByDays(username: string, days: number, meta: any = {}): any {
    const amount = Number(days);
    if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: '奖励天数无效' };
    }
    const users = loadUsers();
    const user = findUserRecord(users, username);
    if (!user) return { ok: false, error: '用户不存在' };

    const timestamp = now();
    const subscription = normalizeSubscription(user.subscription, user.username);
    if (subscription.isPermanent) {
        return { ok: true, subscription, addedMs: 0, permanent: true };
    }

    const ms = Math.round(amount * 24 * 60 * 60 * 1000);
    const base = Math.max(Number(subscription.expiresAt) || 0, timestamp);
    subscription.expiresAt = base + ms;
    subscription.enabled = subscription.enabled !== false;
    subscription.totalAddedMs = (Number(subscription.totalAddedMs) || 0) + ms;
    subscription.updatedAt = timestamp;
    subscription.lastGrant = String(meta.reason || 'grant');
    user.subscription = subscription;
    user.updatedAt = timestamp;

    saveUsers(users);

    appendRedemption({
        at: timestamp,
        code: '',
        cardType: CARD_TYPES.TIME,
        username: user.username,
        operator: String(meta.operator || 'system'),
        action: String(meta.reason || 'grant'),
        summary: `赠送 ${amount} 天（${meta.reason === 'invite' ? '邀请奖励' : '系统赠送'}）`,
        before: null,
        after: {
            expiresAt: subscription.expiresAt,
            isPermanent: false,
            accountLimit: user.accountLimit,
        },
    });

    return { ok: true, subscription: toPublicUser(user).subscription, addedMs: ms };
}

// ==================== 用户查询 ====================

function getUserByName(username: unknown): any | null {
    const users = loadUsers();
    const user = findUserRecord(users, username);
    return user ? toPublicUser(user) : null;
}

function getAllUsers(): any[] {
    return loadUsers().map(user => toPublicUser(user));
}

/** 管理员列表页：额外附带农场账号数量（由调用方注入 countAccounts） */
function listUsersForAdmin({ countAccounts }: any = {}): any[] {
    return getAllUsers().map((user) => {
        const extra: any = {};
        if (typeof countAccounts === 'function') {
            try {
                extra.accountCount = toInt(countAccounts(user.username), 0);
            } catch {
                extra.accountCount = 0;
            }
        }
        return { ...user, ...extra };
    });
}

function getUserCount(): number {
    return loadUsers().length;
}

// ==================== 用户编辑 ====================

function updateUser(username: string, updates: any = {}): any {
    const users = loadUsers();
    const user = findUserRecord(users, username);
    if (!user) return { ok: false, error: '用户不存在' };

    const timestamp = now();
    const subscription = normalizeSubscription(user.subscription, user.username);

    if (updates.enabled !== undefined) {
        subscription.enabled = updates.enabled !== false;
    }
    if (updates.isPermanent === true) {
        subscription.isPermanent = true;
        subscription.expiresAt = null;
    } else if (updates.expiresAt !== undefined) {
        const next = Number(updates.expiresAt);
        if (!Number.isFinite(next) || next <= 0) {
            subscription.expiresAt = null;
            subscription.isPermanent = false;
        } else {
            subscription.expiresAt = next;
            subscription.isPermanent = false;
        }
    }
    subscription.updatedAt = timestamp;
    user.subscription = subscription;
    user.updatedAt = timestamp;
    saveUsers(users);
    return { ok: true, user: toPublicUser(user) };
}

/** 编辑用户资料（管理员） */
function editUser(username: string, updates: any = {}): any {
    const users = loadUsers();
    const user = findUserRecord(users, username);
    if (!user) return { ok: false, error: '用户不存在' };

    const timestamp = now();

    if (updates.newUsername && updates.newUsername !== username) {
        const nameCheck = validateUsername(updates.newUsername);
        if (!nameCheck.ok) return nameCheck;
        if (findUserRecord(users, nameCheck.username)) {
            return { ok: false, error: '用户名已存在' };
        }
        user.username = nameCheck.username;
    }

    if (updates.password !== undefined && String(updates.password).length > 0) {
        const pwdCheck = validatePasswordStrength(updates.password);
        if (!pwdCheck.valid) return { ok: false, error: pwdCheck.errors.join('；') };
        user.password = hashPassword(updates.password);
        user.mustChangePassword = false;
    }

    if (updates.role !== undefined && [USER_ROLES.USER, USER_ROLES.SUPER_ADMIN].includes(updates.role)) {
        user.role = updates.role;
        if (isElevatedRole(user.role)) user.accountLimit = UNLIMITED;
    }

    if (updates.accountLimit !== undefined && !isElevatedRole(user.role)) {
        const next = toInt(updates.accountLimit, DEFAULT_ACCOUNT_LIMIT);
        user.accountLimit = next < 0 ? UNLIMITED : next;
    }

    const subscription = normalizeSubscription(user.subscription, user.username);
    if (updates.enabled !== undefined) subscription.enabled = updates.enabled !== false;
    if (updates.isPermanent === true) {
        subscription.isPermanent = true;
        subscription.expiresAt = null;
    } else if (updates.expiresAt !== undefined) {
        const next = Number(updates.expiresAt);
        if (!Number.isFinite(next) || next <= 0) {
            subscription.expiresAt = null;
            subscription.isPermanent = false;
        } else {
            subscription.expiresAt = next;
            subscription.isPermanent = false;
        }
    }
    subscription.updatedAt = timestamp;
    user.subscription = subscription;

    if (updates.nick !== undefined) user.nick = String(updates.nick || '');
    if (updates.email !== undefined) user.email = String(updates.email || '');
    if (updates.phone !== undefined) user.phone = String(updates.phone || '');
    if (updates.remark !== undefined) user.remark = String(updates.remark || '');
    user.updatedAt = timestamp;

    saveUsers(users);
    return { ok: true, user: toPublicUser(user) };
}

function deleteUser(username: string, { force = false }: any = {}): any {
    const users = loadUsers();
    const index = users.findIndex(item => item.username === String(username || '').trim());
    if (index === -1) return { ok: false, error: '用户不存在' };
    const user = users[index];
    if (!force && isElevatedRole(user.role)) {
        return { ok: false, error: '不能删除管理员账号，如需删除请勾选强制' };
    }
    if (user.username === USER_SYSTEM_CONFIG.bootstrapAdminUsername && !force) {
        return { ok: false, error: '不能删除引导管理员账号' };
    }
    users.splice(index, 1);
    saveUsers(users);
    purgeRedemptionsForUser(user.username);
    return { ok: true, deletedUsername: user.username };
}

function changePassword(username: string, currentPassword: string, newPassword: string): any {
    const users = loadUsers();
    const user = findUserRecord(users, username);
    if (!user) return { ok: false, error: '用户不存在' };
    if (!verifyPassword(currentPassword, user.password)) {
        return { ok: false, error: '当前密码错误' };
    }
    const pwdCheck = validatePasswordStrength(newPassword);
    if (!pwdCheck.valid) return { ok: false, error: pwdCheck.errors.join('；') };
    user.password = hashPassword(newPassword);
    user.mustChangePassword = false;
    user.updatedAt = now();
    saveUsers(users);
    return { ok: true, message: '密码修改成功' };
}

/** 通过卡密找回密码：需该卡密已被目标用户核销过 */
function verifyCardOwnership(username: string, cardCode: string): any {
    const users = loadUsers();
    const user = findUserRecord(users, username);
    if (!user) return { ok: false, error: '用户名或卡密错误' };
    const cards = loadCards();
    const card = findCardByCode(cards, cardCode);
    if (!card) return { ok: false, error: '用户名或卡密错误' };
    if (card.usedBy !== user.username) return { ok: false, error: '卡密不属于该用户' };
    return { ok: true };
}

function resetPasswordByCard(username: string, cardCode: string, newPassword: string): any {
    const ownership = verifyCardOwnership(username, cardCode);
    if (!ownership.ok) return ownership;
    const pwdCheck = validatePasswordStrength(newPassword);
    if (!pwdCheck.valid) return { ok: false, error: pwdCheck.errors.join('；') };
    const users = loadUsers();
    const user = findUserRecord(users, username);
    user.password = hashPassword(newPassword);
    user.mustChangePassword = false;
    user.updatedAt = now();
    saveUsers(users);
    clearAttempts(user.username, null);
    return { ok: true, message: '密码重置成功' };
}

/** 清理已过期普通用户（管理员手动触发，永不删除管理员） */
function clearExpiredUsers(): any {
    const users = loadUsers();
    const timestamp = now();
    const keep: any[] = [];
    const deletedUsers: string[] = [];
    for (const user of users) {
        if (isElevatedRole(user.role)) {
            keep.push(user);
            continue;
        }
        if (isSubscriptionExpired(user.subscription, timestamp)) {
            deletedUsers.push(user.username);
            continue;
        }
        keep.push(user);
    }
    if (deletedUsers.length > 0) saveUsers(keep);
    return { ok: true, deletedCount: deletedUsers.length, deletedUsers };
}

// ==================== 卡密管理 ====================

function getAllCards({ type = '', status = '', keyword = '' }: any = {}): any[] {
    let cards = loadCards().map(normalizeCard);
    if (type) cards = cards.filter((card: any) => card.type === type);
    if (status) cards = cards.filter((card: any) => card.status === status);
    if (keyword) {
        const text = String(keyword).toLowerCase();
        cards = cards.filter((card: any) =>
            String(card.code).toLowerCase().includes(text)
            || String(card.description).toLowerCase().includes(text)
            || String(card.usedBy || '').toLowerCase().includes(text));
    }
    return cards.sort((a: any, b: any) => Number(b.createdAt) - Number(a.createdAt));
}

function getCardByCode(code: string): any | null {
    const card = findCardByCode(loadCards(), code);
    return card ? normalizeCard(card) : null;
}

/** 查询卡密详情（注册页预览用，不暴露敏感信息） */
function peekCard(code: string): any {
    const card = getCardByCode(code);
    if (!card) return { ok: false, error: '卡密不存在' };
    if (card.revoked) return { ok: false, error: '卡密已作废' };
    if (!card.enabled) return { ok: false, error: '卡密已被禁用' };
    if (card.usedBy) return { ok: false, error: '卡密已被使用' };
    return {
        ok: true,
        card: {
            code: card.code,
            type: card.type,
            description: card.description,
            durationValue: card.durationValue,
            durationUnit: card.durationUnit,
            durationMs: card.durationMs,
            days: card.days,
            isPermanent: card.isPermanent,
            value: card.value,
            valueText: describeCardValue(card),
        },
    };
}

function createCard({ description, type = CARD_TYPES.TIME, days, durationValue, durationUnit, isPermanent, value, count = 1, createdBy = '' }: any): any {
    const cardType = type === CARD_TYPES.QUOTA ? CARD_TYPES.QUOTA : CARD_TYPES.TIME;
    const requested = Number(cardType === CARD_TYPES.QUOTA ? value ?? days : durationValue ?? days);
    const permanentRequested = isPermanent === true || requested === -1;

    if (cardType === CARD_TYPES.TIME && !permanentRequested
        && (!Number.isFinite(requested) || requested <= 0)) {
        return { ok: false, error: '加时卡时长必须大于 0，永久卡请使用 -1' };
    }
    if (cardType === CARD_TYPES.QUOTA && (!Number.isFinite(requested) || requested <= 0)) {
        return { ok: false, error: '额度卡数量必须大于 0' };
    }

    const total = Math.min(Math.max(toInt(count, 1), 1), 200);
    const cards = loadCards();
    const batchId = createId('b_');
    const timestamp = now();
    const created: any[] = [];

    for (let i = 0; i < total; i += 1) {
        const card = normalizeCard({
            code: generateCardCode(),
            type: cardType,
            description: String(description || '').trim(),
            days: requested,
            durationValue: cardType === CARD_TYPES.TIME ? requested : undefined,
            durationUnit,
            isPermanent: permanentRequested,
            value: cardType === CARD_TYPES.QUOTA ? requested : undefined,
            enabled: true,
            usedBy: null,
            usedAt: null,
            batchId,
            createdAt: timestamp,
            createdBy,
        });
        cards.push(card);
        created.push(card);
    }
    saveCards(cards);
    return { ok: true, cards: created, batchId, count: created.length };
}

/** 更新卡密（描述 / 启停 / 作废） */
function updateCard(code: string, updates: any = {}): any {
    const cards = loadCards();
    const index = cards.findIndex((card: any) => String(card.code || '').toUpperCase() === String(code || '').toUpperCase());
    if (index === -1) return { ok: false, error: '卡密不存在' };

    const timestamp = now();
    const next = normalizeCard({
        ...cards[index],
        ...updates,
        code: cards[index].code,
        type: cards[index].type,
        updatedAt: timestamp,
    });

    if (updates.revoked === true) {
        next.revoked = true;
        next.enabled = false;
        next.revokedAt = timestamp;
    } else if (updates.revoked === false) {
        next.revoked = false;
        next.revokedAt = null;
    }
    if (updates.enabled !== undefined && next.revoked !== true) {
        next.enabled = updates.enabled !== false;
    }
    cards[index] = next;
    saveCards(cards);
    return { ok: true, card: next };
}

/** 作废卡密（不可再核销，已核销的历史不受影响） */
function revokeCard(code: string, operator = ''): any {
    const result = updateCard(code, { revoked: true });
    if (!result.ok) return result;
    appendRedemption({
        at: now(),
        code: result.card.code,
        cardType: result.card.type,
        username: String(result.card.usedBy || ''),
        operator: String(operator || 'admin'),
        action: 'revoke',
        summary: '卡密作废',
        before: { enabled: true, revoked: false },
        after: { enabled: false, revoked: true },
    });
    return result;
}

function deleteCard(code: string): any {
    const cards = loadCards();
    const target = String(code || '').toUpperCase();
    const index = cards.findIndex((card: any) => String(card.code || '').toUpperCase() === target);
    if (index === -1) return { ok: false, error: '卡密不存在' };
    const [removed] = cards.splice(index, 1);
    saveCards(cards);
    return { ok: true, card: normalizeCard(removed) };
}

function deleteCardsBatch(codes: unknown): any {
    if (!Array.isArray(codes) || codes.length === 0) {
        return { ok: false, error: '请提供要删除的卡密列表' };
    }
    const targets = new Set(codes.map((code: any) => String(code || '').toUpperCase()));
    const cards = loadCards();
    const kept: any[] = [];
    let deletedCount = 0;
    for (const card of cards) {
        if (targets.has(String(card.code || '').toUpperCase())) {
            deletedCount += 1;
            continue;
        }
        kept.push(card);
    }
    saveCards(kept);
    return { ok: true, deletedCount, notFoundCount: targets.size - deletedCount };
}

function getCardStats(): any {
    const cards = getAllCards();
    const stats = {
        total: cards.length,
        time: 0,
        quota: 0,
        unused: 0,
        used: 0,
        disabled: 0,
        revoked: 0,
    };
    for (const card of cards) {
        if (card.type === CARD_TYPES.QUOTA) stats.quota += 1;
        else stats.time += 1;
        if (card.status === CARD_STATUS.USED) stats.used += 1;
        else if (card.status === CARD_STATUS.REVOKED) stats.revoked += 1;
        else if (card.status === CARD_STATUS.DISABLED) stats.disabled += 1;
        else stats.unused += 1;
    }
    return stats;
}

// ==================== 卡密自助领取（免费卡密发号机） ====================

const CARD_CLAIM_FILE = getDataFile('card-claim.json');
const CLAIM_INTERVAL_MS = DAY_MS;
const CLAIM_RESERVATION_MS = 30 * 60 * 1000;
const CLAIM_GLOBAL_HOURLY_LIMIT = 10;
/** 只有描述严格等于该文案的加时卡才能被领取 */
export const FREE_CARD_DESCRIPTION = '免费';

function isFreeTimeCard(card: any): boolean {
    return !!card
        && (card.type || CARD_TYPES.TIME) === CARD_TYPES.TIME
        && String(card.description || '').trim() === FREE_CARD_DESCRIPTION;
}

function loadClaimRecords(): any {
    const doc = loadDoc(CARD_CLAIM_FILE, () => ({ enabled: USER_SYSTEM_CONFIG.cardClaimEnabled, records: [], reservations: [] }));
    return {
        enabled: doc.enabled === true,
        records: Array.isArray(doc.records) ? doc.records : [],
        reservations: Array.isArray(doc.reservations) ? doc.reservations : [],
    };
}

function saveClaimRecords(state: any): void {
    saveDoc(CARD_CLAIM_FILE, state);
}

function getCardClaimStatus(): any {
    const state = loadClaimRecords();
    const available = getAllCards().filter((card: any) =>
        isFreeTimeCard(card) && !card.usedBy && card.enabled !== false && card.revoked !== true).length;
    return { enabled: state.enabled, availableTimeCards: available };
}

function setCardClaimStatus(enabled: boolean): any {
    const state = loadClaimRecords();
    state.enabled = !!enabled;
    saveClaimRecords(state);
    return getCardClaimStatus();
}

function claimCardByUA(userAgent: string, username: string | null = null, ip = '', options: any = {}): any {
    const state = loadClaimRecords();
    if (!state.enabled) return { ok: false, error: '管理员已关闭免费功能' };

    const nowTs = now();
    const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : CLAIM_INTERVAL_MS;
    const reservationMs = Number(options.reservationMs) > 0 ? Number(options.reservationMs) : CLAIM_RESERVATION_MS;
    const globalHourlyLimit = Number.isInteger(options.globalHourlyLimit)
        ? options.globalHourlyLimit
        : CLAIM_GLOBAL_HOURLY_LIMIT;

    const uaHash = crypto.createHash('sha256').update(String(userAgent || '')).digest('hex');
    const ipHash = crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex');

    state.reservations = state.reservations.filter((item: any) => nowTs < Number(item.expiresAt || 0));

    const hit = state.records.find((item: any) =>
        (item.uaHash === uaHash || (item.ipHash && item.ipHash === ipHash))
        && nowTs - Number(item.claimTime || 0) < intervalMs);
    if (hit) {
        const remainingMs = intervalMs - (nowTs - Number(hit.claimTime || 0));
        return { ok: false, error: '您已在 24 小时内领取过免费卡密', remainingMs };
    }

    if (globalHourlyLimit >= 0) {
        const hourAgo = nowTs - 60 * 60 * 1000;
        const recentCount = state.records.filter((item: any) => Number(item.claimTime || 0) >= hourAgo).length;
        if (recentCount >= globalHourlyLimit) {
            return { ok: false, error: '当前领取人数较多，请稍后再试' };
        }
    }

    const reservedCodes = new Set(
        state.reservations.map((item: any) => String(item.cardCode || '').toUpperCase()),
    );
    const available = loadCards().filter((card: any) =>
        isFreeTimeCard(card)
        && !card.usedBy
        && card.enabled !== false
        && card.revoked !== true
        && !reservedCodes.has(String(card.code || '').toUpperCase()));
    if (available.length === 0) return { ok: false, error: '卡密数量不足请联系管理员' };

    const picked = normalizeCard(available[Math.floor(Math.random() * available.length)]);
    state.reservations.push({
        cardCode: picked.code,
        uaHash,
        ipHash,
        claimTime: nowTs,
        expiresAt: nowTs + reservationMs,
    });
    state.records.push({
        uaHash,
        ipHash,
        claimTime: nowTs,
        cardCode: picked.code,
        username: username || null,
    });
    if (state.records.length > 5000) state.records = state.records.slice(-5000);
    saveClaimRecords(state);

    return {
        ok: true,
        cardCode: picked.code,
        description: picked.description,
        valueText: describeCardValue(picked),
        isPermanent: picked.isPermanent,
    };
}

function getCardClaimRecords(): any[] {
    return loadClaimRecords().records;
}

// ==================== 额度校验 ====================

function checkAccountQuota(user: any, currentCount = 0): any {
    if (!user) return { ok: false, error: '未登录' };
    if (isElevatedRole(user.role)) {
        return { ok: true, limit: UNLIMITED, current: currentCount, remaining: UNLIMITED };
    }
    const limitRaw = Number(user.accountLimit);
    const limit = Number.isFinite(limitRaw) ? limitRaw : DEFAULT_ACCOUNT_LIMIT;
    if (limit === UNLIMITED) {
        return { ok: true, limit: UNLIMITED, current: currentCount, remaining: UNLIMITED };
    }
    const count = toInt(currentCount, 0);
    if (count >= limit) {
        return {
            ok: false,
            error: `已达账号额度上限（${limit} 个），请使用额度卡提升配额或删除旧账号`,
            limit,
            current: count,
            remaining: 0,
        };
    }
    return { ok: true, limit, current: count, remaining: limit - count };
}

// ==================== 初始化 ====================

let bootstrapped = false;

/**
 * 首次启动创建引导管理员。
 * 兼容旧的单管理员安装：users.json 为空且存在 admin.json 时，
 * 直接把原管理员（含密码哈希，两边哈希算法一致）迁移为超级管理员。
 */
function ensureBootstrapAdmin(): void {
    if (bootstrapped) return;
    bootstrapped = true;
    const users = loadUsers();
    const bootstrapName = String(USER_SYSTEM_CONFIG.bootstrapAdminUsername || '').trim();
    if (!bootstrapName) return;

    const existing = findUserRecord(users, bootstrapName);
    if (existing) {
        let changed = false;
        if (existing.role !== USER_ROLES.SUPER_ADMIN) {
            existing.role = USER_ROLES.SUPER_ADMIN;
            changed = true;
        }
        if (Number(existing.accountLimit) !== UNLIMITED) {
            existing.accountLimit = UNLIMITED;
            changed = true;
        }
        if (changed) {
            existing.updatedAt = now();
            saveUsers(users);
            console.log(`[用户系统] 内置管理员 ${bootstrapName} 已升级为超级管理员`);
        }
        return;
    }

    const timestamp = now();

    // 迁移旧单管理员（保持原用户名/密码哈希/强制改密标记）
    try {
        const adminFile = getDataFile('admin.json');
        const doc = readJsonFile(adminFile, () => null);
        const legacy = doc && typeof doc === 'object' ? (doc.admin || doc) : null;
        if (legacy && String(legacy.password || '').includes(':')) {
            const admin = normalizeUser({
                username: String(legacy.username || bootstrapName).trim() || bootstrapName,
                password: String(legacy.password),
                role: USER_ROLES.SUPER_ADMIN,
                accountLimit: UNLIMITED,
                subscription: normalizeSubscription({
                    isPermanent: true,
                    source: 'bootstrap',
                    description: '内置管理员（迁移自单管理员模式）',
                    activatedAt: timestamp,
                }, String(legacy.username || bootstrapName)),
                createdAt: Number(legacy.createdAt) || timestamp,
                updatedAt: timestamp,
                createdBy: 'bootstrap',
                mustChangePassword: legacy.mustChangePassword === true,
                remark: '系统内置管理员',
            });
            users.push(admin);
            saveUsers(users);
            console.log(`[用户系统] 已迁移原管理员 ${admin.username} 为超级管理员`);
            return;
        }
    } catch { /* 迁移失败则走默认创建 */ }

    const admin = normalizeUser({
        username: bootstrapName,
        password: hashPassword(USER_SYSTEM_CONFIG.bootstrapAdminPassword),
        role: USER_ROLES.SUPER_ADMIN,
        accountLimit: UNLIMITED,
        subscription: normalizeSubscription({
            isPermanent: true,
            source: 'bootstrap',
            description: '内置管理员',
            activatedAt: timestamp,
        }, bootstrapName),
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: 'bootstrap',
        mustChangePassword: USER_SYSTEM_CONFIG.bootstrapAdminPassword === 'admin',
        remark: '系统内置管理员',
    });
    users.push(admin);
    saveUsers(users);
    console.log(`[用户系统] 已创建内置管理员：${bootstrapName}`);
}

ensureBootstrapAdmin();

// ==================== 导出 ====================

module.exports = {
    DEFAULT_ACCOUNT_LIMIT,
    ADMIN_ACCOUNT_LIMIT,
    UNLIMITED,
    USER_ROLES,
    CARD_TYPES,
    CARD_STATUS,
    isElevatedRole,

    hashPassword,
    verifyPassword,
    validatePasswordStrength,
    normalizeDuration,
    normalizeCard,
    formatDuration,
    describeCardValue,
    computeNextExpiry,
    isSubscriptionExpired,
    getRemainingMs,

    validateUser,
    registerUser,
    renewUser,
    extendSubscriptionByDays,
    redeemCard,
    changePassword,
    verifyCardOwnership,
    resetPasswordByCard,
    checkRateLimit,
    clearIpAttempts,
    clearAttempts,

    getAllUsers,
    listUsersForAdmin,
    getUserByName,
    getUserCount,
    createUserByAdmin,
    updateUser,
    editUser,
    deleteUser,
    clearExpiredUsers,

    getAllCards,
    getCardByCode,
    peekCard,
    createCard,
    updateCard,
    revokeCard,
    deleteCard,
    deleteCardsBatch,
    getCardStats,

    getRedemptions,
    purgeRedemptionsForUser,
    getCardClaimStatus,
    setCardClaimStatus,
    claimCardByUA,
    getCardClaimRecords,
    isFreeTimeCard,
    FREE_CARD_DESCRIPTION,

    checkAccountQuota,

    addLoginLog,
    getLoginLogs,
    clearLoginLogs,

    isSuperAdmin: (username: unknown): boolean => {
        const configured = String(USER_SYSTEM_CONFIG.superAdminUsername || '').trim();
        if (configured && String(username || '').trim() === configured) return true;
        const user = getUserByName(username);
        return !!user && user.role === USER_ROLES.SUPER_ADMIN;
    },
    ensureBootstrapAdmin,
};
