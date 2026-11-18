/**
 * 本轮安全修复回归测试：
 * - 改密/管理操作撤销会话时只影响目标用户，不清空全局 token
 * - 卡密领取防刷绑定 IP + header UA，忽略请求体伪造的 UA
 * - 删除用户后其名下账号被解绑（无归属），避免同名重新注册继承
 * - Socket 巡检会主动断开已到期的普通用户连接，保留有效连接与管理员连接
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');

function mockModule(relPath, exports) {
    const full = require.resolve(path.join(DIST, relPath));
    require.cache[full] = { id: full, filename: full, loaded: true, exports };
}
function fresh(relPath) {
    const full = require.resolve(path.join(DIST, relPath));
    delete require.cache[full];
    return require(full);
}

// ---------- 1) 会话撤销只影响目标用户 ----------
test('revokeUserSessions 仅撤销目标用户的 token 并断开其 socket', () => {
    const revoked = ['tok-jmy-1', 'tok-jmy-2'];
    mockModule('models/user-store.js', {
        revokeUserTokens: (name) => (name === 'jmy' ? revoked : []),
    });
    const middleware = fresh('controllers/admin/middleware.js');

    const tokens = new Set(['tok-jmy-1', 'tok-jmy-2', 'tok-admin', 'tok-alice']);
    const tokenUsers = new Map([
        ['tok-jmy-1', { username: 'jmy', role: 'user' }],
        ['tok-jmy-2', { username: 'jmy', role: 'user' }],
        ['tok-admin', { username: 'admin', role: 'admin' }],
        ['tok-alice', { username: 'alice', role: 'user' }],
    ]);
    const disconnected = [];
    const sockets = new Map([
        ['s1', { data: { adminToken: 'tok-jmy-1' }, disconnect: () => disconnected.push('s1') }],
        ['s2', { data: { adminToken: 'tok-jmy-2' }, disconnect: () => disconnected.push('s2') }],
        ['s3', { data: { adminToken: 'tok-admin' }, disconnect: () => disconnected.push('s3') }],
        ['s4', { data: { adminToken: 'tok-alice' }, disconnect: () => disconnected.push('s4') }],
    ]);
    const ctx = { tokens, tokenUsers, io: { sockets: { sockets } } };

    const result = middleware.revokeUserSessions(ctx, 'jmy');
    assert.deepEqual(result.sort(), ['tok-jmy-1', 'tok-jmy-2']);
    assert.deepEqual([...tokens].sort(), ['tok-admin', 'tok-alice']);
    assert.deepEqual([...tokenUsers.keys()].sort(), ['tok-admin', 'tok-alice']);
    assert.deepEqual(disconnected.sort(), ['s1', 's2']);
});

// ---------- 2) 卡密领取：IP + header UA 双维度防刷 ----------
test('claimCardByUA 绑定 IP 与 UA：换 UA 或换 IP 都不能在 24h 内重复领取', () => {
    // 用独立的 json-db mock 加载 user-store，避免污染真实数据
    const files = {};
    mockModule('services/json-db.js', {
        readJsonFile: (_f, fallback) => (files[_f] !== undefined ? files[_f] : (fallback || null)),
        writeJsonFileAtomic: (_f, data) => { files[_f] = JSON.parse(JSON.stringify(data)); },
    });
    mockModule('config/runtime-paths.js', {
        getDataFile: (name) => `virtual:${name}`,
        ensureDataDir: () => {},
    });
    mockModule('models/auth-security.js', {
        verifyPassword: () => false,
        hashPassword: (p) => `hash:${p}`,
        validatePasswordStrength: () => ({ valid: true, errors: [] }),
        needsRehash: () => false,
    });

    const us = fresh('models/user-store.js');
    // 注入一张可用卡密
    const cardFile = 'virtual:cards.json';
    files[cardFile] = { cards: [{ code: 'CARD-1', type: 'time', enabled: true, days: 30, durationMs: 30 * 86400000 }] };
    us.initUserStore();

    const first = us.claimCardByUA('UA-A', 'jmy', '1.2.3.4');
    assert.equal(first.ok, true, '首次领取应成功');
    // 同 IP 换 UA
    assert.equal(us.claimCardByUA('UA-B', 'jmy', '1.2.3.4').ok, false, '同 IP 换 UA 应被拒绝');
    // 同 UA 换 IP
    assert.equal(us.claimCardByUA('UA-A', 'jmy', '5.6.7.8').ok, false, '同 UA 换 IP 应被拒绝');
    // IP 与 UA 都换：防刷记录不命中，此时应放行（受库存限制）。
    // 这符合预期：防刷是软限制，绑定双维度后攻击者需同时伪造两者才能绕过。
    const both = us.claimCardByUA('UA-B', 'jmy', '5.6.7.8');
    assert.equal(both.ok, true, '双维度都换过后防刷不命中，应放行');
    assert.equal(both.cardCode, 'CARD-1');
});

// ---------- 3) 删除用户后解绑账号归属 ----------
test('unbindAccountsByOwner 仅解绑目标用户的账号', () => {
    const mem = { accounts: [], nextId: 1 };
    mockModule('config/runtime-paths.js', { ensureDataDir: () => {} });
    mockModule('models/store/shared-state.js', { ACCOUNTS_FILE: 'virtual-accounts.json' });
    mockModule('models/store/account-config.js', { ensureAccountConfig: () => {}, removeAccountConfig: () => {} });
    mockModule('services/json-db.js', {
        readJsonFileStrict: (_f, fallback) => {
            if (!mem.accounts.length && mem.nextId === 1) return fallback ? fallback() : { accounts: [], nextId: 1 };
            return JSON.parse(JSON.stringify(mem));
        },
        writeJsonFileAtomic: (_f, data) => {
            mem.accounts = JSON.parse(JSON.stringify(data.accounts));
            mem.nextId = data.nextId;
        },
        storageError: (_op, _f, err) => err,
    });
    const accounts = fresh('models/store/accounts.js');
    accounts.addOrUpdateAccount({ name: 'jmy账号', code: 'c1', username: 'jmy' });
    accounts.addOrUpdateAccount({ name: 'alice账号', code: 'c2', username: 'alice' });

    const changed = accounts.unbindAccountsByOwner('jmy');
    assert.equal(changed, 1);
    const data = accounts.getAccounts();
    assert.equal(data.accounts.find(a => a.name === 'jmy账号').username, undefined);
    assert.equal(data.accounts.find(a => a.name === 'alice账号').username, 'alice');
});

// ---------- 4) Socket 巡检断开到期连接 ----------
test('enforceSocketTokenExpiry 断开到期普通用户，保留有效用户与管理员', () => {
    mockModule('models/user-store.js', {
        getAuthResultByToken: (t) => (t === 'tok-admin'
            ? { username: 'admin', role: 'admin' }
            : { username: 'jmy', role: 'user' }),
        validateUserToken: (t) => (t === 'tok-expired'
            ? { ok: false, error: '账号已过期' }
            : { ok: true, user: { username: 'jmy', role: 'user' } }),
    });
    const socketMod = fresh('controllers/admin/socket.js');

    const tokens = new Set(['tok-expired', 'tok-valid', 'tok-admin']);
    const tokenUsers = new Map([
        ['tok-expired', { username: 'jmy', role: 'user' }],
        ['tok-valid', { username: 'jmy', role: 'user' }],
        ['tok-admin', { username: 'admin', role: 'admin' }],
    ]);
    const disconnected = [];
    const sockets = new Map([
        ['s-expired', { data: { adminToken: 'tok-expired' }, disconnect: () => disconnected.push('s-expired') }],
        ['s-valid', { data: { adminToken: 'tok-valid' }, disconnect: () => disconnected.push('s-valid') }],
        ['s-admin', { data: { adminToken: 'tok-admin' }, disconnect: () => disconnected.push('s-admin') }],
    ]);
    const ctx = { tokens, tokenUsers, io: { sockets: { sockets } } };

    const n = socketMod.enforceSocketTokenExpiry(ctx);
    assert.equal(n, 1);
    assert.deepEqual(disconnected, ['s-expired']);
    assert.equal(tokens.has('tok-expired'), false);
    assert.equal(tokenUsers.has('tok-expired'), false);
    assert.equal(tokens.has('tok-valid'), true);
    assert.equal(tokens.has('tok-admin'), true);
});
