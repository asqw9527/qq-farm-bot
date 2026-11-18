export {};
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeTextFileAtomic, readJsonFileStrict } = require('./json-db');

/**
 * 账号文件的静态加密存储（AES-256-GCM）。
 *
 * 为什么只加密 accounts：账号文件里存的是 code（农场登录票据）、
 * loginBuffer（微信可无限换新 Code 的长凭据）和 napCatKey（NapCat 控制权），
 * 拿到明文文件等于拿到这些账号。其余配置（系统设置、日志）不含登录凭据，
 * 保持明文便于排查。
 *
 * 密钥来源优先级：
 * 1. 环境变量 FARM_ACCOUNTS_KEY（32 字节 hex 或 base64），适合容器/密钥管理；
 * 2. 数据目录下的 accounts.key（首次自动生成，权限 600）。
 * 密钥丢失等于账号文件不可读，必须与备份分开保存。
 */

const MAGIC = 'qqfarm-accounts-v1';
const ALG = 'aes-256-gcm';
const KEY_FILE_NAME = 'accounts.key';
const KEY_ENV = 'FARM_ACCOUNTS_KEY';

function keyFilePath(filePath: string): string {
    return path.join(path.dirname(filePath), KEY_FILE_NAME);
}

function parseKey(raw: string, source: string): Buffer {
    const text = String(raw || '').trim();
    const buffer = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
    if (buffer.length !== 32) throw new Error(`${source} 必须是 32 字节密钥（64 位 hex 或 base64）`);
    return buffer;
}

function resolveKey(filePath: string): Buffer {
    const envKey = String(process.env[KEY_ENV] || '').trim();
    if (envKey) return parseKey(envKey, KEY_ENV);

    const target = keyFilePath(filePath);
    let existing = '';
    try {
        existing = fs.readFileSync(target, 'utf8');
    } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
    }
    if (existing.trim()) return parseKey(existing, '账号密钥文件 accounts.key');

    const created = crypto.randomBytes(32);
    // 0600：仅属主可读写。Windows 上 chmod 语义有限，但至少不会更宽松。
    fs.writeFileSync(target, `${created.toString('hex')}\n`, { mode: 0o600 });
    return created;
}

function isEncryptedEnvelope(payload: any): boolean {
    return !!payload && typeof payload === 'object' && payload.__enc === MAGIC;
}

/**
 * 读取并（必要时）解密。返回 encrypted 标记，调用方据此决定是否把旧明文迁移成密文。
 */
function readSecureJson(filePath: string, fallbackFactory?: () => any): { data: any; encrypted: boolean } {
    const payload = readJsonFileStrict(filePath, fallbackFactory);
    if (!isEncryptedEnvelope(payload)) return { data: payload, encrypted: false };

    const key = resolveKey(filePath);
    const iv = Buffer.from(String(payload.iv || ''), 'base64');
    const tag = Buffer.from(String(payload.tag || ''), 'base64');
    const body = Buffer.from(String(payload.data || ''), 'base64');
    if (iv.length !== 12 || tag.length !== 16 || body.length === 0)
        throw new Error('账号文件加密结构损坏（iv/tag/data 不完整）');

    const decipher = crypto.createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    return { data: JSON.parse(plain.toString('utf8')), encrypted: true };
}

function writeSecureJson(filePath: string, data: any, space = 2): void {
    const key = resolveKey(filePath);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALG, key, iv);
    const plain = Buffer.from(JSON.stringify(data, null, space), 'utf8');
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const envelope = {
        __enc: MAGIC,
        alg: ALG,
        v: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: body.toString('base64'),
    };
    writeTextFileAtomic(filePath, JSON.stringify(envelope, null, space));
}

/**
 * 把旧的明文账号文件迁移成密文。迁移前留一份 .plain.bak（只留一次），
 * 便于密钥/实现出问题时回滚。返回是否发生了迁移。
 */
function migratePlaintextIfNeeded(filePath: string, data: any): boolean {
    let exists = false;
    try {
        exists = fs.existsSync(filePath);
    } catch {
        exists = false;
    }
    if (exists) {
        const backup = `${filePath}.plain.bak`;
        try {
            if (!fs.existsSync(backup)) {
                fs.copyFileSync(filePath, backup);
                // 备份里是明文凭据：收紧到仅属主可读，迁移验证无误后应尽快删除。
                try { fs.chmodSync(backup, 0o600); } catch { /* Windows 上语义有限 */ }
            }
        } catch { /* 备份失败不阻塞迁移，密文写入仍会保留原文件内容 */ }
    }
    writeSecureJson(filePath, data);
    return exists;
}

module.exports = {
    readSecureJson,
    writeSecureJson,
    migratePlaintextIfNeeded,
    isEncryptedEnvelope,
    KEY_ENV,
};
