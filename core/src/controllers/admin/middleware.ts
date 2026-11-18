import type { NextFunction, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const crypto = require('node:crypto');
const store = require('../../models/store');
const userStore = require('../../models/user-store');
const { normalizeAccountRef, resolveAccountId } = require('../../services/account-resolver');

interface AuthenticatedRequest extends Request {
    adminToken?: string;
    currentUser?: any;
}

function getClientIp(req: Request): string {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return String(cfIp).trim();
    const realIp = req.headers['x-real-ip'];
    if (realIp) return String(realIp).trim();
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const first = String(forwarded).split(',').map(item => item.trim()).find(Boolean);
        if (first) return first;
    }
    const address = req.ip || (req as any).connection?.remoteAddress || req.socket?.remoteAddress;
    return String(address || 'unknown').replace(/^::ffff:/, '');
}

const issueToken = (): string => crypto.randomBytes(24).toString('hex');

function createAuthRequired(ctx: AdminContext) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        // 支持 x-admin-token（原前端）与 Authorization: Bearer（多用户前端）两种传递方式
        let token = String(req.headers['x-admin-token'] || '').trim();
        if (!token) {
            const auth = String(req.headers['authorization'] || '').trim();
            if (/^Bearer\s+/i.test(auth)) token = auth.replace(/^Bearer\s+/i, '').trim();
        }
        if (!token || !ctx.tokens.has(token)) {
            res.status(401).json({ ok: false, error: 'Unauthorized' });
            return;
        }
        req.adminToken = token;
        // 解析当前登录用户；兼容旧 token（无映射）按超级管理员处理
        let currentUser = ctx.tokenUsers && ctx.tokenUsers.get(token);
        if (!currentUser) {
            const resolved = userStore.getAuthResultByToken(token);
            if (resolved) currentUser = resolved;
        }
        if (!currentUser) currentUser = { username: 'admin', role: 'admin', accountLimit: -1 };
        // 普通用户每次请求实时校验：token 24h 过期、卡密到期、账号删除/额度变更即时失效。
        // 管理员 token 无 TTL 且不受卡密约束，沿用缓存逻辑保持兼容。
        if (currentUser.role !== 'admin' && currentUser.role !== 'super_admin') {
            const validated = userStore.validateUserToken(token);
            if (!validated.ok) {
                res.status(401).json({ ok: false, error: validated.error || '登录已失效', errorType: 'expired' });
                return;
            }
            req.currentUser = validated.user;
            next();
            return;
        }
        req.currentUser = currentUser;
        next();
    };
}

// 撤销指定用户名下的所有会话：user-store token、ctx 映射，以及对应的 Socket 连接。
// 用于改密、管理员重置密码、删除用户等场景，确保旧会话不再可用。
function revokeUserSessions(ctx: AdminContext, username: string): string[] {
    const name = String(username || '');
    if (!name) return [];
    const toDisconnect = new Set<string>(userStore.revokeUserTokens(name));
    for (const [token, user] of (ctx.tokenUsers ? ctx.tokenUsers.entries() : [])) {
        if (String((user as any)?.username || '') === name) toDisconnect.add(token);
    }
    for (const token of toDisconnect) {
        ctx.tokens.delete(token);
        if (ctx.tokenUsers) ctx.tokenUsers.delete(token);
    }
    // 断开这些 token 对应的实时连接
    const sockets = ctx.io && (ctx.io as any).sockets && (ctx.io as any).sockets.sockets;
    if (sockets && typeof sockets.values === 'function') {
        for (const socket of sockets.values()) {
            const token = String((socket as any).data?.adminToken || '');
            if (token && toDisconnect.has(token)) {
                try { (socket as any).disconnect(true); } catch {}
            }
        }
    }
    return Array.from(toDisconnect);
}

function isAdminUser(req: AuthenticatedRequest): boolean {
    const user = req.currentUser;
    return !!user && (user.role === 'admin' || user.role === 'super_admin');
}

function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    if (!isAdminUser(req)) {
        res.status(403).json({ ok: false, error: '仅管理员可访问该设置' });
        return;
    }
    next();
}

// 当前用户可见的账号列表：管理员可见全部，普通用户仅可见归属自己的账号（含未绑定旧账号）
function getAccountList(ctx: AdminContext, req?: AuthenticatedRequest): any[] {
    let accounts: any[];
    try {
        if (ctx.provider && typeof ctx.provider.getAccounts === 'function') {
            const data = ctx.provider.getAccounts();
            if (Array.isArray(data?.accounts)) accounts = data.accounts;
            else accounts = [];
        } else {
            accounts = [];
        }
    } catch {
        const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
        accounts = Array.isArray(data.accounts) ? data.accounts : [];
    }
    if (req && req.currentUser && !isAdminUser(req)) {
        const username = String(req.currentUser.username || '');
        // 严格归属隔离：普通用户仅可见自己添加的账号。
        // 无归属（旧账号）仅管理员可见，避免普通用户看到/操作管理员的农场。
        accounts = accounts.filter((a: any) => String(a.username || '') === username);
    }
    // 敏感凭据只落盘、不出后端：loginBuffer 可无限换新 Code，napCatKey 等于
    // NapCat 控制权。前端需要的是 wxid/napCatBase/appId 等非密配置。
    return accounts.map((account: any) => {
        if (!account || typeof account !== 'object') return account;
        const { loginBuffer, napCatKey, ...safe } = account;
        return safe;
    });
}

function getAccountIds(ctx: AdminContext, req?: AuthenticatedRequest): string[] {
    return getAccountList(ctx, req).map((account: any) => String(account.id || '')).filter(Boolean);
}

// 账号操作日志：普通用户仅可见归属自己账号的日志；管理员可见全部。
function getVisibleAccountLogs(ctx: AdminContext, req: AuthenticatedRequest | undefined, limit: number): any[] {
    let list: any[] = [];
    if (ctx.provider && typeof ctx.provider.getAccountLogs === 'function') {
        const data = ctx.provider.getAccountLogs(limit);
        if (Array.isArray(data)) list = data;
    }
    if (!req || !req.currentUser || isAdminUser(req)) return list;
    const ids = new Set(getAccountIds(ctx, req));
    return list.filter(entry => ids.has(String(entry?.accountId || '')));
}

// 运行日志快照：accountId 为空表示"全部账号"。普通用户按可见账号逐账号取日志再合并，
// 避免 provider.getLogs('') 直接返回全局日志造成跨用户泄露。
function getVisibleLogs(ctx: AdminContext, req: AuthenticatedRequest | undefined, accountId: string, options: any = {}): any[] {
    if (!ctx.provider || typeof ctx.provider.getLogs !== 'function') return [];
    if (accountId) {
        const data = ctx.provider.getLogs(accountId, options);
        return Array.isArray(data) ? data : [];
    }
    if (!req || !req.currentUser || isAdminUser(req)) {
        const data = ctx.provider.getLogs('', options);
        return Array.isArray(data) ? data : [];
    }
    const limit = Number(options.limit) || 100;
    const merged: any[] = [];
    for (const id of getAccountIds(ctx, req)) {
        const data = ctx.provider.getLogs(id, { ...options, limit });
        if (Array.isArray(data)) merged.push(...data);
    }
    merged.sort((a: any, b: any) => (Number(b.ts || 0) - Number(a.ts || 0)) || String(b.time || '').localeCompare(String(a.time || '')));
    return merged.slice(0, limit);
}

const isSoftRuntimeError = (err: any): boolean => {
    const message = String(typeof err === 'string' ? err : err?.message || '');
    return message === '账号未运行' || message === 'API Timeout';
};

function isGatewayProtocolError(err: any): boolean {
    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    return String(err?.name || '') === 'GatewayError'
        || typeof err?.errorMessage === 'string'
        || typeof err?.error_message === 'string'
        || /^(?:[\w-]+\.)+[\w-]+(?:\s+.*?)?\bcode=\d+(?:\s|$)/.test(message);
}

function getProtocolErrorMessage(err: any): string {
    const direct = String(err?.errorMessage || err?.error_message || '').trim();
    if (direct) return direct;

    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    if (!isGatewayProtocolError(err)) return '';
    return message.match(/\bcode=\d+\b\s*(.*)$/)?.[1]?.trim() || '';
}

function handleApiError(res: Response, err: any): void {
    const protocolMessage = getProtocolErrorMessage(err);
    const payload: any = {
        ok: false,
        error: protocolMessage || (typeof err === 'string' ? err : err?.message) || 'Unknown error',
    };
    if (protocolMessage) payload.errorMessage = protocolMessage;
    const errorCode = Number(err?.code);
    if (Number.isFinite(errorCode) && errorCode !== 0) payload.errorCode = errorCode;
    if (isSoftRuntimeError(err) || isGatewayProtocolError(err)) {
        res.json(payload);
        return;
    }
    res.status(500).json(payload);
}

function resolveAccId(ctx: AdminContext, rawRef: any, req?: AuthenticatedRequest): string {
    const input = normalizeAccountRef(rawRef);
    if (!input) return '';
    // 非管理员只从「可见账号列表」解析，杜绝 provider 解析与 fallback 绕过归属隔离。
    // 找不到时返回空串，调用方据此判定无权访问该账号。
    if (req && req.currentUser && !isAdminUser(req)) {
        return resolveAccountId(getAccountList(ctx, req), input);
    }
    if (ctx.provider && typeof ctx.provider.resolveAccountId === 'function') {
        const resolvedByProvider = normalizeAccountRef(ctx.provider.resolveAccountId(input));
        if (resolvedByProvider) return resolvedByProvider;
    }
    return resolveAccountId(getAccountList(ctx, req), input) || input;
}

function getAccId(ctx: AdminContext, req: AuthenticatedRequest): string {
    return resolveAccId(ctx, req.headers['x-account-id'], req);
}

function buildKnownFriendGidSettings(accountId: string): {
    knownFriendGids: any[];
    knownFriendGidSyncCooldownSec: number;
    friendsListCacheTtlSec: number;
} {
    return {
        knownFriendGids: store.getKnownFriendGids ? store.getKnownFriendGids(accountId) : [],
        knownFriendGidSyncCooldownSec: store.getKnownFriendGidSyncCooldownSec
            ? store.getKnownFriendGidSyncCooldownSec(accountId)
            : 600,
        friendsListCacheTtlSec: store.getFriendsListCacheTtlSec
            ? store.getFriendsListCacheTtlSec(accountId)
            : 60,
    };
}

module.exports = {
    getClientIp,
    issueToken,
    createAuthRequired,
    isAdminUser,
    revokeUserSessions,
    requireAdmin,
    getAccountList,
    getAccountIds,
    getVisibleAccountLogs,
    getVisibleLogs,
    isSoftRuntimeError,
    isGatewayProtocolError,
    getProtocolErrorMessage,
    handleApiError,
    resolveAccId,
    getAccId,
    buildKnownFriendGidSettings,
};
