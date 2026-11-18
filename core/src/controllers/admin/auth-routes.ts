import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const { version } = require('../../../package.json');
const { getRuntimeConfig } = require('../../config/config');
const { getSchedulerRegistrySnapshot } = require('../../services/scheduler');
const { createModuleLogger } = require('../../services/logger');
const adminStore = require('../../models/admin-store');
const userStore = require('../../models/user-store');

const {
    getClientIp,
    issueToken,
    createAuthRequired,
    getAccId,
    handleApiError,
} = require('./middleware');

const adminLogger = createModuleLogger('admin');

function mountAuthRoutes(app: Application, ctx: AdminContext): void {
    const authRequired = createAuthRequired(ctx);

    app.post('/api/login', (req: Request, res: Response) => {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(401).json({ ok: false, error: '请输入用户名和密码' });
        }

        const clientIp = getClientIp(req);
        const result = adminStore.validateAdmin(String(username), String(password), clientIp);
        if (result?.error) {
            const statusCode = result.error === 'rate_limit' ? 429 : result.error === 'locked' ? 423 : 401;
            adminLogger.warn('登录失败', { username, error: result.error, ip: clientIp });
            return res.status(statusCode).json({
                ok: false,
                error: result.message,
                errorType: result.error,
                remainingMs: result.remainingMs,
            });
        }

        const token = issueToken();
        ctx.tokens.add(token);
        const authResult = {
            username: result.username,
            role: result.role || 'admin',
            accountLimit: result.accountLimit,
            expiresAt: result.expiresAt,
            isPermanent: result.isPermanent,
        };
        if (ctx.tokenUsers) ctx.tokenUsers.set(token, authResult);
        adminLogger.info('用户登录成功', { username: result.username, role: authResult.role, ip: clientIp });
        return res.json({
            ok: true,
            data: {
                token,
                role: authResult.role,
                user: { username: result.username, role: authResult.role },
                mustChangePassword: result.mustChangePassword === true,
            },
        });
    });

    app.post('/api/user/change-password', authRequired, (req: Request, res: Response) => {
        const { oldPassword, newPassword } = req.body || {};
        if (!oldPassword || !newPassword) {
            return res.status(400).json({ ok: false, error: '请提供原密码和新密码' });
        }
        const username = String((req as any).currentUser?.username || 'admin');
        const result = userStore.changeUserPassword(username, String(oldPassword), String(newPassword));
        if (result.ok) {
            ctx.tokens.clear();
            if (ctx.tokenUsers) ctx.tokenUsers.clear();
        }
        return res.json({ ok: result.ok, error: result.error, message: result.ok ? '密码修改成功' : undefined });
    });

    // 免鉴权公开路径：登录、版本、注册/领卡/找回 等用户自助入口
    const publicApiPaths = new Set([
        '/login',
        '/game-version',
        '/users/login',
        '/users/register',
        '/users/claim-card',
        '/users/card-claim-status',
    ]);
    app.use('/api', (req: Request, res: Response, next: any) => {
        if (publicApiPaths.has(req.path)) return next();
        return authRequired(req, res, next);
    });

    app.get('/api/ping', (_req: Request, res: Response) => {
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version } });
    });

    app.get('/api/game-version', (_req: Request, res: Response) => {
        const { clientVersion, wxClientVersion } = getRuntimeConfig();
        res.json({ ok: true, clientVersion, wxClientVersion, botVersion: version });
    });

    app.get('/api/auth/validate', (_req: Request, res: Response) => {
        res.json({ ok: true, data: { valid: true } });
    });

    app.get('/api/scheduler', async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            if (ctx.provider && typeof ctx.provider.getSchedulerStatus === 'function') {
                const data = await ctx.provider.getSchedulerStatus(id);
                return res.json({ ok: true, data });
            }
            return res.json({
                ok: true,
                data: {
                    runtime: getSchedulerRegistrySnapshot(),
                    worker: null,
                    workerError: 'DataProvider does not support scheduler status',
                },
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/logout', (req: Request, res: Response) => {
        const token = (req as any).adminToken;
        if (token) {
            ctx.tokens.delete(token);
            if (ctx.tokenUsers) ctx.tokenUsers.delete(token);
            userStore.revokeUserToken(token);
        }
        if (ctx.io && token) {
            for (const socket of ctx.io.sockets.sockets.values()) {
                if (String((socket.data as any).adminToken || '') === String(token)) socket.disconnect(true);
            }
        }
        res.json({ ok: true });
    });

    app.get('/api/user/me', (req: Request, res: Response) => {
        const current = (req as any).currentUser;
        if (current) {
            return res.json({ ok: true, data: current });
        }
        res.json({ ok: true, data: adminStore.getAdminInfo() });
    });
}

module.exports = { mountAuthRoutes };
