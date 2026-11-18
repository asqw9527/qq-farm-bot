import type { Application } from 'express';
import type { Server } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
export {};

/**
 * AdminContext factory
 * Creates and holds all shared state for the admin server.
 */

export interface AdminContext {
    tokens: Set<string>;
    // token -> 当前登录用户（AuthResult）。旧 token 无对应用户时按 admin 兼容处理。
    tokenUsers: Map<string, any>;
    app: Application | null;
    server: Server | null;
    io: SocketIOServer | null;
    provider: any;
}

function createAdminContext(dataProvider: any): AdminContext {
    const tokens = new Set<string>();
    const tokenUsers = new Map<string, any>();
    return {
        tokens,
        tokenUsers,
        app: null,
        server: null,
        io: null,
        provider: dataProvider,
    };
}

module.exports = { createAdminContext };
