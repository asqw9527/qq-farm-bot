const assert = require('node:assert/strict');
const test = require('node:test');

const QR_MINIAPP_APP_ID = '1112386029';

function loadService({ state, farmCode, profile = {} } = {}) {
    const calls = [];
    let loggedIn = state === undefined ? false : state;

    const mock = (name, exports) => {
        const id = require.resolve(name);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    };

    mock('../dist/models/store', {
        getLoginSettings: () => ({
            qqQrLogin: true,
            napCatEndpoint: 'http://127.0.0.1:6099',
            napCatSignature: 'webui-token',
        }),
    });

    const axios = {
        post: async (url, body, config = {}) => {
            calls.push({ method: 'POST', url, body, config });
            const path = String(url);
            if (path.includes('/api/auth/login')) {
                return { data: { code: 0, data: { Credential: 'cred-1' } } };
            }
            if (path.includes('/api/QQLogin/CheckLoginStatus')) {
                return { data: { code: 0, data: { isLogin: loggedIn, isOffline: false } } };
            }
            if (path.includes('/api/QQLogin/SetQuickLoginQQ')) {
                loggedIn = false;
                return { data: { code: 0 } };
            }
            if (path.includes('/api/QQLogin/RestartNapCat')) {
                loggedIn = false;
                return { data: { code: 0 } };
            }
            if (path.includes('/api/QQLogin/GetQQLoginInfo')) {
                return { data: { code: 0, data: profile } };
            }
            if (path.includes('/api/QQLogin/RefreshQRcode')) {
                return { data: { code: 0, data: {} } };
            }
            if (path.includes('/api/QQLogin/GetQQLoginQrcode')) {
                return { data: { code: 0, data: { qrcode: 'https://example.test/qr/new-session' } } };
            }
            return { data: { code: 0, data: {} } };
        },
        get: async (url) => {
            calls.push({ method: 'GET', url });
            const path = String(url);
            if (path.includes('/api/proto/code')) {
                if (!farmCode) return { data: {} };
                return { data: { code: farmCode.code, uin: farmCode.uin, nickname: farmCode.nickname } };
            }
            return { data: {} };
        },
    };
    mock('axios', { default: axios });

    const servicePath = require.resolve('../dist/services/qq-login/service');
    delete require.cache[servicePath];
    const service = require(servicePath);
    return { service, calls, setLoggedIn: value => { loggedIn = value; } };
}

function postPaths(calls) {
    return calls.filter(call => call.method === 'POST').map(call => new URL(call.url).pathname);
}

test('createLoginTask clears an existing QQ session so a fresh QR can be scanned', async () => {
    const { service, calls, setLoggedIn } = loadService({ state: true });

    await service.createLoginTask();

    const paths = postPaths(calls);
    assert.ok(paths.includes('/api/auth/login'));
    assert.ok(paths.includes('/api/QQLogin/CheckLoginStatus'));
    assert.ok(paths.includes('/api/QQLogin/SetQuickLoginQQ'));
    assert.ok(paths.includes('/api/QQLogin/RestartNapCat'));
    assert.ok(paths.includes('/api/QQLogin/GetQQLoginQrcode'));
    const setQuick = calls.find(call => String(call.url).includes('/SetQuickLoginQQ'));
    assert.deepEqual(setQuick.body, { uin: '' });
});

test('createLoginTask skips the restart when NapCat is not logged in', async () => {
    const { service, calls } = loadService({ state: false });

    const task = await service.createLoginTask();

    const paths = postPaths(calls);
    assert.ok(paths.includes('/api/QQLogin/GetQQLoginQrcode'));
    assert.ok(!paths.includes('/api/QQLogin/RestartNapCat'));
    assert.equal(task.status, 'waiting_scan');
    assert.match(task.qrImage, /^data:image\/png;base64,/);
});

test('getMiniappCode falls back to the NapCat profile when the plugin omits the nickname', async () => {
    const { service } = loadService({
        farmCode: { code: 'farm-code', uin: '12345', nickname: '' },
        profile: { uin: '12345', nickname: 'napcat-nickname' },
    });

    const task = await service.createLoginTask();
    await service.queryLoginStatus(task.taskId);
    const result = await service.getMiniappCode(task.taskId);

    assert.equal(result.code, 'farm-code');
    assert.equal(result.nickname, 'napcat-nickname');
});

test('getMiniappCode uses the plugin nickname when available', async () => {
    const { service } = loadService({
        farmCode: { code: 'farm-code', uin: '12345', nickname: 'plugin-nickname' },
    });

    const task = await service.createLoginTask();
    await service.queryLoginStatus(task.taskId);
    const result = await service.getMiniappCode(task.taskId);

    assert.equal(result.code, 'farm-code');
    assert.equal(result.nickname, 'plugin-nickname');
});

test('cancelLoginTask logs out NapCat when a scan was already confirmed', async () => {
    const { service, calls, setLoggedIn } = loadService({ state: false, farmCode: { code: 'farm-code', uin: '1', nickname: 'nick' } });

    const task = await service.createLoginTask();
    setLoggedIn(true);
    await service.queryLoginStatus(task.taskId);
    await service.cancelLoginTask(task.taskId);

    const paths = postPaths(calls);
    assert.ok(paths.includes('/api/QQLogin/SetQuickLoginQQ'));
    assert.ok(paths.includes('/api/QQLogin/RestartNapCat'));
});
