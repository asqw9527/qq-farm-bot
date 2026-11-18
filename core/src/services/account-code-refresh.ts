import { getNativeWxLoginCode } from './wx-login/native-protocol';

const { refreshFarmCodeForAccount } = require('./qq-login/service');
const store = require('../models/store');
// tsdk-runtime 是 CJS 导出，用 require 取官方小程序 appid 常量，避免硬编码漂移。
const { MINI_PROGRAM_APP_IDS } = require('../utils/tsdk-runtime');

/**
 * 挤号 / WS 400 之后换取一张新 Code。
 *
 * 为什么必须换码：被其他终端顶下线，说明对方是用「新 Code」登录的，服务端
 * 已经把账号里存的旧 Code 作废。拿旧 Code 反复重连只会一直撞 400。
 *
 * 两个平台的换码能力不对称：
 * - 微信：本地 MMTLS 协议，用扫码时保存的 loginBuffer 直接换，不依赖任何外部服务。
 *   也就是说微信账号不占 NapCat，想挂多少个都行。
 * - QQ：必须借助账号绑定的 NapCat + qq-farm-code 插件；NapCat 单实例只能登一个号，
 *   所以必须用返回的 uin 与账号 uin 比对，不一致就放弃，绝不能写错账号。
 *   一台机器只跑得起一个 NapCat 时，实际只有「NapCat 上正登着的那个 QQ」能自动换码，
 *   其余 QQ 账号换不了——用 canRefreshAccountCode 提前判定，别让它们白等 5 分钟再撞 400。
 */

export interface CodeRefreshOutcome {
    ok: boolean;
    code?: string;
    uin?: string;
    reason?: string;
    /** 换码成功但存在风险（例如老账号缺 uin，无法校验 NapCat 上是不是这个号）。 */
    warn?: string;
}

function normalizeUin(value: unknown): string {
    return String(value ?? '').trim();
}

function globalNapCatEndpoint(): string {
    try {
        const settings = store.getLoginSettings ? (store.getLoginSettings() || {}) : {};
        return String(settings.napCatEndpoint || '').trim();
    }
    catch {
        return '';
    }
}

/**
 * 这个账号到底有没有换码出口。
 *
 * 注意别用「函数存在」来判断能力——refreshAccountCode 永远存在，但账号可能
 * 既没有微信长凭据、也没有可用的 NapCat 地址，这时候挤号后的等待和重连纯属浪费，
 * 只会多撞几次 400。判定必须落到账号本身。
 */
export function canRefreshAccountCode(account: any): boolean {
    const platform = String(account?.platform || 'qq').trim().toLowerCase();
    if (platform === 'wx')
        return !!String(account?.loginBuffer || '').trim();
    // QQ：账号级地址优先，留空才有资格回落全局
    return !!String(account?.napCatBase || '').trim() || !!globalNapCatEndpoint();
}

export async function refreshAccountCode(account: any): Promise<CodeRefreshOutcome> {
    const platform = String(account?.platform || 'qq').trim().toLowerCase();

    if (platform === 'wx') {
        const loginBuffer = String(account?.loginBuffer || '').trim();
        if (!loginBuffer)
            return { ok: false, reason: '账号没有保存微信长凭据（loginBuffer），需要重新扫码' };
        const appId = String(account?.appId || MINI_PROGRAM_APP_IDS.wx).trim() || MINI_PROGRAM_APP_IDS.wx;
        const code = await getNativeWxLoginCode(loginBuffer, appId);
        if (!code)
            return { ok: false, reason: '微信本地换码未返回 Code' };
        return { ok: true, code: String(code).trim(), uin: normalizeUin(account?.uin) };
    }

    const result = await refreshFarmCodeForAccount(account);
    const expectedUin = normalizeUin(account?.uin || account?.qq);
    const gotUin = normalizeUin(result.uin);
    if (expectedUin && gotUin && expectedUin !== gotUin) {
        return {
            ok: false,
            reason: `NapCat 当前登录的 QQ（${gotUin}）与账号（${expectedUin}）不一致，已放弃写入`,
        };
    }
    // 老账号（本次改造前创建）没有 uin，只能相信 NapCat 上登的就是这个号。
    // 首次换码会把返回的 uin 补写进账号，之后就能真正校验，属于一次性放行。
    const warn = !expectedUin && gotUin
        ? `账号缺少 uin，无法校验 NapCat 当前登录号（${gotUin}），已按该号写入并将 uin 补记到账号`
        : '';
    return { ok: true, code: String(result.code).trim(), uin: gotUin || expectedUin, ...(warn ? { warn } : {}) };
}
