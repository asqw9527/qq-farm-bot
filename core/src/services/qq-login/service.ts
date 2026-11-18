import type { LoginSettings } from '../../types/config';
export {};

const axios = require('axios').default;
const store = require('../../models/store');
const crypto = require('node:crypto');
const QRCode = require('qrcode');

const QQ_MINIAPP_APP_ID = '1112386029';
const DEFAULT_PLUGIN_PATH = 'napcat-plugin-qq-farm-code';
const SESSION_TTL_MS = 180_000;
const WEBUI_TIMEOUT_MS = 10_000;
const CODE_TIMEOUT_MS = 10_000;
const NAPCAT_RESTART_WAIT_MS = 15_000;

export type QqLoginTaskStatus
    = 'waiting_scan'
    | 'scanned'
    | 'confirmed'
    | 'cancelled'
    | 'expired'
    | 'failed';

export interface QqLoginTask {
    taskId: string;
    status: QqLoginTaskStatus;
    qrImage: string;
    expiresAt: number;
}

export interface QqMiniappLoginResult {
    code: string;
    nickname?: string;
    // 换码时用来校验 NapCat 当前登录的号是否与账号一致
    uin?: string;
}

interface QqSession {
    id: string;
    owner: string;
    base: string;
    token: string;
    cred: string;
    pluginPath: string;
    qrUrl: string;
    qrImage: string;
    status: QqLoginTaskStatus;
    code: string;
    nickname: string;
    uin: string;
    error: string;
    expiresAt: number;
    createdAt: number;
    failCnt: number;
    done: boolean;
}

interface FarmCode {
    code: string;
    uin: string;
    nickname: string;
}

interface QqProfile {
    uin: string;
    nickname: string;
}

const sessions = new Map<string, QqSession>();

function loginSettings(): LoginSettings {
    const settings = store.getLoginSettings();
    if (!settings?.qqQrLogin)
        throw new Error('QQ扫码登录未开启');
    if (!settings.napCatEndpoint || !settings.napCatSignature)
        throw new Error('请先配置 NapCat 地址和 WebUI Token');
    return settings;
}

function apiUrl(endpoint: string, path: string): string {
    return `${endpoint.replace(/\/+$/, '')}${path}`;
}

function sha256Hex(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeId(): string {
    return crypto.randomBytes(16).toString('hex');
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function describeError(error: any, fallback: string): string {
    const message = String(error?.message || '').trim();
    if (error?.response?.status === 401)
        return 'NapCat WebUI Token 不正确，请检查设置页的 NapCat 接口签名';
    if (error?.code === 'ECONNABORTED' || /timeout/i.test(message))
        return '连接 NapCat 超时，请检查地址和端口';
    if (/ENOTFOUND|ECONNREFUSED|Network Error/i.test(message))
        return '无法连接 NapCat，请检查地址和端口';
    return message || fallback;
}

// WebUI 登录：POST /api/auth/login，body.hash = SHA256(token + ".napcat")。
async function webuiLogin(base: string, token: string): Promise<string> {
    let response;
    try {
        response = await axios.post(apiUrl(base, '/api/auth/login'), {
            hash: sha256Hex(`${token}.napcat`),
        }, {
            timeout: WEBUI_TIMEOUT_MS,
            validateStatus: (status: number) => status === 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    catch (error: any) {
        throw new Error(describeError(error, 'NapCat WebUI 登录失败'));
    }
    const payload = response?.data;
    if (payload?.code !== undefined && payload.code !== 0 && payload.code !== 200) {
        throw new Error(`NapCat WebUI 登录失败（${payload.code}）：${String(payload.message || '').trim()}`);
    }
    const cred = String(payload?.data?.Credential || payload?.data?.credential || '').trim();
    if (!cred)
        throw new Error('NapCat WebUI 未返回 Credential，请检查 WebUI Token');
    return cred;
}

// WebUI 业务接口：POST /api/QQLogin/*，Bearer Credential，响应 { code, data }。
async function webuiCall(base: string, cred: string, path: string, body: Record<string, unknown> = {}): Promise<any> {
    let response;
    try {
        response = await axios.post(apiUrl(base, path), body, {
            timeout: WEBUI_TIMEOUT_MS,
            validateStatus: (status: number) => status === 200,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cred}`,
            },
        });
    }
    catch (error: any) {
        throw new Error(describeError(error, `NapCat WebUI 请求失败（${path}）`));
    }
    const payload = response?.data;
    if (payload?.code !== undefined && payload.code !== 0 && payload.code !== 200) {
        throw new Error(String(payload?.message || '').trim() || `NapCat WebUI 接口返回 ${payload.code}`);
    }
    if (payload?.data && typeof payload.data === 'object')
        return payload.data;
    return payload || {};
}

// NapCat 的登录态用 isLogin / isOffline 表示，不能用 online/status 等字段。
function hasQqSession(state: any): boolean {
    return state?.isLogin === true || state?.isOffline === true;
}

async function readLoginState(base: string, cred: string): Promise<any> {
    return await webuiCall(base, cred, '/api/QQLogin/CheckLoginStatus');
}

function pickQrUrl(data: any): string {
    for (const key of ['qrcodeurl', 'QrcodeUrl', 'qrcodeUrl', 'qrcode_url', 'qrUrl', 'url', 'URL', 'qrcode', 'qrCode']) {
        const value = data?.[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    if (data && typeof data === 'object') {
        for (const value of Object.values(data)) {
            if (typeof value === 'string' && /^https?:\/\//i.test(value))
                return value;
        }
    }
    return '';
}

async function renderQrImage(content: string): Promise<string> {
    if (!content)
        return '';
    try {
        return await QRCode.toDataURL(content, {
            width: 280,
            margin: 1,
            errorCorrectionLevel: 'M',
        });
    }
    catch {
        return '';
    }
}

// 通过 NapCat 内的 napcat-plugin-qq-farm-code 取农场 code。
// appId / token 均可选：appId 覆盖默认小程序 appid（账号级配置），
// token 用于 NapCat 对插件路由开了鉴权时放行——先按原样请求，
// 失败且配置了 token 再带 Authorization 重试，不改变未开鉴权时的行为。
async function fetchFarmCode(
    base: string,
    pluginPath: string,
    options: { appId?: string; token?: string } = {},
): Promise<FarmCode | null> {
    const endpoint = `${apiUrl(base, '/plugin')}/${pluginPath}/api/proto/code`;
    const appId = String(options.appId || '').trim() || QQ_MINIAPP_APP_ID;
    const query = new URLSearchParams({ appid: appId });
    const url = `${endpoint}?${query.toString()}`;
    const send = (headers?: Record<string, string>) => axios.get(url, {
        timeout: CODE_TIMEOUT_MS,
        validateStatus: (status: number) => status === 200,
        ...(headers ? { headers } : {}),
    });
    let response;
    try {
        response = await send();
    }
    catch {
        const token = String(options.token || '').trim();
        if (!token) return null;
        try {
            response = await send({ Authorization: `Bearer ${token}` });
        }
        catch {
            return null;
        }
    }
    const data = response?.data;
    if (!data || typeof data !== 'object')
        return null;
    const code = String(data?.code || data?.data?.code || '').trim();
    if (!code)
        return null;
    return {
        code,
        uin: String(data?.uin || data?.data?.uin || '').trim(),
        nickname: String(data?.nickname || data?.data?.nickname || '').trim(),
    };
}

// 主动拉取 QQ 昵称与 uin，避免插件未返回昵称时前端卡在"等待填写账号备注"。
async function fetchQqProfile(base: string, cred: string): Promise<QqProfile> {
    try {
        const info = await webuiCall(base, cred, '/api/QQLogin/GetQQLoginInfo');
        return {
            uin: String(info?.uin || info?.user_id || info?.qq || '').trim(),
            nickname: String(info?.nickname || info?.nick || info?.name || '').trim(),
        };
    }
    catch {
        return { uin: '', nickname: '' };
    }
}

function createSession(values: Partial<QqSession> & Pick<QqSession, 'base' | 'token' | 'cred' | 'pluginPath' | 'qrUrl' | 'qrImage' | 'status'>): QqSession {
    const session: QqSession = {
        id: makeId(),
        owner: '',
        code: '',
        nickname: '',
        uin: '',
        error: '',
        expiresAt: Date.now() + SESSION_TTL_MS,
        createdAt: Date.now(),
        failCnt: 0,
        done: false,
        ...values,
    };
    sessions.set(session.id, session);
    return session;
}

function getSession(taskId: string, owner?: string): QqSession {
    const session = sessions.get(String(taskId || '').trim());
    if (!session)
        throw new Error('QQ 登录会话不存在或已过期');
    if (owner && session.owner && session.owner !== owner)
        throw new Error('无权访问该登录任务');
    return session;
}

function toTask(session: QqSession): QqLoginTask {
    return {
        taskId: session.id,
        status: session.status,
        qrImage: session.qrImage,
        expiresAt: session.expiresAt,
    };
}

// NapCat 是单账号实例：换号必须先清掉快速登录并重启，回到未登录态才能出全新二维码。
async function resetQqSession(base: string, token: string): Promise<string> {
    let cred = await webuiLogin(base, token);
    try {
        await webuiCall(base, cred, '/api/QQLogin/SetQuickLoginQQ', { uin: '' });
    }
    catch {}
    try {
        await webuiCall(base, cred, '/api/QQLogin/RestartNapCat');
    }
    catch {}

    const deadline = Date.now() + NAPCAT_RESTART_WAIT_MS;
    let restartError = '';
    while (Date.now() < deadline) {
        await sleep(1000);
        try {
            cred = await webuiLogin(base, token);
            const state = await readLoginState(base, cred);
            if (!hasQqSession(state))
                return cred;
        }
        catch (error: any) {
            restartError = error?.message || '';
        }
    }
    throw new Error(`NapCat 重启后仍未能退出旧 QQ 登录${restartError ? `：${restartError}` : ''}`);
}

// 新建任务前检查并清理旧会话；本来就没登录时直接复用当前 credential，避免无谓重启。
async function clearStaleSession(base: string, token: string, cred: string): Promise<string> {
    try {
        const state = await readLoginState(base, cred);
        if (!hasQqSession(state))
            return cred;
    }
    catch {
        // 登录态读取失败时按"可能有残留会话"处理，保证能换号。
    }
    return await resetQqSession(base, token);
}

async function createLoginTask(owner = ''): Promise<QqLoginTask> {
    const settings = loginSettings();
    // NapCat 是单实例：新任务会让此前所有任务的二维码/授权作废，统一标记为完成，
    // 避免旧 taskId 被再次轮询或换取新登录产生的 code。
    for (const previous of sessions.values()) {
        if (!previous.done) {
            previous.done = true;
            previous.status = 'expired';
        }
    }
    const base = settings.napCatEndpoint;
    const token = settings.napCatSignature;

    // 每次都确保 NapCat 处于未登录态，这样拿到的都是可扫的新二维码，可以随时换号。
    let cred = await webuiLogin(base, token);
    cred = await clearStaleSession(base, token, cred);

    try {
        await webuiCall(base, cred, '/api/QQLogin/RefreshQRcode');
        await sleep(300);
    }
    catch {}

    let data: any;
    try {
        data = await webuiCall(base, cred, '/api/QQLogin/GetQQLoginQrcode');
    }
    catch (error: any) {
        if (/QQ Is Logined/i.test(error?.message || '')) {
            cred = await resetQqSession(base, token);
            data = await webuiCall(base, cred, '/api/QQLogin/GetQQLoginQrcode');
        }
        else {
            throw new Error(`获取 QQ 登录二维码失败：${error?.message || '未知错误'}`);
        }
    }
    const qrUrl = pickQrUrl(data);
    if (!qrUrl)
        throw new Error('NapCat 未返回登录二维码地址');
    const qrImage = await renderQrImage(qrUrl);
    if (!qrImage)
        throw new Error('二维码图片生成失败');

    const session = createSession({
        owner,
        base,
        token,
        cred,
        pluginPath: DEFAULT_PLUGIN_PATH,
        qrUrl,
        qrImage,
        status: 'waiting_scan',
    });
    return toTask(session);
}

async function queryLoginStatus(taskId: string, owner?: string): Promise<QqLoginTask> {
    const session = getSession(taskId, owner);
    if (session.done || Date.now() > session.expiresAt) {
        session.status = 'expired';
        return toTask(session);
    }

    try {
        const state = await readLoginState(session.base, session.cred);
        const phase = String(state?.loginPhase || state?.phase || state?.state || '').toLowerCase();
        const errorText = String(state?.loginError || state?.error || state?.errMsg || '').toLowerCase();

        if (hasQqSession(state)) {
            // 插件能签出 code 是登录成功的权威信号。
            const farmCode = await fetchFarmCode(session.base, session.pluginPath);
            if (farmCode) {
                session.code = farmCode.code;
                session.uin = farmCode.uin;
                session.nickname = farmCode.nickname;
                session.status = 'confirmed';
                return toTask(session);
            }

            // 已登录但 code 尚未就绪：补一次昵称，避免前端卡在备注提示。
            const profile = await fetchQqProfile(session.base, session.cred);
            session.uin = session.uin || profile.uin;
            session.nickname = session.nickname || profile.nickname;
            session.failCnt += 1;
            if (session.failCnt >= 4) {
                session.status = 'failed';
                session.error = 'QQ 已在 NapCat 登录，但取农场 Code 失败，请检查 qq-farm-code 插件';
                return toTask(session);
            }
            session.status = 'scanned';
            return toTask(session);
        }

        if (/expire|timeout|过期|失效/.test(errorText)) {
            session.status = 'expired';
            return toTask(session);
        }
        session.failCnt = 0;
        session.status = state?.qrLoginAccepted === true || phase.includes('scan') || phase.includes('confirm')
            ? 'scanned'
            : 'waiting_scan';
    }
    catch {
        // CheckLoginStatus 失败不影响主流程，保持当前状态。
    }
    return toTask(session);
}

async function getMiniappCode(taskId: string, owner?: string): Promise<QqMiniappLoginResult> {
    const session = getSession(taskId, owner);
    if (!session.code) {
        const farmCode = await fetchFarmCode(session.base, session.pluginPath);
        if (farmCode) {
            session.code = farmCode.code;
            session.uin = farmCode.uin;
            session.nickname = farmCode.nickname;
            session.status = 'confirmed';
        }
    }
    if (!session.code)
        throw new Error('QQ 登录尚未确认，请先完成扫码确认');

    // 昵称兜底顺序：插件昵称 → NapCat 用户信息 → uin，避免前端卡在"等待填写账号备注"。
    if (!session.nickname) {
        const profile = await fetchQqProfile(session.base, session.cred);
        session.nickname = profile.nickname;
        session.uin = session.uin || profile.uin;
    }
    const nickname = session.nickname || session.uin;
    return nickname
        ? { code: session.code, nickname, uin: session.uin || '' }
        : { code: session.code, uin: session.uin || '' };
}

async function cancelLoginTask(taskId: string, owner?: string): Promise<void> {
    const session = sessions.get(String(taskId || '').trim());
    if (!session)
        return;
    if (owner && session.owner && session.owner !== owner)
        throw new Error('无权访问该登录任务');
    const hadActiveLogin = session.status === 'confirmed' || session.status === 'scanned';
    session.done = true;
    session.status = 'cancelled';

    // 用户取消时若已扫码/确认，主动退出 NapCat 旧会话，保证下次能直接换号。
    if (hadActiveLogin) {
        try {
            await resetQqSession(session.base, session.token);
        }
        catch {}
    }
    const id = session.id;
    setTimeout(() => sessions.delete(id), 60_000).unref?.();
}

// 用账号绑定的 NapCat（留空回落全局 loginSettings）换取新的农场 Code。
// 与扫码流程不同：这里不新建登录任务、不校验 qqQrLogin 开关——账号本来就在跑，
// 只是被挤下线后需要一张新票据。NapCat 单实例只能登一个 QQ，所以调用方必须
// 用返回的 uin 与账号 uin 比对，避免把别的号写进这个账号。
async function refreshFarmCodeForAccount(account: any = {}): Promise<FarmCode> {
    const settings = store.getLoginSettings ? (store.getLoginSettings() || {}) : {};
    const base = String(account?.napCatBase || settings.napCatEndpoint || '').trim();
    if (!base)
        throw new Error('账号未配置 NapCat 地址，无法换取新 Code');
    const pluginPath = String(account?.pluginPath || DEFAULT_PLUGIN_PATH).trim() || DEFAULT_PLUGIN_PATH;
    // 账号级 Token 优先，留空回落全局 NapCat 签名：NapCat 开了鉴权时插件路由也要带上，
    // 否则换码会一直 401，表现为"插件没返回 Code"。
    const token = String(account?.napCatKey || settings.napCatSignature || '').trim();
    const appId = String(account?.appId || '').trim() || QQ_MINIAPP_APP_ID;
    const result = await fetchFarmCode(base, pluginPath, { token, appId });
    if (!result || !result.code)
        throw new Error('NapCat 未返回农场 Code，请检查 qq-farm-code 插件与 QQ 登录状态');
    return result;
}

export {
    cancelLoginTask,
    createLoginTask,
    getMiniappCode,
    QQ_MINIAPP_APP_ID,
    queryLoginStatus,
    refreshFarmCodeForAccount,
};
