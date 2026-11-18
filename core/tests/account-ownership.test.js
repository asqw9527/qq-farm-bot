const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// 用内存存储 mock 掉 json-db，避免测试污染真实 accounts.json
const base = path.join(__dirname, '..', 'dist');
const accountsModulePath = path.join(base, 'models/store/accounts.js');
const mem = { accounts: [], nextId: 1 };

function mockModule(relPath, exports) {
    const full = require.resolve(path.join(base, relPath));
    require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

mockModule('config/runtime-paths.js', { ensureDataDir: () => {} });
// accounts.js 只从 shared-state 取 ACCOUNTS_FILE，直接 mock 避免加载其整条依赖链
mockModule('models/store/shared-state.js', { ACCOUNTS_FILE: 'virtual-accounts.json' });
// 新建/更新账号会调用 ensureAccountConfig 写配置，测试只关心归属字段，mock 掉其依赖链
mockModule('models/store/account-config.js', { ensureAccountConfig: () => {}, removeAccountConfig: () => {} });
mockModule('services/json-db.js', {
    readJsonFileStrict: (_file, fallback) => {
        if (!mem.accounts.length && mem.nextId === 1) return fallback ? fallback() : { accounts: [], nextId: 1 };
        return JSON.parse(JSON.stringify(mem));
    },
    writeJsonFileAtomic: (_file, data) => {
        mem.accounts = JSON.parse(JSON.stringify(data.accounts));
        mem.nextId = data.nextId;
    },
    storageError: (_op, _file, err) => err,
});

let addOrUpdateAccount;
function reset() {
    // accounts.js 内部有 accountsCache，必须清 require.cache 重新加载以隔离用例
    delete require.cache[require.resolve(accountsModulePath)];
    mem.accounts = [];
    mem.nextId = 1;
    ({ addOrUpdateAccount } = require(accountsModulePath));
}

test('新建账号时写入归属人 username', () => {
    reset();
    const data = addOrUpdateAccount({ name: 'jmy的账号', code: 'code-jmy', username: 'jmy' });
    const acc = data.accounts[0];
    assert.equal(acc.username, 'jmy');
    assert.equal(acc.code, 'code-jmy');
});

test('新建账号时写入昵称 nick', () => {
    reset();
    const data = addOrUpdateAccount({ name: '微信号', code: 'code-wx', username: 'jmy', nick: '小明' });
    assert.equal(data.accounts[0].nick, '小明');
});

test('新建账号不带归属时不写入 username 字段', () => {
    reset();
    const data = addOrUpdateAccount({ name: '无归属账号', code: 'code-x' });
    assert.equal(data.accounts[0].username, undefined);
});

test('更新账号时 username 归属不被覆盖丢失', () => {
    reset();
    const first = addOrUpdateAccount({ name: 'jmy的账号', code: 'c1', username: 'jmy' });
    const id = first.accounts[0].id;
    // 模拟运行时仅更新 code，不传 username
    const second = addOrUpdateAccount({ id, code: 'c2' });
    assert.equal(second.accounts[0].username, 'jmy');
    assert.equal(second.accounts[0].code, 'c2');
});

test('管理员新增账号仍可显式指定管理员归属', () => {
    reset();
    const data = addOrUpdateAccount({ name: '管理员账号', code: 'c-admin', username: 'admin' });
    assert.equal(data.accounts[0].username, 'admin');
});
