import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * 多用户体系 API，完整移植自 Go 项目 user_api.go。
 * 挂载在全局鉴权之后：公开路径已在 auth-routes 的 publicApiPaths 放行，
 * 其余路径需要经过 authRequired（req.currentUser 由中间件注入）。
 */
const userStore = require('../../models/user-store');

const {
    isAdminUser,
    handleApiError,
    getAccountList,
} = require('./middleware');

function currentUsername(req: Request): string {
    return String((req as any).currentUser?.username || '');
}

function mountUserRoutes(app: Application, ctx: AdminContext): void {

    // ---- 公开：用户注册 ----
    app.post('/api/users/register', (req: Request, res: Response) => {
        try {
            const { username, password, cardCode } = req.body || {};
            if (!username || !password) {
                return res.status(400).json({ ok: false, error: '用户名和密码不能为空' });
            }
            const result = userStore.registerUser(String(username), String(password), String(cardCode || ''));
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            return res.json({ ok: true, user: result.user });
        } catch (e: any) { return handleApiError(res, e); }
    });

    // ---- 公开：用户登录（返回 token，前端可改存 x-admin-token 或 Bearer）----
    app.post('/api/users/login', (req: Request, res: Response) => {
        try {
            const { username, password } = req.body || {};
            if (!username || !password) {
                return res.status(400).json({ ok: false, error: '用户名和密码不能为空' });
            }
            const ip = String(req.ip || (req as any).connection?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
            const result = userStore.validateUser(String(username), String(password), ip);
            if (!result.ok) {
                const status = result.errorType === 'rate_limit' ? 429
                    : (result.errorType === 'locked' || result.errorType === 'expired') ? 423 : 401;
                return res.status(status).json({ ok: false, error: result.error, errorType: result.errorType, remainingMs: result.remainingMs });
            }
            const token = userStore.newUserToken(result.user.username);
            ctx.tokens.add(token);
            if (ctx.tokenUsers) ctx.tokenUsers.set(token, result.user);
            return res.json({ ok: true, token, user: result.user });
        } catch (e: any) { return handleApiError(res, e); }
    });

    // ---- 公开：卡密领取状态 ----
    app.get('/api/users/card-claim-status', (_req: Request, res: Response) => {
        res.json({ ok: true, data: userStore.getCardClaimStatus() });
    });

    // ---- 公开：按 UA 领取卡密（24h 防刷）----
    app.post('/api/users/claim-card', (req: Request, res: Response) => {
        try {
            const { username, userAgent } = req.body || {};
            const ua = String(userAgent || req.headers['user-agent'] || 'default');
            const result = userStore.claimCardByUA(ua, username ? String(username) : undefined);
            res.json(result);
        } catch (e: any) { return handleApiError(res, e); }
    });

    // ---- 当前用户 ----
    app.get('/api/users/me', (req: Request, res: Response) => {
        const current = (req as any).currentUser;
        const detail = current ? {
            username: current.username,
            role: current.role,
            accountLimit: current.accountLimit,
            expiresAt: current.expiresAt,
            isPermanent: current.isPermanent,
            cardCode: current.cardCode,
        } : null;
        res.json({ ok: true, user: detail });
    });

    // ---- 用户续费（使用卡密）----
    app.post('/api/users/renew', (req: Request, res: Response) => {
        try {
            const { cardCode } = req.body || {};
            // 续费只作用于当前登录用户：body.username 一律忽略，禁止给他人账号续费。
            const username = currentUsername(req);
            if (!username || !cardCode) return res.status(400).json({ ok: false, error: '参数错误' });
            const result = userStore.renewUser(username, String(cardCode));
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            // 刷新当前 token 内缓存的用户信息
            const token = (req as any).adminToken;
            if (token && ctx.tokenUsers) {
                const u = userStore.getUserByUsername(username);
                if (u) ctx.tokenUsers.set(token, userStore.getAuthResultByToken(token) || ctx.tokenUsers.get(token));
            }
            res.json({ ok: true, message: result.message });
        } catch (e: any) { return handleApiError(res, e); }
    });

    // ---- 用户列表（管理员）----
    app.get('/api/users', (req: Request, res: Response) => {
        if (!isAdminUser(req)) return res.status(403).json({ ok: false, error: '请联系管理员' });
        try {
            const accounts = getAccountList(ctx);
            const byUser: Record<string, any[]> = {};
            const unbound: any[] = [];
            for (const acc of accounts) {
                const owner = String(acc.username || '');
                const summary = { id: acc.id, name: acc.name, platform: acc.platform, qq: acc.qq };
                if (!owner) { unbound.push(summary); continue; }
                (byUser[owner] ||= []).push(summary);
            }
            const users = userStore.getAllUsers().map((u: any) => ({
                ...u,
                accounts: byUser[u.username] || [],
            }));
            res.json({ ok: true, users, unboundAccounts: unbound });
        } catch (e: any) { return handleApiError(res, e); }
    });

    // ---- 管理员创建用户（免卡密，可指定上限/时长）----
    app.post('/api/users', (req: Request, res: Response) => {
        if (!isAdminUser(req)) return res.status(403).json({ ok: false, error: '请联系管理员' });
        try {
            const body = req.body || {};
            const { username, password } = body;
            if (!username || !password) return res.status(400).json({ ok: false, error: '用户名和密码不能为空' });
            const result = userStore.adminCreateUser(String(username), String(password), {
                accountLimit: body.accountLimit,
                days: body.days,
                permanent: body.permanent,
            });
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            return res.json({ ok: true, user: result.user });
        } catch (e: any) { return handleApiError(res, e); }
    });

    // ---- 删除用户（管理员）----
    app.post('/api/users/delete', (req: Request, res: Response) => {
        if (!isAdminUser(req)) return res.status(403).json({ ok: false, error: '请联系管理员' });
        try {
            const usernames = Array.isArray((req.body || {}).usernames)
                ? (req.body.usernames as any[]).map(String)
                : [String((req.body || {}).username || '')].filter(Boolean);
            for (const name of usernames) userStore.deleteUser(name);
            res.json({ ok: true });
        } catch (e: any) { return handleApiError(res, e); }
    });

    // ---- 管理员修改用户密码（不校验旧密码）----
    app.post('/api/users/admin-change-password', (req: Request, res: Response) => {
        if (!isAdminUser(req)) return res.status(403).json({ ok: false, error: '请联系管理员' });
        try {
            const { username, newPassword } = req.body || {};
            const result = userStore.adminChangeUserPassword(String(username || ''), String(newPassword || ''));
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            res.json({ ok: true });
        } catch (e: any) { return handleApiError(res, e); }
    });

    // ---- 管理员修改用户时长/上限 ----
    app.post('/api/admin/users', (req: Request, res: Response) => {
        if (!isAdminUser(req)) return res.status(403).json({ ok: false, error: '请联系管理员' });
        try {
            const body = req.body || {};
            const username = String(body.username || '');
            if (!username) return res.status(400).json({ ok: false, error: '请指定用户名' });
            let expiresAt = -1; // -1 表示不改
            if (body.permanent === true) expiresAt = 0;
            else if (body.expiresAt !== undefined && body.expiresAt !== null) expiresAt = Number(body.expiresAt);
            else if (body.days !== undefined && body.days !== null) {
                const days = Number(body.days);
                if (days < 0) return res.status(400).json({ ok: false, error: '天数无效' });
                expiresAt = days === 0 ? 0 : Date.now() + days * 24 * 60 * 60 * 1000;
            }
            const accountLimit = (body.accountLimit !== undefined && body.accountLimit !== null)
                ? Number(body.accountLimit) : undefined;
            const result = userStore.updateUserLimits(username, expiresAt, accountLimit);
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            if (body.password) {
                const pwResult = userStore.adminChangeUserPassword(username, String(body.password));
                if (!pwResult.ok) return res.status(400).json({ ok: false, error: pwResult.error });
            }
            res.json({ ok: true });
        } catch (e: any) { return handleApiError(res, e); }
    });

    // ---- 卡密列表（管理员）----
    app.get('/api/admin/cards', (req: Request, res: Response) => {
        if (!isAdminUser(req)) return res.status(403).json({ ok: false, error: '请联系管理员' });
        res.json({ ok: true, cards: userStore.getAllCards() });
    });

    // ---- 卡密管理（管理员）：生成 / 启用禁用 / 删除 ----
    app.post('/api/admin/cards', (req: Request, res: Response) => {
        if (!isAdminUser(req)) return res.status(403).json({ ok: false, error: '请联系管理员' });
        try {
            const body = req.body || {};
            const action = String(body.action || '');
            if (action === 'generate') {
                const count = Number(body.count) > 0 ? Number(body.count) : 10;
                const cardType = String(body.cardType || 'time');
                let result;
                if (cardType === 'quota') {
                    result = userStore.generateQuotaCards(count, String(body.description || ''), Number(body.value) || 1);
                } else {
                    const days = Number(body.days) > 0 ? Number(body.days) : 30;
                    result = userStore.generateCards(count, String(body.description || ''), days * 24 * 60 * 60 * 1000);
                }
                if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
                return res.json({ ok: true, codes: result.codes });
            }
            if (action === 'toggle') {
                const codes = Array.isArray(body.codes) ? body.codes.map(String) : [];
                if (!codes.length || body.enabled === undefined) {
                    return res.status(400).json({ ok: false, error: '请指定卡密和启用状态' });
                }
                userStore.toggleCards(codes, !!body.enabled);
                return res.json({ ok: true });
            }
            if (action === 'delete') {
                const codes = Array.isArray(body.codes) ? body.codes.map(String) : [];
                if (!codes.length) return res.status(400).json({ ok: false, error: '请指定卡密' });
                const deleted = userStore.deleteCards(codes);
                return res.json({ ok: true, deleted });
            }
            return res.status(400).json({ ok: false, error: '未知操作' });
        } catch (e: any) { return handleApiError(res, e); }
    });

    // ---- 管理员总览：用户 + 账号归属 + 未绑定账号 ----
    app.get('/api/admin/users-overview', (req: Request, res: Response) => {
        if (!isAdminUser(req)) return res.status(403).json({ ok: false, error: '请联系管理员' });
        try {
            const accounts = getAccountList(ctx);
            const byUser: Record<string, any[]> = {};
            const unbound: any[] = [];
            for (const acc of accounts) {
                const owner = String(acc.username || '');
                const info = {
                    id: acc.id, name: acc.name, platform: acc.platform,
                    qq: acc.qq, uin: acc.uin, status: acc.status,
                };
                if (!owner) { unbound.push(info); continue; }
                (byUser[owner] ||= []).push(info);
            }
            const users = userStore.getAllUsers().map((u: any) => ({ ...u, accounts: byUser[u.username] || [] }));
            res.json({ ok: true, users, unboundAccounts: unbound });
        } catch (e: any) { return handleApiError(res, e); }
    });
}

module.exports = { mountUserRoutes };
