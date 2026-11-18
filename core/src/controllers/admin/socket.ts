/**
 * Socket.IO setup and realtime emit functions.
 */
import type { AdminContext } from './context';
export {};

const { Server } = require('socket.io');
const SocketIOServer = Server;
const userStore = require('../../models/user-store');

const {
    resolveAccId,
    getVisibleAccountLogs,
    getVisibleLogs,
} = require('./middleware');

// 由 socket token 还原当前用户，构造与 HTTP 中间件一致的轻量 req。
function socketRequest(ctx: AdminContext, socket: any): any {
    const token = String(socket.data.adminToken || '');
    let currentUser = ctx.tokenUsers && token ? ctx.tokenUsers.get(token) : undefined;
    if (!currentUser && token) {
        const resolvedUser = userStore.getAuthResultByToken(token);
        if (resolvedUser) currentUser = resolvedUser;
    }
    if (!currentUser) currentUser = { username: 'admin', role: 'admin', accountLimit: -1 };
    return { currentUser, headers: {} };
}

// 按 socket 所属用户的可见范围，向 account:all 房间逐个推送运行日志快照。
function emitAllLogsSnapshot(ctx: AdminContext): void {
    if (!ctx.io || !ctx.provider || typeof ctx.provider.getLogs !== 'function') return;
    const room = ctx.io.sockets.sockets;
    for (const socket of room.values()) {
        if (!socket.rooms.has('account:all')) continue;
        const logs = getVisibleLogs(ctx, socketRequest(ctx, socket), '', { limit: 100 });
        socket.emit('logs:snapshot', { accountId: 'all', logs });
    }
}

function applySocketSubscription(ctx: AdminContext, socket: any, accountRef: string = ''): void {
    const reqLike = socketRequest(ctx, socket);
    const incoming = String(accountRef || '').trim();
    const resolved = incoming && incoming !== 'all' ? resolveAccId(ctx, incoming, reqLike) : '';

    for (const room of socket.rooms) {
        if (room.startsWith('account:')) socket.leave(room);
    }
    if (resolved) {
        socket.join(`account:${resolved}`);
        socket.data.accountId = resolved;
    } else {
        socket.join('account:all');
        socket.data.accountId = '';
    }
    socket.emit('subscribed', { accountId: socket.data.accountId || 'all' });

    try {
        const targetId = socket.data.accountId || '';
        if (targetId && ctx.provider && typeof ctx.provider.getStatus === 'function') {
            const currentStatus = ctx.provider.getStatus(targetId);
            socket.emit('status:update', { accountId: targetId, status: currentStatus });
        }
        // 日志快照按当前用户可见范围过滤；普通用户订阅 all 时只收到自己账号的日志。
        const currentLogs = getVisibleLogs(ctx, reqLike, targetId, { limit: 100 });
        socket.emit('logs:snapshot', {
            accountId: targetId || 'all',
            logs: currentLogs,
        });

        const currentAccountLogs = getVisibleAccountLogs(ctx, reqLike, 100);
        socket.emit('account-logs:snapshot', {
            logs: currentAccountLogs,
        });
    } catch {
        // ignore snapshot push errors
    }
}

// 巡检已连接的 socket：普通用户 token 到期或卡密失效时，从 ctx 移除并主动断开连接。
// 导出以便测试直接调用，无需等待定时器。
function enforceSocketTokenExpiry(ctx: AdminContext): number {
    let disconnected = 0;
    try {
        const sockets = ctx.io && (ctx.io as any).sockets && (ctx.io as any).sockets.sockets;
        if (!sockets || typeof sockets.values !== 'function') return 0;
        for (const socket of sockets.values()) {
            const token = String((socket as any).data?.adminToken || '');
            if (!token) continue;
            const user = ctx.tokenUsers && ctx.tokenUsers.get(token)
                || userStore.getAuthResultByToken(token);
            if (!user || user.role === 'admin' || user.role === 'super_admin') continue;
            const validated = userStore.validateUserToken(token);
            if (!validated.ok) {
                ctx.tokens.delete(token);
                if (ctx.tokenUsers) ctx.tokenUsers.delete(token);
                try {
                    (socket as any).disconnect(true);
                    disconnected++;
                } catch {}
            }
        }
    } catch {
        // ignore watchdog errors
    }
    return disconnected;
}

function setupSocketIO(ctx: AdminContext): void {
    ctx.io = new SocketIOServer(ctx.server as any, {
        path: '/socket.io',
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            allowedHeaders: ['x-admin-token', 'x-account-id'],
        },
    });

    ctx.io.use((socket: any, next: (err?: Error) => void) => {
        const authToken = socket.handshake.auth && socket.handshake.auth.token
            ? String(socket.handshake.auth.token)
            : '';
        const headerToken = socket.handshake.headers && socket.handshake.headers['x-admin-token']
            ? String(socket.handshake.headers['x-admin-token'])
            : '';
        const token = authToken || headerToken;
        if (!token || !ctx.tokens.has(token)) {
            return next(new Error('Unauthorized'));
        }
        // 普通用户 token 需与 HTTP 保持一致的实时校验（到期/卡密失效即时断连）。
        const resolvedUser = ctx.tokenUsers && ctx.tokenUsers.get(token)
            || userStore.getAuthResultByToken(token);
        if (resolvedUser && resolvedUser.role !== 'admin' && resolvedUser.role !== 'super_admin') {
            const validated = userStore.validateUserToken(token);
            if (!validated.ok) {
                ctx.tokens.delete(token);
                return next(new Error('Unauthorized'));
            }
        }
        socket.data.adminToken = token;
        return next();
    });

    ctx.io.on('connection', (socket: any) => {
        const initialAccountRef = (socket.handshake.auth && socket.handshake.auth.accountId)
            || (socket.handshake.query && socket.handshake.query.accountId)
            || '';
        applySocketSubscription(ctx, socket, initialAccountRef);
        socket.emit('ready', { ok: true, ts: Date.now() });

        socket.on('subscribe', (payload: any) => {
            const body = (payload && typeof payload === 'object') ? payload : {};
            applySocketSubscription(ctx, socket, body.accountId || '');
        });
    });

    // 定时巡检：普通用户的 token 到期或卡密失效后，主动断开其已建立的连接。
    // 与 HTTP 每请求校验保持一致，避免到期后旧连接继续接收实时数据。
    const timer = setInterval(() => { enforceSocketTokenExpiry(ctx); }, 30_000);
    // 不阻止进程退出
    if (typeof timer.unref === 'function') timer.unref();
}

function emitRealtimeStatus(ctx: AdminContext, accountId: string, status: any): void {
    if (!ctx.io) return;
    const id = String(accountId || '').trim();
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    ctx.io.to(`account:${id}`).emit('status:update', { accountId: id, status });
}

function emitRealtimeLog(ctx: AdminContext, entry: any): void {
    if (!ctx.io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();

    // 如果没有指定账号ID，不推送给任何人（防止数据泄露）
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    ctx.io.to(`account:${id}`).emit('log:new', payload);
}

function emitRealtimeAccountLog(ctx: AdminContext, entry: any): void {
    if (!ctx.io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();

    // 如果没有指定账号ID，不推送给任何人（防止数据泄露）
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    ctx.io.to(`account:${id}`).emit('account-log:new', payload);
}

module.exports = {
    setupSocketIO,
    enforceSocketTokenExpiry,
    emitAllLogsSnapshot,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
