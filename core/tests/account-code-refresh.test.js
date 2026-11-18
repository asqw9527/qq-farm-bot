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

test('QQ：老账号没有 uin 时不做比对，直接采用并给出串号警告', async () => {
    const { refreshAccountCode } = load({
        './qq-login/service': { refreshFarmCodeForAccount: async () => ({ code: 'QQ-NEW', uin: '10001', nickname: '' }) },
        '../utils/tsdk-runtime': { MINI_PROGRAM_APP_IDS: APP_IDS },
    });
    const outcome = await refreshAccountCode({ id: '1', platform: 'qq' });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.uin, '10001', '应把 NapCat 返回的 uin 带回，便于补全账号');
    assert.match(outcome.warn, /缺少 uin/, '应提示无法校验 NapCat 上是不是这个号');
});

test('QQ：uin 一致时不产生多余警告', async () => {
    const { refreshAccountCode } = load({
        './qq-login/service': { refreshFarmCodeForAccount: async () => ({ code: 'QQ-NEW', uin: '10001', nickname: '' }) },
        '../utils/tsdk-runtime': { MINI_PROGRAM_APP_IDS: APP_IDS },
    });
    const outcome = await refreshAccountCode({ id: '1', platform: 'qq', uin: '10001' });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.warn, undefined);
});

test('微信：账号级 appId 优先于官方值', async () => {
    const calls = [];
    const { refreshAccountCode } = load({
        './wx-login/native-protocol': {
            getNativeWxLoginCode: async (buffer, appId) => { calls.push({ buffer, appId }); return 'WX-NEW'; },
        },
        '../utils/tsdk-runtime': { MINI_PROGRAM_APP_IDS: APP_IDS },
    });
    const outcome = await refreshAccountCode({ id: '2', platform: 'wx', loginBuffer: 'BUF', appId: 'wxCUSTOM' });
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls, [{ buffer: 'BUF', appId: 'wxCUSTOM' }]);
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

test('能力判定：微信只看长凭据，QQ 看账号级或全局 NapCat 地址', () => {
    const { canRefreshAccountCode } = load({
        '../models/store': { getLoginSettings: () => ({ napCatEndpoint: '' }) },
        './qq-login/service': { refreshFarmCodeForAccount: async () => ({ code: 'X' }) },
        '../utils/tsdk-runtime': { MINI_PROGRAM_APP_IDS: APP_IDS },
    });
    // 微信：本地 MMTLS 换码，不占 NapCat
    assert.equal(canRefreshAccountCode({ platform: 'wx', loginBuffer: 'BUF' }), true);
    assert.equal(canRefreshAccountCode({ platform: 'wx' }), false, '没有长凭据就换不了，需重扫');
    // QQ：账号级地址优先
    assert.equal(canRefreshAccountCode({ platform: 'qq', napCatBase: 'http://10.0.0.2:6099' }), true);
    assert.equal(canRefreshAccountCode({ platform: 'qq' }), false, '既无账号级也无全局 NapCat 时判为不可换码');
});

test('能力判定：QQ 账号留空地址时回落到全局 NapCat', () => {
    const { canRefreshAccountCode } = load({
        '../models/store': { getLoginSettings: () => ({ napCatEndpoint: 'http://127.0.0.1:6099' }) },
        './qq-login/service': { refreshFarmCodeForAccount: async () => ({ code: 'X' }) },
        '../utils/tsdk-runtime': { MINI_PROGRAM_APP_IDS: APP_IDS },
    });
    assert.equal(canRefreshAccountCode({ platform: 'qq' }), true, '配置了全局 NapCat 就应视为可换码');
    assert.equal(canRefreshAccountCode({ platform: 'qq', napCatBase: 'http://other:6099' }), true);
});
