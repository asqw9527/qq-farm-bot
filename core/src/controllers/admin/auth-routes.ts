import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const { version } = require('../../../package.json');
const { getRuntimeConfig } = require('../../config/config');
const { getSchedulerRegistrySnapshot } = require('../../services/scheduler');
const { createModuleLogger } = require('../../services/logger');
const adminStore = require('../../models/admin-store');
const userStore = require('../../models/user-store');
const { getActiveWebBuildId } = require('./web-version');

const {
    getClientIp,
    issueToken,
    createAuthRequired,
    getAccId,
    handleApiError,
    revokeUserSessions,
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

        const role = String(result.role || 'admin');
        // 普通用户改用 user-store 签发的 token（带 24h TTL），
        // 使账号到期即时失效逻辑能在中间件中统一校验；管理员沿用原 token。
        const token = role === 'admin' || role === 'super_admin'
            ? issueToken()
            : userStore.newUserToken(result.username);
        ctx.tokens.add(token);
        const authResult = {
            username: result.username,
            role,
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
        const result = username === 'admin'
            ? adminStore.changePassword(String(oldPassword), String(newPassword))
            : userStore.changeUserPassword(username, String(oldPassword), String(newPassword));
        if (result.ok) {
            // 只撤销当前用户的会话（含其所有设备与 socket），不再清空全局 token 影响其他用户。
            revokeUserSessions(ctx, username);
        }
        return res.json({ ok: result.ok, error: result.error, message: result.ok ? '密码修改成功，请重新登录' : undefined });
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
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version, webBuildId: getActiveWebBuildId() } });
    });

    app.get('/api/game-version', async (_req: Request, res: Response) => {
        const { clientVersion, wxClientVersion } = getRuntimeConfig();
        const { getServiceSummary } = require('../../session/ipc');
        res.json({ ok: true, clientVersion, wxClientVersion, botVersion: version, serviceSummary: await getServiceSummary() });
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
