import type { Application } from 'express';
import type { Server } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
import type { PersistentTokenSet } from './session-tokens';
export {};

/**
 * AdminContext factory
 * Creates and holds all shared state for the admin server.
 */

const { createPersistentTokenSet } = require('./session-tokens');

export interface AdminContext {
    // 持久化会话集合（SHA256 哈希落盘 + 凭据指纹绑定 + TTL）。
    // 接口兼容原 Set：add/has/delete/clear/size，供本地多用户与上游会话托管共用。
    tokens: Set<string> | PersistentTokenSet;
    // token -> 当前登录用户（AuthResult）。旧 token 无对应用户时按 admin 兼容处理。
    // 本地多用户体系保留：普通用户的权限校验、账号归属隔离依赖该映射。
    tokenUsers: Map<string, any>;
    app: Application | null;
    server: Server | null;
    io: SocketIOServer | null;
    provider: any;
}

function createAdminContext(dataProvider: any): AdminContext {
    const tokens = createPersistentTokenSet();
    // 多用户体系需要 token->用户映射；持久化 token 只负责有效性，不负责身份。
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
