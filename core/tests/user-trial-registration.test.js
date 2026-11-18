/**
 * 新用户注册到期时间回归测试：
 * - 不填卡密注册：默认 30 分钟后到期，标记为体验账号，可正常登录
 * - 填卡密注册：到期时间完全按卡密时长计算，不叠加体验时长
 * - 体验账号首次用时间卡密续费：按卡密时长从当前时间重新计算，不叠加 30 分钟体验时长
 * - 普通体验账号到期后 validateUser 判定为过期（errorType=expired）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');
const TRIAL_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PASSWORD = 'Test@123';

function mockModule(relPath, exportsObj) {
    const full = require.resolve(path.join(DIST, relPath));
    require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// 每个用例用独立临时数据目录，避免相互污染。
function loadStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'userstore-reg-'));
    mockModule('config/runtime-paths.js', {
        ensureDataDir: () => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); },
        getDataFile: (name) => path.join(dir, name),
        getRuntimeConfig: () => ({}),
    });
    const full = require.resolve(path.join(DIST, 'models/user-store.js'));
    delete require.cache[full];
    const store = require(full);
    return { store, dir };
}

function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('不填卡密注册：默认 30 分钟后到期并标记为体验账号', () => {
    const { store, dir } = loadStore();
    try {
        const before = Date.now();
        const res = store.registerUser('trialuser', PASSWORD, '');
        assert.equal(res.ok, true, res.error);
        assert.equal(res.user.role, 'user');

        const user = store.getUserByUsername('trialuser');
        const exp = user.expiresAt;
        assert.ok(exp >= before + TRIAL_MS - 2000, '到期时间应不早于当前时间 + 30 分钟');
        assert.ok(exp <= Date.now() + TRIAL_MS + 2000, '到期时间应不晚于当前时间 + 30 分钟');
        assert.equal(user.isTrial, true, '应标记为体验账号');
        assert.equal(user.cardCode, undefined, '不应绑定卡密');
    } finally { cleanup(dir); }
});

test('不填卡密注册的体验账号可正常登录', () => {
    const { store, dir } = loadStore();
    try {
        store.registerUser('triallogin', PASSWORD, '');
        const res = store.validateUser('triallogin', PASSWORD, '127.0.0.1');
        assert.equal(res.ok, true, res.error);
        assert.equal(res.user.role, 'user');
    } finally { cleanup(dir); }
});

test('填卡密注册：到期时间完全按卡密时长计算', () => {
    const { store, dir } = loadStore();
    try {
        const generated = store.generateCards(1, '一天卡', DAY_MS);
        assert.equal(generated.ok, true);
        const code = generated.codes[0];

        const before = Date.now();
        const res = store.registerUser('carduser', PASSWORD, code);
        assert.equal(res.ok, true, res.error);

        const user = store.getUserByUsername('carduser');
        assert.ok(user.expiresAt >= before + DAY_MS - 2000, '到期应按卡密的 1 天时长');
        assert.ok(user.expiresAt <= Date.now() + DAY_MS + 2000, '到期应按卡密的 1 天时长');
        assert.equal(user.cardCode, code);
        assert.ok(!user.isTrial, '有卡密注册不应标记为体验账号');
    } finally { cleanup(dir); }
});

test('体验账号首次用时间卡密续费：按卡密时长重算，不叠加 30 分钟体验', () => {
    const { store, dir } = loadStore();
    try {
        store.registerUser('renewtrial', PASSWORD, '');
        const generated = store.generateCards(1, '一天卡', DAY_MS);
        const code = generated.codes[0];

        const before = Date.now();
        const res = store.renewUser('renewtrial', code);
        assert.equal(res.ok, true, res.error);

        const user = store.getUserByUsername('renewtrial');
        // 到期应约为 当前时间 + 1 天，而非 当前时间 + 1 天 + 30 分钟
        assert.ok(user.expiresAt >= before + DAY_MS - 2000, '到期应不早于 当前 + 1 天');
        assert.ok(user.expiresAt < before + DAY_MS + TRIAL_MS, '不应叠加 30 分钟体验时长');
        assert.ok(!user.isTrial, '续费后应清除体验标记');
        assert.equal(user.cardCode, code);
    } finally { cleanup(dir); }
});

test('到期体验账号被判定为过期（expired）', () => {
    const { store, dir } = loadStore();
    try {
        store.registerUser('expiredtrial', PASSWORD, '');
        const user = store.getUserByUsername('expiredtrial');
        user.expiresAt = Date.now() - 1000; // 人工置为已过期（内存中）
        const res = store.validateUser('expiredtrial', PASSWORD, '127.0.0.1');
        assert.equal(res.ok, false);
        assert.equal(res.errorType, 'expired');
    } finally { cleanup(dir); }
});
