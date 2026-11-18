const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

function load(overrides = {}) {
    const filename = path.resolve(__dirname, '../dist/services/account-code-refresh.js');
    const realRequire = createRequire(filename);
    const mod = { exports: {} };
    const sandbox = {
        require: name => overrides[name] || realRequire(name),
        module: mod,
        // TS 编译产物写 exports.xxx，必须与 module.exports 同一对象
        exports: mod.exports,
        Buffer, process,
        console: { warn() {}, error() {}, log() {} },
        setTimeout, clearTimeout, Date, Math, JSON, Promise,
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return mod.exports;
}

const APP_IDS = { qq: '1112386029', wx: 'wx5306c5978fdb76e4' };

test('QQ：uin 一致时返回新 Code', async () => {
    const { refreshAccountCode } = load({
        './qq-login/service': { refreshFarmCodeForAccount: async () => ({ code: 'QQ-NEW', uin: '10001', nickname: 'x' }) },
        '../utils/tsdk-runtime': { MINI_PROGRAM_APP_IDS: APP_IDS },
    });
    const outcome = await refreshAccountCode({ id: '1', platform: 'qq', uin: '10001', code: 'OLD' });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.code, 'QQ-NEW');
    assert.equal(outcome.uin, '10001');
});

test('QQ：NapCat 登的是另一个号时拒绝写入（防串号）', async () => {
    const { refreshAccountCode } = load({
        './qq-login/service': { refreshFarmCodeForAccount: async () => ({ code: 'OTHER', uin: '20002', nickname: 'x' }) },
        '../utils/tsdk-runtime': { MINI_PROGRAM_APP_IDS: APP_IDS },
    });
    const outcome = await refreshAccountCode({ id: '1', platform: 'qq', uin: '10001' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, undefined, '不一致时不能给出 Code');
    assert.match(outcome.reason, /不一致/);
});

test('QQ：老账号没有 uin 时不做比对，直接采用', async () => {
    const { refreshAccountCode } = load({
        './qq-login/service': { refreshFarmCodeForAccount: async () => ({ code: 'QQ-NEW', uin: '10001', nickname: '' }) },
        '../utils/tsdk-runtime': { MINI_PROGRAM_APP_IDS: APP_IDS },
    });
    const outcome = await refreshAccountCode({ id: '1', platform: 'qq' });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.uin, '10001', '应把 NapCat 返回的 uin 带回，便于补全账号');
});

test('微信：用已保存的 loginBuffer 本地换 Code，appId 缺省用官方值', async () => {
    const calls = [];
    const { refreshAccountCode } = load({
        './wx-login/native-protocol': {
            getNativeWxLoginCode: async (buffer, appId) => { calls.push({ buffer, appId }); return 'WX-NEW'; },
        },
        '../utils/tsdk-runtime': { MINI_PROGRAM_APP_IDS: APP_IDS },
    });
    const outcome = await refreshAccountCode({ id: '2', platform: 'wx', loginBuffer: 'BUF', code: 'OLD' });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.code, 'WX-NEW');
    assert.deepEqual(calls, [{ buffer: 'BUF', appId: APP_IDS.wx }]);
});

test('微信：没有长凭据时明确要求重新扫码', async () => {
    const { refreshAccountCode } = load({
        './wx-login/native-protocol': { getNativeWxLoginCode: async () => { throw new Error('不应被调用'); } },
        '../utils/tsdk-runtime': { MINI_PROGRAM_APP_IDS: APP_IDS },
    });
    const outcome = await refreshAccountCode({ id: '2', platform: 'wx', code: 'OLD' });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /重新扫码/);
});
