export {};

/**
 * 微信扫码完成到账号落盘之间的凭据中转站。
 *
 * 扫码任务的 `confirm` 与 `code` 是分开的两次请求，而 `loginBuffer` 是换取
 * 新 Code 的长凭据，绝不能经浏览器中转（前端只需要拿到 code 和 openid）。
 * 这里把 openid → loginBuffer 暂存在服务端内存，账号创建时按 openid 取出，
 * 一次性消费，过期自动丢弃。
 *
 * 进程重启会丢失待用凭据，但此时扫码任务本身也已失效，用户重新扫码即可。
 */

interface PendingCredential {
    loginBuffer: string;
    expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, PendingCredential>();

function sweep(now: number): void {
    for (const [key, value] of pending) {
        if (value.expiresAt <= now) pending.delete(key);
    }
}

export function putWxLoginCredential(openid: string, loginBuffer: string): void {
    const key = String(openid || '').trim();
    const buffer = String(loginBuffer || '').trim();
    if (!key || !buffer) return;
    const now = Date.now();
    sweep(now);
    pending.set(key, { loginBuffer: buffer, expiresAt: now + PENDING_TTL_MS });
}

/**
 * 取出并删除某个 openid 的待用凭据。返回空串表示没有可用凭据。
 * 同一 openid 重复扫码时后一次覆盖前一次，避免旧 buffer 被误用。
 */
export function takeWxLoginCredential(openid: string): string {
    const key = String(openid || '').trim();
    if (!key) return '';
    const now = Date.now();
    sweep(now);
    const entry = pending.get(key);
    if (!entry) return '';
    pending.delete(key);
    return entry.expiresAt > now ? entry.loginBuffer : '';
}

/** 仅供测试/诊断：查看待用凭据数量，不暴露内容。 */
export function pendingWxCredentialCount(): number {
    sweep(Date.now());
    return pending.size;
}
