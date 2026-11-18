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
// 1x1 透明 PNG：NapCat 已登录时免扫码，前端仍要求 qr_image 非空。
const BLANK_QR_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
}

interface QqSession {
    id: string;
    base: string;
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

function pickQrUrl(data: any): string {
    for (const key of ['qrcodeUrl', 'QrcodeUrl', 'qrcode_url', 'qrUrl', 'url', 'URL']) {
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
async function fetchFarmCode(base: string, pluginPath: string): Promise<FarmCode | null> {
    const endpoint = `${apiUrl(base, '/plugin')}/${pluginPath}/api/proto/code`;
    const query = new URLSearchParams({ appid: QQ_MINIAPP_APP_ID });
    let response;
    try {
        response = await axios.get(`${endpoint}?${query.toString()}`, {
            timeout: CODE_TIMEOUT_MS,
            validateStatus: (status: number) => status === 200,
        });
    }
    catch {
        return null;
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

function createSession(values: Partial<QqSession> & Pick<QqSession, 'base' | 'cred' | 'pluginPath' | 'qrUrl' | 'qrImage' | 'status'>): QqSession {
    const session: QqSession = {
        id: makeId(),
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

function getSession(taskId: string): QqSession {
    const session = sessions.get(String(taskId || '').trim());
    if (!session)
        throw new Error('QQ 登录会话不存在或已过期');
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

async function createLoginTask(): Promise<QqLoginTask> {
    const settings = loginSettings();
    const base = settings.napCatEndpoint;
    const token = settings.napCatSignature;

    // NapCat 已登录时插件可直接签出 code，免扫码。
    let farmCode: FarmCode | null = null;
    try {
        farmCode = await fetchFarmCode(base, DEFAULT_PLUGIN_PATH);
    }
    catch {
        farmCode = null;
    }
    if (farmCode) {
        const session = createSession({
            base,
            cred: '',
            pluginPath: DEFAULT_PLUGIN_PATH,
            qrUrl: '',
            qrImage: BLANK_QR_IMAGE,
            status: 'confirmed',
            code: farmCode.code,
            uin: farmCode.uin,
            nickname: farmCode.nickname,
        });
        return toTask(session);
    }

    const cred = await webuiLogin(base, token);
    let qrUrl = '';
    try {
        try {
            await webuiCall(base, cred, '/api/QQLogin/RefreshQRcode');
        }
        catch {
            // 旧版 NapCat 可能没有刷新接口，忽略后直接取二维码。
        }
        const data = await webuiCall(base, cred, '/api/QQLogin/GetQQLoginQrcode');
        qrUrl = pickQrUrl(data);
    }
    catch (error: any) {
        throw new Error(`获取 QQ 登录二维码失败：${error?.message || '未知错误'}`);
    }
    if (!qrUrl)
        throw new Error('NapCat 未返回登录二维码地址');
    const qrImage = await renderQrImage(qrUrl);
    if (!qrImage)
        throw new Error('二维码图片生成失败');

    const session = createSession({
        base,
        cred,
        pluginPath: DEFAULT_PLUGIN_PATH,
        qrUrl,
        qrImage,
        status: 'waiting_scan',
    });
    return toTask(session);
}

async function queryLoginStatus(taskId: string): Promise<QqLoginTask> {
    const session = getSession(taskId);
    if (session.done || Date.now() > session.expiresAt) {
        session.status = 'expired';
        return toTask(session);
    }

    // 插件能签出 code 是登录成功的权威信号。
    let farmCode: FarmCode | null = null;
    try {
        farmCode = await fetchFarmCode(session.base, session.pluginPath);
    }
    catch {
        farmCode = null;
    }
    if (farmCode) {
        session.code = farmCode.code;
        session.uin = farmCode.uin;
        session.nickname = farmCode.nickname;
        session.status = 'confirmed';
        return toTask(session);
    }

    // 否则用 CheckLoginStatus 更新等待/已扫码提示。
    try {
        const state = await webuiCall(session.base, session.cred, '/api/QQLogin/CheckLoginStatus');
        const online = state?.online === true || state?.login === true
            || ['online', 'logged_in'].includes(String(state?.status || '').toLowerCase());
        const phase = String(state?.phase || state?.loginPhase || state?.state || '').toLowerCase();
        const errorText = String(state?.error || state?.errMsg || state?.err || '').toLowerCase();
        session.failCnt = online ? session.failCnt + 1 : 0;

        if (/expire|timeout|过期|失效/.test(errorText)) {
            session.status = 'expired';
            return toTask(session);
        }
        if (session.failCnt >= 4) {
            session.status = 'failed';
            session.error = 'QQ 已在 NapCat 登录，但取农场 Code 失败，请检查 qq-farm-code 插件';
            return toTask(session);
        }
        session.status = online || phase.includes('confirm') || phase === 'scanned'
            ? 'scanned'
            : 'waiting_scan';
    }
    catch {
        // CheckLoginStatus 失败不影响主流程，保持当前状态。
    }
    return toTask(session);
}

async function getMiniappCode(taskId: string): Promise<QqMiniappLoginResult> {
    const session = getSession(taskId);
    if (!session.code) {
        let farmCode: FarmCode | null = null;
        try {
            farmCode = await fetchFarmCode(session.base, session.pluginPath);
        }
        catch {
            farmCode = null;
        }
        if (farmCode) {
            session.code = farmCode.code;
            session.uin = farmCode.uin;
            session.nickname = farmCode.nickname;
            session.status = 'confirmed';
        }
    }
    if (!session.code)
        throw new Error('QQ 登录尚未确认，请先完成扫码确认');
    return session.nickname
        ? { code: session.code, nickname: session.nickname }
        : { code: session.code };
}

async function cancelLoginTask(taskId: string): Promise<void> {
    const session = sessions.get(String(taskId || '').trim());
    if (!session)
        return;
    session.done = true;
    session.status = 'cancelled';
    const id = session.id;
    setTimeout(() => sessions.delete(id), 60_000).unref?.();
}

export {
    cancelLoginTask,
    createLoginTask,
    getMiniappCode,
    QQ_MINIAPP_APP_ID,
    queryLoginStatus,
};
