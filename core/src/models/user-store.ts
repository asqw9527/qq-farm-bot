export {};
/**
 * 完整移植自 Go 项目 models/user_store.go 的多用户体系。
 * 数据文件：users.json / cards.json / card-claim.json / login-attempts.json
 * 全部位于 core/data/ 下（与现有 admin.json 同目录）。
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');
const security = require('./auth-security');

const USERS_FILE: string = getDataFile('users.json');
const CARDS_FILE: string = getDataFile('cards.json');
const CARD_CLAIM_FILE: string = getDataFile('card-claim.json');
// 用户体系使用独立文件，避免与旧 admin-store 的 login-attempts.json 相互覆盖
const LOGIN_ATTEMPTS_FILE: string = getDataFile('user-login-attempts.json');
const LEGACY_ADMIN_FILE: string = getDataFile('admin.json');

const DEFAULT_ACCOUNT_LIMIT = 2;
const LOGIN_ATTEMPTS_LIMIT = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000;
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_ATTEMPTS_PER_IP = 6;
const IP_LOCKOUT_DURATION = 10 * 60 * 1000;
const USER_TOKEN_TTL = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Card {
    code: string;
    description: string;
    type: string;           // 'time' | 'quota'
    enabled: boolean;
    usedBy?: string;
    usedAt?: number;
    createdAt: number;
    value?: number;         // quota cards
    days?: number;
    durationMs?: number;
    isPermanent?: boolean;
    expiresAt?: number;
}

interface User {
    username: string;
    password: string;
    role: string;           // 'admin' | 'user'
    cardCode?: string;
    card?: Card;
    accountLimit?: number;  // -1 = unlimited, 0 = use default
    expiresAt?: number;
    isPermanent?: boolean;
    mustChangePassword?: boolean;
    createdAt: number;
}

interface AuthResult {
    username: string;
    role: string;
    cardCode?: string;
    accountLimit: number;
    expiresAt?: number;
    isPermanent?: boolean;
    mustChangePassword?: boolean;
}

interface CardClaimRecord {
    uaHash: string;
    claimTime: number;
    cardCode: string;
    username?: string;
}

let users: User[] = [];
let cards: Card[] = [];
let cardClaimRecords: Record<string, CardClaimRecord> = {};
let cardClaimEnabled = true;
let loginAttempts: Record<string, any> = {};
// token -> { username, expiresAt }
const userTokens = new Map<string, { username: string; expiresAt: number }>();

// ---------- 持久化 ----------

function normalizeCard(raw: any): Card | null {
    if (!raw || typeof raw !== 'object') return null;
    const code = String(raw.code || '').trim();
    if (!code) return null;
    return {
        code,
        description: String(raw.description || ''),
        type: raw.type === 'quota' ? 'quota' : 'time',
        enabled: raw.enabled !== false,
        usedBy: raw.usedBy ? String(raw.usedBy) : undefined,
        usedAt: Number(raw.usedAt) || undefined,
        createdAt: Number(raw.createdAt) || Date.now(),
        value: Number(raw.value) || undefined,
        days: Number(raw.days) || undefined,
        durationMs: Number(raw.durationMs) || undefined,
        isPermanent: raw.isPermanent === true,
        expiresAt: Number(raw.expiresAt) || undefined,
    };
}

function normalizeUser(raw: any): User | null {
    if (!raw || typeof raw !== 'object') return null;
    const username = String(raw.username || '').trim();
    const password = String(raw.password || '').trim();
    if (!username || !password) return null;
    const card = raw.card ? normalizeCard(raw.card) : undefined;
    return {
        username,
        password,
        role: raw.role === 'admin' || raw.role === 'super_admin' ? 'admin' : 'user',
        cardCode: raw.cardCode ? String(raw.cardCode) : undefined,
        card: card || undefined,
        accountLimit: raw.accountLimit === undefined ? undefined : Number(raw.accountLimit),
        expiresAt: Number(raw.expiresAt) || undefined,
        isPermanent: raw.isPermanent === true,
        mustChangePassword: raw.mustChangePassword === true || undefined,
        createdAt: Number(raw.createdAt) || Date.now(),
    };
}

function saveUsers(): void {
    ensureDataDir();
    writeJsonFileAtomic(USERS_FILE, { users }, 2);
}

function saveCards(): void {
    ensureDataDir();
    writeJsonFileAtomic(CARDS_FILE, { cards }, 2);
}

function saveCardClaimRecords(): void {
    ensureDataDir();
    writeJsonFileAtomic(CARD_CLAIM_FILE, { enabled: cardClaimEnabled, records: cardClaimRecords }, 2);
}

function saveLoginAttempts(): void {
    ensureDataDir();
    try {
        writeJsonFileAtomic(LOGIN_ATTEMPTS_FILE, loginAttempts, 2);
    } catch (e: any) {
        console.error('保存登录尝试记录失败:', e.message);
    }
}

function loadUsers(): void {
    const raw = readJsonFile(USERS_FILE, { users: [] });
    users = (Array.isArray(raw?.users) ? raw.users : []).map(normalizeUser).filter(Boolean);
}

function loadCards(): void {
    const raw = readJsonFile(CARDS_FILE, { cards: [] });
    cards = (Array.isArray(raw?.cards) ? raw.cards : []).map(normalizeCard).filter(Boolean);
}

function loadCardClaimRecords(): void {
    const raw = readJsonFile(CARD_CLAIM_FILE, { enabled: true, records: {} });
    cardClaimEnabled = raw?.enabled !== false;
    cardClaimRecords = (raw?.records && typeof raw.records === 'object') ? raw.records : {};
}

function loadLoginAttempts(): void {
    const raw = readJsonFile(LOGIN_ATTEMPTS_FILE, {});
    const source = (raw && typeof raw === 'object') ? raw : {};
    loginAttempts = {};
    for (const [key, value] of Object.entries(source)) {
        if ((key === 'admin' || key.startsWith('ip:') || key.startsWith('user:')) && value && typeof value === 'object') {
            loginAttempts[key] = value;
        }
    }
    const legacy = source['user:admin'];
    if (!loginAttempts['admin'] && legacy && typeof legacy === 'object') loginAttempts['admin'] = legacy;
}

// ---------- 卡密工具 ----------

function generateCardCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = crypto.randomBytes(16);
    let out = '';
    for (const b of bytes) out += chars[b % chars.length];
    return out;
}

function findUserIndex(username: string): number {
    return users.findIndex(u => u.username === username);
}

function findCardIndex(code: string): number {
    return cards.findIndex(c => c.code === code);
}

function buildAuthResult(user: User): AuthResult {
    const limit = effectiveAccountLimit(user);
    const expiresAt = user.expiresAt || (user.card ? user.card.expiresAt : undefined);
    return {
        username: user.username,
        role: user.role,
        cardCode: user.cardCode,
        accountLimit: limit,
        expiresAt,
        isPermanent: user.isPermanent === true || (!!user.card && user.card.isPermanent === true),
        mustChangePassword: user.mustChangePassword === true,
    };
}

// ---------- 初始化 + 迁移 ----------

function initUserStore(): void {
    ensureDataDir();
    loadUsers();
    loadCards();
    loadCardClaimRecords();
    loadLoginAttempts();

    if (findUserIndex('admin') < 0) {
        // 从旧 admin.json 迁移（沿用已哈希密码），否则创建默认 admin/admin
        let passwordHash = '';
        let mustChangePassword = true;
        let createdAt = Date.now();
        try {
            if (fs.existsSync(LEGACY_ADMIN_FILE)) {
                const legacy = JSON.parse(fs.readFileSync(LEGACY_ADMIN_FILE, 'utf8'));
                const rec = legacy?.admin || legacy;
                if (rec && String(rec.password || '').trim()) {
                    passwordHash = String(rec.password);
                    mustChangePassword = rec.mustChangePassword === true;
                    createdAt = Number(rec.createdAt) || Date.now();
                }
            }
        } catch { /* ignore legacy read errors */ }
        // 前端统一传 SHA-256 摘要，默认密码也按摘要存储，
        // 避免全新安装时默认 admin 无法登录。
        if (!passwordHash) {
            const defaultDigest = crypto.createHash('sha256').update('admin').digest('hex');
            passwordHash = security.hashPassword(defaultDigest);
        }
        users.push({
            username: 'admin',
            password: passwordHash,
            role: 'admin',
            accountLimit: -1,
            mustChangePassword,
            createdAt,
        });
        saveUsers();
        console.log('[用户体系] 已创建/迁移默认管理员 admin（密码 admin），请尽快修改');
    }
    if (cards.length === 0 && !fs.existsSync(CARDS_FILE)) saveCards();
    if (!fs.existsSync(CARD_CLAIM_FILE)) saveCardClaimRecords();
}

// ---------- 登录限流（按 IP + 按用户）----------

function cleanExpiredAttempts(): void {
    const now = Date.now();
    let changed = false;
    for (const key of Object.keys(loginAttempts)) {
        const a = loginAttempts[key];
        if ((a.lockedUntil && a.lockedUntil < now) || (a.windowStart && now - a.windowStart > RATE_LIMIT_WINDOW)) {
            delete loginAttempts[key];
            changed = true;
        }
    }
    if (changed) saveLoginAttempts();
}

function checkRateLimit(ip: string): { allowed: boolean; remainingMs?: number; message?: string } {
    cleanExpiredAttempts();
    const key = `ip:${ip}`;
    const now = Date.now();
    const a = loginAttempts[key];
    if (!a || now - (a.windowStart || 0) > RATE_LIMIT_WINDOW) {
        loginAttempts[key] = { count: 1, windowStart: now };
        saveLoginAttempts();
        return { allowed: true };
    }
    if (a.count >= MAX_ATTEMPTS_PER_IP) {
        const remainingMs = IP_LOCKOUT_DURATION;
        a.lockedUntil = now + IP_LOCKOUT_DURATION;
        loginAttempts[key] = a;
        saveLoginAttempts();
        return { allowed: false, remainingMs, message: `该 IP 登录失败过多，请 ${Math.ceil(remainingMs / 1000)} 秒后重试` };
    }
    a.count++;
    loginAttempts[key] = a;
    saveLoginAttempts();
    return { allowed: true };
}

function checkUserLockout(username: string): { locked: boolean; remainingMs?: number; message?: string } {
    cleanExpiredAttempts();
    const a = loginAttempts[`user:${username}`];
    const now = Date.now();
    if (a?.lockedUntil && a.lockedUntil > now) {
        const remainingMs = a.lockedUntil - now;
        return { locked: true, remainingMs, message: `账户已被锁定，请 ${Math.ceil(remainingMs / 60000)} 分钟后重试` };
    }
    return { locked: false };
}

function recordUserFailedAttempt(username: string): { locked: boolean; message?: string; remainingAttempts?: number } {
    const key = `user:${username}`;
    const now = Date.now();
    const a = loginAttempts[key] || { count: 0, firstAttempt: now };
    a.count++;
    a.lastAttempt = now;
    loginAttempts[key] = a;
    if (a.count >= LOGIN_ATTEMPTS_LIMIT) {
        a.lockedUntil = now + LOCKOUT_DURATION;
        saveLoginAttempts();
        return { locked: true, message: `登录失败次数过多，账户已被锁定 ${LOCKOUT_DURATION / 60000} 分钟` };
    }
    saveLoginAttempts();
    return { locked: false, remainingAttempts: LOGIN_ATTEMPTS_LIMIT - a.count, message: `用户名或密码错误，剩余尝试次数: ${LOGIN_ATTEMPTS_LIMIT - a.count}` };
}

function clearUserAttempts(username: string): void {
    delete loginAttempts[`user:${username}`];
    saveLoginAttempts();
}

function clearIpAttempts(ip: string): void {
    delete loginAttempts[`ip:${ip}`];
    saveLoginAttempts();
}

// ---------- 登录 / 注册 / 续费 ----------

function validateUser(username: string, password: string, ip: string = 'unknown'): { ok: boolean; user?: AuthResult; error?: string; errorType?: string; remainingMs?: number } {
    const rate = checkRateLimit(ip);
    if (!rate.allowed) return { ok: false, error: rate.message, errorType: 'rate_limit', remainingMs: rate.remainingMs };
    const lock = checkUserLockout(username);
    if (lock.locked) return { ok: false, error: lock.message, errorType: 'locked', remainingMs: lock.remainingMs };

    const idx = findUserIndex(username);
    if (idx < 0) {
        recordUserFailedAttempt(username);
        return { ok: false, error: '用户名或密码错误', errorType: 'invalid_credentials' };
    }
    const user = users[idx];
    if (!security.verifyPassword(password, user.password)) {
        const r = recordUserFailedAttempt(username);
        return { ok: false, error: r.message || '用户名或密码错误', errorType: r.locked ? 'locked' : 'invalid_credentials' };
    }
    if (userExpired(user)) {
        return { ok: false, error: '账号已过期，请使用卡密续费', errorType: 'expired' };
    }
    clearUserAttempts(username);
    clearIpAttempts(ip);
    if (security.needsRehash(user.password)) {
        user.password = security.hashPassword(password);
        saveUsers();
    }
    return { ok: true, user: buildAuthResult(user) };
}

function registerUser(username: string, password: string, cardCode: string): { ok: boolean; error?: string; user?: AuthResult } {
    const name = String(username || '').trim();
    if (name.length < 3 || name.length > 32) return { ok: false, error: '用户名长度需在3-32位之间' };
    if (!/^\w+$/.test(name)) return { ok: false, error: '用户名只能包含字母、数字和下划线' };
    if (findUserIndex(name) >= 0) return { ok: false, error: '用户名已存在' };

    const validation = security.validatePasswordStrength(String(password || ''));
    if (!validation.valid) return { ok: false, error: validation.errors[0] };

    const code = String(cardCode || '').trim();
    if (!code) {
        const available = cards.filter(c => c.type === 'time' && !c.usedBy && c.enabled).length;
        if (available === 0) return { ok: false, error: '注册失败，请联系管理员' };
        return { ok: false, error: '请输入卡密' };
    }
    const cidx = findCardIndex(code);
    if (cidx < 0) return { ok: false, error: '卡密不存在' };
    const card = cards[cidx];
    if (!card.enabled) return { ok: false, error: '卡密已被禁用，请联系管理员' };
    if (card.usedBy) return { ok: false, error: '卡密已被使用' };
    if (card.type === 'quota') return { ok: false, error: '注册只能使用时间卡密，额度卡密请登录后在续费中使用' };

    const now = Date.now();
    const durationMs = card.durationMs && card.durationMs > 0 ? card.durationMs : DAY_MS;
    const expiresAt = card.isPermanent ? 0 : now + durationMs;
    const cardCopy: Card = { ...card, usedBy: name, usedAt: now, expiresAt };
    const newUser: User = {
        username: name,
        password: security.hashPassword(String(password)),
        role: 'user',
        cardCode: code,
        card: cardCopy,
        accountLimit: DEFAULT_ACCOUNT_LIMIT,
        expiresAt,
        isPermanent: card.isPermanent === true,
        createdAt: now,
    };
    cards[cidx].usedBy = name;
    cards[cidx].usedAt = now;
    cards[cidx].expiresAt = expiresAt;
    users.push(newUser);
    saveUsers();
    saveCards();
    return { ok: true, user: buildAuthResult(newUser) };
}

function renewUser(username: string, cardCode: string): { ok: boolean; message?: string; error?: string } {
    const idx = findUserIndex(username);
    if (idx < 0) return { ok: false, error: '用户不存在' };
    const user = users[idx];
    const cidx = findCardIndex(String(cardCode || '').trim());
    if (cidx < 0) return { ok: false, error: '卡密不存在' };
    const card = cards[cidx];
    if (!card.enabled) return { ok: false, error: '卡密已被禁用' };
    if (card.usedBy) return { ok: false, error: '卡密已被使用' };

    const now = Date.now();
    let message = '续费成功';
    if (card.type === 'quota') {
        const add = card.value && card.value > 0 ? card.value : 1;
        if (user.accountLimit === -1) {
            message = '当前账号上限为无限，额度卡密已核销';
        } else {
            if (!user.accountLimit || user.accountLimit <= 0) user.accountLimit = DEFAULT_ACCOUNT_LIMIT;
            user.accountLimit += add;
            message = `续费成功，账号上限已提升至 ${user.accountLimit}`;
        }
    } else {
        if (!user.card) user.card = { ...card };
        let prevExpiresAt = user.expiresAt || (user.card.expiresAt || 0);
        if (prevExpiresAt > 0 && prevExpiresAt < now) prevExpiresAt = 0;
        if (card.isPermanent) {
            user.isPermanent = true;
            user.expiresAt = 0;
            user.card.expiresAt = 0;
            user.card.durationMs = -1;
            user.card.days = -1;
            user.card.isPermanent = true;
            message = '续费成功，已开通永久时长';
        } else {
            const newExp = prevExpiresAt > now ? prevExpiresAt + (card.durationMs || DAY_MS) : now + (card.durationMs || DAY_MS);
            user.expiresAt = newExp;
            user.card.expiresAt = newExp;
            user.card.days = card.days;
            user.card.durationMs = card.durationMs;
            user.card.isPermanent = false;
        }
        user.cardCode = card.code;
    }
    cards[cidx].usedBy = username;
    cards[cidx].usedAt = now;
    saveUsers();
    saveCards();
    return { ok: true, message };
}

// ---------- 用户管理 ----------

function getAllUsers(): any[] {
    return users.filter(u => u.role !== 'super_admin').map(u => ({
        username: u.username,
        role: u.role,
        cardCode: u.cardCode,
        accountLimit: effectiveAccountLimit(u),
        expiresAt: u.expiresAt || (u.card ? u.card.expiresAt : undefined),
        isPermanent: u.isPermanent === true || (!!u.card && u.card.isPermanent === true),
        createdAt: u.createdAt,
    }));
}

function getUserByUsername(username: string): User | undefined {
    const idx = findUserIndex(username);
    return idx >= 0 ? users[idx] : undefined;
}

function getUserRole(username: string): string | undefined {
    const u = getUserByUsername(username);
    return u ? u.role : undefined;
}

// 管理员直接创建用户（免卡密），可指定账号上限与到期时间
function adminCreateUser(username: string, password: string, opts?: { accountLimit?: number; days?: number; permanent?: boolean }): { ok: boolean; error?: string; user?: AuthResult } {
    const name = String(username || '').trim();
    if (name.length < 3 || name.length > 32) return { ok: false, error: '用户名长度需在3-32位之间' };
    if (!/^\w+$/.test(name)) return { ok: false, error: '用户名只能包含字母、数字和下划线' };
    if (findUserIndex(name) >= 0) return { ok: false, error: '用户名已存在' };
    const validation = security.validatePasswordStrength(String(password || ''));
    if (!validation.valid) return { ok: false, error: validation.errors[0] };

    const options = opts || {};
    const permanent = options.permanent === true;
    const days = Number(options.days);
    const expiresAt = permanent ? 0 : (Number.isFinite(days) && days > 0 ? Date.now() + days * DAY_MS : 0);
    let accountLimit = Number(options.accountLimit);
    if (!Number.isFinite(accountLimit) || accountLimit === 0) accountLimit = DEFAULT_ACCOUNT_LIMIT;
    if (accountLimit < -1) return { ok: false, error: '账号上限无效' };

    const newUser: User = {
        username: name,
        password: security.hashPassword(String(password)),
        role: 'user',
        accountLimit,
        expiresAt,
        isPermanent: permanent,
        createdAt: Date.now(),
    };
    users.push(newUser);
    saveUsers();
    return { ok: true, user: buildAuthResult(newUser) };
}

function deleteUser(username: string): { ok: boolean; error?: string } {
    const idx = findUserIndex(username);
    if (idx < 0) return { ok: false, error: '用户不存在' };
    if (users[idx].role === 'admin' || users[idx].role === 'super_admin') return { ok: false, error: '不能删除管理员账号' };
    users.splice(idx, 1);
    saveUsers();
    revokeUserTokens(username);
    return { ok: true };
}

function changeUserPassword(username: string, oldPassword: string, newPassword: string): { ok: boolean; error?: string } {
    const idx = findUserIndex(username);
    if (idx < 0) return { ok: false, error: '用户不存在' };
    if (!security.verifyPassword(oldPassword, users[idx].password)) return { ok: false, error: '原密码错误' };
    const validation = security.validatePasswordStrength(String(newPassword || ''));
    if (!validation.valid) return { ok: false, error: validation.errors[0] };
    users[idx].password = security.hashPassword(String(newPassword));
    users[idx].mustChangePassword = undefined;
    saveUsers();
    return { ok: true };
}

function adminChangeUserPassword(username: string, newPassword: string): { ok: boolean; error?: string } {
    const idx = findUserIndex(username);
    if (idx < 0) return { ok: false, error: '用户不存在' };
    if (users[idx].role === 'admin' || users[idx].role === 'super_admin') return { ok: false, error: '不能修改管理员密码' };
    const validation = security.validatePasswordStrength(String(newPassword || ''));
    if (!validation.valid) return { ok: false, error: validation.errors[0] };
    users[idx].password = security.hashPassword(String(newPassword));
    saveUsers();
    return { ok: true };
}

function updateUserLimits(username: string, expiresAtMs: number, accountLimit?: number): { ok: boolean; error?: string } {
    const idx = findUserIndex(username);
    if (idx < 0) return { ok: false, error: '用户不存在' };
    const user = users[idx];
    if (user.role === 'admin' || user.role === 'super_admin') return { ok: false, error: '不能修改管理员账号' };
    // expiresAtMs: <0 不改；0 永久；>0 指定时间戳
    if (expiresAtMs >= 0) {
        if (expiresAtMs === 0) {
            user.isPermanent = true;
            user.expiresAt = 0;
            if (user.card) {
                user.card.isPermanent = true;
                user.card.expiresAt = 0;
                user.card.durationMs = -1;
                user.card.days = -1;
            }
        } else {
            user.isPermanent = false;
            user.expiresAt = expiresAtMs;
            if (user.card) {
                user.card.isPermanent = false;
                user.card.expiresAt = expiresAtMs;
            }
        }
    }
    if (accountLimit !== undefined && accountLimit !== null) {
        if (accountLimit < -1) return { ok: false, error: '账号上限无效' };
        user.accountLimit = accountLimit;
    }
    saveUsers();
    return { ok: true };
}

function effectiveAccountLimit(user?: User): number {
    if (!user) return DEFAULT_ACCOUNT_LIMIT;
    if (user.accountLimit === -1) return -1;
    if (!user.accountLimit || user.accountLimit <= 0) return DEFAULT_ACCOUNT_LIMIT;
    return user.accountLimit;
}

function userExpired(user?: User): boolean {
    if (!user) return true;
    if (user.role === 'admin' || user.role === 'super_admin' || user.isPermanent) return false;
    let exp = user.expiresAt || 0;
    if (!exp && user.card) {
        if (user.card.isPermanent) return false;
        exp = user.card.expiresAt || 0;
    }
    if (!exp) return false;
    return Date.now() > exp;
}

// ---------- 卡密领取 / 管理 ----------

function getCardClaimStatus(): { enabled: boolean } {
    return { enabled: cardClaimEnabled };
}

function setCardClaimStatus(enabled: boolean): void {
    cardClaimEnabled = !!enabled;
    saveCardClaimRecords();
}

function getAvailableTimeCardCount(): number {
    return cards.filter(c => c.type === 'time' && !c.usedBy && c.enabled).length;
}

// ip 可选（老调用方兼容）。防刷同时绑定 IP 与 header UA：任一维度在 24h 内领过即拒绝，
// 攻击者单独更换 UA（或单独更换 IP）都无法绕过。
function claimCardByUA(ua: string, username?: string, ip?: string): { ok: boolean; error?: string; cardCode?: string; days?: number; durationMs?: number } {
    if (!cardClaimEnabled) return { ok: false, error: '卡密领取功能未开启' };
    const uaValue = String(ua || 'default');
    const ipValue = String(ip || '').trim();
    const hash = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
    // 新 key 绑定 IP/UA 维度；同时兼容旧版本仅按 UA hash 存的记录，避免升级后 24h 内重复领取。
    const keys = [hash(`ua|${uaValue}`), hash(uaValue)];
    if (ipValue) keys.push(hash(`ip|${ipValue}`));
    for (const key of keys) {
        const record = cardClaimRecords[key];
        if (record && Date.now() - record.claimTime < DAY_MS) {
            const remaining = DAY_MS - (Date.now() - record.claimTime);
            return { ok: false, error: `您已经在24小时内领取过一次卡密了！还剩 ${Math.ceil(remaining / 1000)} 秒` };
        }
    }
    const available = cards.filter(c => c.type === 'time' && !c.usedBy && c.enabled);
    if (available.length === 0) return { ok: false, error: '卡密库存不足，请联系管理员！' };
    const card = available[0];
    const now = Date.now();
    for (const key of keys) cardClaimRecords[key] = { uaHash: key, claimTime: now, cardCode: card.code, username };
    saveCardClaimRecords();
    return { ok: true, cardCode: card.code, days: card.days, durationMs: card.durationMs };
}

function getCardClaimRecords(): CardClaimRecord[] {
    return Object.values(cardClaimRecords);
}

function getAllCards(): Card[] {
    return cards.map(c => ({ ...c }));
}

function generateCards(count: number, description: string, durationMs: number): { ok: boolean; error?: string; codes?: string[] } {
    if (count <= 0 || count > 1000) return { ok: false, error: '生成数量必须在 1-1000 之间' };
    const now = Date.now();
    const days = durationMs > 0 ? Math.floor(durationMs / DAY_MS) : 0;
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
        const code = generateCardCode();
        cards.push({ code, description: String(description || ''), type: 'time', enabled: true, createdAt: now, days, durationMs, isPermanent: false });
        codes.push(code);
    }
    saveCards();
    return { ok: true, codes };
}

function generateQuotaCards(count: number, description: string, value: number): { ok: boolean; error?: string; codes?: string[] } {
    if (count <= 0 || count > 1000) return { ok: false, error: '生成数量必须在 1-1000 之间' };
    const add = value > 0 ? Math.floor(value) : 1;
    const now = Date.now();
    const desc = String(description || '').trim() || `额度卡密 +${add} 账号`;
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
        const code = generateCardCode();
        cards.push({ code, description: desc, type: 'quota', enabled: true, createdAt: now, value: add });
        codes.push(code);
    }
    saveCards();
    return { ok: true, codes };
}

function toggleCards(codes: string[], enabled: boolean): void {
    const want = new Set((codes || []).map(String));
    for (const card of cards) if (want.has(card.code)) card.enabled = !!enabled;
    saveCards();
}

function deleteCards(codes: string[]): number {
    const want = new Set((codes || []).filter(Boolean).map(String));
    if (want.size === 0) return 0;
    const before = cards.length;
    const kept = cards.filter(c => !want.has(c.code));
    cards = kept;
    saveCards();
    return before - kept.length;
}

// ---------- Token 管理 ----------

function newUserToken(username: string): string {
    const token = crypto.randomBytes(32).toString('hex');
    userTokens.set(token, { username, expiresAt: Date.now() + USER_TOKEN_TTL });
    return token;
}

function getUserByToken(token: string): User | undefined {
    if (!token) return undefined;
    const meta = userTokens.get(token);
    if (!meta) return undefined;
    if (Date.now() > meta.expiresAt) {
        userTokens.delete(token);
        return undefined;
    }
    return getUserByUsername(meta.username);
}

function validateUserToken(token: string): { ok: boolean; user?: AuthResult; error?: string } {
    const user = getUserByToken(token);
    if (!user) return { ok: false, error: 'token 无效或已过期' };
    if (userExpired(user)) return { ok: false, error: '账号已过期，请使用卡密续费' };
    return { ok: true, user: buildAuthResult(user) };
}

function getAuthResultByToken(token: string): AuthResult | undefined {
    const user = getUserByToken(token);
    return user ? buildAuthResult(user) : undefined;
}

function revokeUserToken(token: string): void {
    userTokens.delete(token);
}

// 撤销某个用户名下的全部 token，返回被撤销的 token 列表，便于上层同步清理 ctx 与断开 socket。
function revokeUserTokens(username: string): string[] {
    const name = String(username || '');
    const revoked: string[] = [];
    if (!name) return revoked;
    for (const [token, meta] of userTokens) {
        if (meta.username === name) {
            userTokens.delete(token);
            revoked.push(token);
        }
    }
    return revoked;
}

// ---------- 账号归属 / 配额 ----------

function countAccountsByUsername(username: string, accounts: any[]): number {
    return accounts.filter(a => String(a.username || '') === username).length;
}

function ensureAccountQuota(username: string, accounts: any[]): { ok: boolean; error?: string } {
    if (!username) return { ok: true };
    const user = getUserByUsername(username);
    if (!user) return { ok: true };
    const limit = effectiveAccountLimit(user);
    if (limit !== -1 && countAccountsByUsername(username, accounts) >= limit) {
        return { ok: false, error: '已达账号上限，请使用额度卡密提升上限' };
    }
    return { ok: true };
}

function isAccountAccessible(user: AuthResult | undefined, account: any): boolean {
    if (!user || !account) return false;
    if (user.role === 'admin') return true;
    return String(account.username || '') === user.username;
}

function visibleAccounts(user: AuthResult | undefined, accounts: any[]): any[] {
    if (!user) return [];
    if (user.role === 'admin') return accounts;
    return accounts.filter(a => String(a.username || '') === user.username);
}

initUserStore();

module.exports = {
    // 生命周期
    initUserStore,
    // 认证
    validateUser,
    registerUser,
    renewUser,
    // 用户管理
    getAllUsers,
    getUserByUsername,
    getUserRole,
    adminCreateUser,
    deleteUser,
    changeUserPassword,
    adminChangeUserPassword,
    updateUserLimits,
    effectiveAccountLimit,
    userExpired,
    // Token
    newUserToken,
    getUserByToken,
    validateUserToken,
    getAuthResultByToken,
    revokeUserToken,
    revokeUserTokens,
    // 卡密
    getCardClaimStatus,
    setCardClaimStatus,
    getAvailableTimeCardCount,
    claimCardByUA,
    getCardClaimRecords,
    getAllCards,
    generateCards,
    generateQuotaCards,
    toggleCards,
    deleteCards,
    // 归属/配额
    countAccountsByUsername,
    ensureAccountQuota,
    isAccountAccessible,
    visibleAccounts,
    DEFAULT_ACCOUNT_LIMIT,
};
