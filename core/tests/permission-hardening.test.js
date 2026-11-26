/**
 * 本轮权限修复的回归测试：
 * - 普通用户读取账号操作日志时只能看到自己账号的记录
 * - 普通用户订阅 all 的运行日志快照只包含自己账号的日志
 * - QQ 登录任务按 owner 隔离，旧任务在新建任务后作废
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');
const middleware = require(path.join(DIST, 'controllers', 'admin', 'middleware.js'));

const ALL_ACCOUNTS = [
    { id: 'acc-admin', name: '管理员账号', username: 'admin' },
    { id: 'acc-jmy', name: 'jmy 账号', username: 'jmy' },
    { id: 'acc-alice', name: 'alice 账号', username: 'alice' },
];
const ADMIN = { username: 'admin', role: 'admin' };
const JMY = { username: 'jmy', role: 'user' };

function makeCtx(logs) {
    return {
        provider: {
            getAccounts: () => ({ accounts: JSON.parse(JSON.stringify(ALL_ACCOUNTS)) }),
            getAccountLogs: () => JSON.parse(JSON.stringify(logs)),
            getLogs: (id, options = {}) => {
                const limit = Number(options.limit) || 100;
                if (!id) return logs.slice(0, limit);
                return logs.filter(item => item.accountId === id).slice(0, limit);
            },
        },
    };
}

const accountLogs = [
    { action: 'start', accountId: 'acc-admin', msg: 'admin 启动' },
    { action: 'start', accountId: 'acc-jmy', msg: 'jmy 启动' },
    { action: 'delete', accountId: 'acc-alice', msg: 'alice 删除' },
    { action: 'system', accountId: '', msg: '系统事件' },
];

// 1) 普通用户账号操作日志仅包含自己账号
{
    const list = middleware.getVisibleAccountLogs(makeCtx(accountLogs), { currentUser: JMY, headers: {} }, 100);
    assert.deepEqual(list.map(item => item.accountId), ['acc-jmy']);
    console.log('ok 1 - 普通用户仅见自己账号的操作日志');
}

// 2) 管理员可见全部账号操作日志（含系统事件）
{
    const list = middleware.getVisibleAccountLogs(makeCtx(accountLogs), { currentUser: ADMIN, headers: {} }, 100);
    assert.equal(list.length, 4);
    console.log('ok 2 - 管理员可见全部账号操作日志');
}

// 3) 普通用户订阅 all 的运行日志仅包含自己账号
{
    const logs = [
        { accountId: 'acc-admin', msg: 'admin', ts: 300 },
        { accountId: 'acc-jmy', msg: 'jmy', ts: 200 },
        { accountId: 'acc-alice', msg: 'alice', ts: 100 },
    ];
    const list = middleware.getVisibleLogs(makeCtx(logs), { currentUser: JMY, headers: {} }, '', { limit: 100 });
    assert.deepEqual(list.map(item => item.accountId), ['acc-jmy']);
    console.log('ok 3 - 普通用户 all 快照仅含自己账号运行日志');
}

// 4) 普通用户指定他人账号 ID 时无法取到日志
{
    const ctx = makeCtx([{ accountId: 'acc-jmy', msg: 'jmy' }, { accountId: 'acc-admin', msg: 'admin' }]);
    const req = { currentUser: JMY, headers: {} };
    const resolved = middleware.resolveAccId(ctx, 'acc-admin', req);
    assert.equal(resolved, '');
    const list = resolved ? middleware.getVisibleLogs(ctx, req, resolved, { limit: 100 }) : [];
    assert.equal(list.length, 0);
    console.log('ok 4 - 普通用户无法解析他人账号 ID 读取日志');
}

// 5) 登录任务按 owner 隔离；新建任务后旧任务作废
async function loginTaskChecks() {
    const mock = (name, exports) => {
        const id = require.resolve(name);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    };
    mock(path.join(DIST, 'models', 'store'), {
        getLoginSettings: () => ({ qqQrLogin: true, napCatEndpoint: 'http://127.0.0.1:6099', napCatSignature: 't' }),
    });
    mock('axios', {
        default: {
            post: async (url) => {
                const p = String(url);
                if (p.includes('/api/auth/login')) return { data: { code: 0, data: { Credential: 'c' } } };
                if (p.includes('/api/QQLogin/CheckLoginStatus')) return { data: { code: 0, data: { isLogin: false } } };
                if (p.includes('/api/QQLogin/GetQQLoginQrcode')) return { data: { code: 0, data: { qrcode: 'https://example.test/qr' } } };
                return { data: { code: 0, data: {} } };
            },
            get: async () => ({ data: {} }),
        },
    });
    const servicePath = path.join(DIST, 'services', 'qq-login', 'service.js');
    delete require.cache[servicePath];
    const service = require(servicePath);

    const first = await service.createLoginTask('jmy');
    await assert.rejects(
        () => service.queryLoginStatus(first.taskId, 'alice'),
        /无权访问该登录任务/,
    );

    const second = await service.createLoginTask('alice');
    const stale = await service.queryLoginStatus(first.taskId, 'jmy');
    assert.equal(stale.status, 'expired', '新建任务后旧任务应失效');
    const fresh = await service.queryLoginStatus(second.taskId, 'alice');
    assert.notEqual(fresh.status, 'expired');
    console.log('ok 5 - QQ 登录任务 owner 隔离且旧任务失效');
}

// 6) 在线更新属于系统级操作，普通用户不得触发远端拉取 / 构建重启 / 版本回滚
function systemUpdateAuthChecks() {
    const mock = (name, exports) => {
        const id = require.resolve(name);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    };
    // 屏蔽 system-update 的重依赖，只验证路由挂载与角色校验行为。
    mock(path.join(DIST, 'services', 'system-update.js'), {
        getSystemUpdateStatus: () => ({}),
        checkSystemUpdates: () => ({}),
        pullSystemUpdates: () => ({}),
        applySystemUpdate: () => ({}),
        rollbackSystemRelease: () => ({}),
        deleteSystemReleases: () => ({}),
        setSystemBackupEnabled: () => ({}),
    });

    const routesPath = path.join(DIST, 'controllers', 'admin', 'system-update-routes.js');
    delete require.cache[routesPath];
    const { mountSystemUpdateRoutes } = require(routesPath);

    const useMiddlewares = [];
    const routes = new Map();
    const app = {
        use: (routePath, handler) => useMiddlewares.push({ routePath, handler }),
        get: (routePath, ...handlers) => routes.set(routePath, handlers),
        post: (routePath, ...handlers) => routes.set(routePath, handlers),
        put: (routePath, ...handlers) => routes.set(routePath, handlers),
        delete: (routePath, ...handlers) => routes.set(routePath, handlers),
    };
    mountSystemUpdateRoutes(app, { tokens: { has: () => true }, tokenUsers: new Map() });

    assert.equal(routes.size, 7, '在线更新接口应全部注册');
    const guard = useMiddlewares.find(item => item.routePath === '/api/system/update');
    assert.ok(guard, '在线更新前缀必须挂载管理员角色校验');

    const run = (currentUser) => {
        let status = 0;
        let nextCalled = false;
        const res = { status(value) { status = value; return this; }, json() {} };
        guard.handler({ currentUser }, res, () => { nextCalled = true; });
        return { status, nextCalled };
    };

    const userResult = run(JMY);
    assert.equal(userResult.status, 403, '普通用户必须被拒绝');
    assert.equal(userResult.nextCalled, false, '普通用户不得进入在线更新处理函数');
    const adminResult = run(ADMIN);
    assert.equal(adminResult.nextCalled, true, '管理员必须放行');
    console.log('ok 6 - 在线更新接口仅管理员可访问');
}

// 7) 重启后持久化的历史 token 不得提权为管理员。
// ctx.tokens 从 admin-sessions.json 恢复，而 ctx.tokenUsers / user-store.userTokens
// 都是纯内存 Map，重启即清空。旧实现会把无映射 token 回退成 admin，导致普通用户提权。
function restartSessionChecks() {
    const createAuthRequired = middleware.createAuthRequired;
    assert.equal(typeof createAuthRequired, 'function', 'middleware 必须导出 createAuthRequired');

    const staleToken = 'stale-token-after-restart';
    const ctx = {
        tokens: new Set([staleToken]),
        tokenUsers: new Map(),
        provider: { getAccounts: () => ({ accounts: [] }) },
    };
    const authRequired = createAuthRequired(ctx);

    const run = (token) => {
        let status = 200;
        let nextCalled = false;
        const req = { headers: { 'x-admin-token': token } };
        const res = { status(value) { status = value; return this; }, json() {} };
        authRequired(req, res, () => { nextCalled = true; });
        return { status, nextCalled, req };
    };

    const stale = run(staleToken);
    assert.equal(stale.status, 401, '重启后无身份映射的历史 token 必须返回 401');
    assert.equal(stale.nextCalled, false, '历史 token 不得进入路由处理函数');
    assert.equal(stale.req.currentUser, undefined, '不得回退成 admin 身份');
    assert.equal(ctx.tokens.has(staleToken), false, '失效 token 应从持久化集合清除');

    // 本次进程内正常登录的管理员不受影响。
    const adminToken = 'live-admin-token';
    ctx.tokens.add(adminToken);
    ctx.tokenUsers.set(adminToken, ADMIN);
    const live = run(adminToken);
    assert.equal(live.nextCalled, true, '正常登录的管理员必须放行');
    assert.equal(live.req.currentUser.role, 'admin', '管理员身份应正确解析');

    console.log('ok 7 - 重启后历史 token 不提权、正常登录不受影响');
}

loginTaskChecks().then(() => {
    systemUpdateAuthChecks();
    restartSessionChecks();
    console.log('\n权限修复回归测试全部通过');
}).catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
