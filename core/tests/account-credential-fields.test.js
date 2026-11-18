const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

// 用沙箱隔离磁盘：accounts 模块只跟内存里的假 json-db 交互，绝不碰真实数据目录。
function loadAccountsModule() {
    const filename = path.resolve(__dirname, '../dist/models/store/accounts.js');
    const realRequire = createRequire(filename);
    const memory = { file: '', saved: null };
    const sandbox = {
        require: (name) => {
            if (name === '../../config/runtime-paths') return { ensureDataDir() {} };
            if (name === '../../services/secure-accounts-file') {
                return {
                    readSecureJson: (_file, fallbackFactory) => ({ data: memory.saved || fallbackFactory(), encrypted: true }),
                    writeSecureJson: (_file, data) => { memory.saved = JSON.parse(JSON.stringify(data)); },
                    migratePlaintextIfNeeded: () => false,
                };
            }
            if (name === '../../services/json-db') {
                return {
                    storageError: (action, file, cause) => Object.assign(new Error(`${action} ${file}`), { cause }),
                };
            }
            if (name === './shared-state') return { ACCOUNTS_FILE: path.join(__dirname, 'memory-accounts.json') };
            if (name === './account-config') return { ensureAccountConfig() {}, removeAccountConfig() {} };
            return realRequire(name);
        },
        module: { exports: {} },
        exports: {},
        Buffer, process,
        console: { warn() {}, error() {}, log() {} },
        setTimeout, clearTimeout, Date, Math, JSON,
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return { store: sandbox.module.exports, memory };
}

test('账号新增字段可落盘并读回（含 loginBuffer / NapCat 配置）', () => {
    const { store, memory } = loadAccountsModule();
    store.addOrUpdateAccount({
        name: '微信号A',
        code: 'code-a',
        platform: 'wx',
        wxid: 'openid-a',
        loginBuffer: 'buffer-a',
        appId: 'wx5306c5978fdb76e4',
    });
    store.addOrUpdateAccount({
        name: 'QQ号B',
        code: 'code-b',
        platform: 'qq',
        uin: '10001',
        napCatBase: 'http://10.0.0.5:6099',
        napCatKey: 'token-b',
        ver: '1.17.0.4_20261117',
    });

    const raw = memory.saved.accounts;
    const wx = raw.find(a => a.platform === 'wx');
    const qq = raw.find(a => a.platform === 'qq');
    assert.equal(wx.wxid, 'openid-a');
    assert.equal(wx.loginBuffer, 'buffer-a');
    assert.equal(wx.appId, 'wx5306c5978fdb76e4');
    assert.equal(qq.napCatBase, 'http://10.0.0.5:6099');
    assert.equal(qq.napCatKey, 'token-b');
    assert.equal(qq.ver, '1.17.0.4_20261117');

    // 重新加载（缓存失效后走 normalizeAccount）仍然保留
    store.loadAccounts();
    const reloaded = store.getAccounts().accounts;
    assert.equal(reloaded.find(a => a.platform === 'wx').loginBuffer, 'buffer-a');
    assert.equal(reloaded.find(a => a.platform === 'qq').napCatKey, 'token-b');
});

test('空值不写入字段，避免产生空串污染', () => {
    const { store, memory } = loadAccountsModule();
    store.addOrUpdateAccount({ name: '空值号', code: 'c', platform: 'wx', wxid: '', loginBuffer: '', napCatBase: '' });
    const account = memory.saved.accounts[0];
    assert.equal('wxid' in account, false);
    assert.equal('loginBuffer' in account, false);
    assert.equal('napCatBase' in account, false);
});

test('未在白名单内的陌生字段不会被落盘', () => {
    const { store, memory } = loadAccountsModule();
    store.addOrUpdateAccount({ name: '注入号', code: 'c', platform: 'qq', isAdmin: true, evil: 'x' });
    const account = memory.saved.accounts[0];
    assert.equal('isAdmin' in account, false);
    assert.equal('evil' in account, false);
});

test('凭据中转站一次性消费且不返回空凭据', () => {
    const vault = require('../dist/services/wx-login/credential-vault.js');
    vault.putWxLoginCredential('openid-1', 'buffer-1');
    assert.equal(vault.pendingWxCredentialCount(), 1);
    assert.equal(vault.takeWxLoginCredential('openid-1'), 'buffer-1');
    assert.equal(vault.takeWxLoginCredential('openid-1'), '');
    assert.equal(vault.pendingWxCredentialCount(), 0);
    vault.putWxLoginCredential('', 'x');
    vault.putWxLoginCredential('openid-2', '');
    assert.equal(vault.pendingWxCredentialCount(), 0);
});
