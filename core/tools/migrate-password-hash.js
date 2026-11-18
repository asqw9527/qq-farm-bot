/**
 * 密码存储迁移脚本：把老账号的 PBKDF2(明文) 升级为 PBKDF2(SHA-256(明文))。
 *
 * 背景：前端改为传输 SHA-256 摘要后，后端收到的都是摘要。
 * 为保证原密码不变，需要把每个老账号的存储从「用明文做 PBKDF2」
 * 升级为「用摘要做 PBKDF2」。升级后用户输入原密码，
 * 前端哈希成摘要，后端校验即可通过。
 *
 * 用法（在 core 目录下执行）：
 *   node tools/migrate-password-hash.js <用户名> <原密码>
 *   node tools/migrate-password-hash.js --all <映射文件.json>
 *
 * 映射文件格式（仅 --all 模式使用，注意保管，含明文密码）：
 *   { "admin": "原密码", "alice": "原密码" }
 *
 * 脚本只改 users.json，不动其他数据；执行前会自动备份为 users.json.bak。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SALT_LENGTH = 32;
const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const DIGEST = 'sha512';

const dataFile = path.join(__dirname, '..', 'data', 'users.json');

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hashPassword(password, salt = null) {
    const nextSalt = salt || crypto.randomBytes(SALT_LENGTH).toString('hex');
    const hash = crypto.pbkdf2Sync(password, nextSalt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
    return `${nextSalt}:${hash}`;
}

function verifyPassword(password, stored) {
    if (typeof stored !== 'string') return false;
    if (stored.includes(':')) {
        const [salt, hash] = stored.split(':');
        const next = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
        return hash === next;
    }
    return stored === sha256(password);
}

function normalize(raw) {
    if (!raw || typeof raw !== 'object') return { users: [] };
    const users = Array.isArray(raw.users) ? raw.users.filter(u => u && typeof u === 'object') : [];
    return { ...raw, users };
}

function main() {
    const args = process.argv.slice(2);
    if (!fs.existsSync(dataFile)) {
        console.error(`[错误] 找不到数据文件：${dataFile}`);
        process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const data = normalize(raw);
    if (!data.users.length) {
        console.error('[错误] users.json 中没有用户');
        process.exit(1);
    }

    let mapping = {};
    if (args[0] === '--all') {
        const mapFile = args[1];
        if (!mapFile || !fs.existsSync(mapFile)) {
            console.error('[错误] --all 模式需要指定映射文件路径');
            process.exit(1);
        }
        mapping = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    } else {
        const [username, password] = args;
        if (!username || !password) {
            console.error('用法：node tools/migrate-password-hash.js <用户名> <原密码>');
            console.error('  或：node tools/migrate-password-hash.js --all <映射文件.json>');
            process.exit(1);
        }
        mapping[username] = password;
    }

    const backup = `${dataFile}.bak`;
    fs.writeFileSync(backup, JSON.stringify(raw, null, 2), 'utf8');
    console.log(`[备份] 已写入 ${backup}`);

    let migrated = 0;
    let skipped = 0;
    let failed = 0;
    for (const user of data.users) {
        const username = String(user.username || '');
        const plain = mapping[username];
        if (!plain) {
            console.log(`[跳过] ${username}：未提供原密码`);
            skipped++;
            continue;
        }
        const digest = sha256(plain);
        // 已是摘要模式：PBKDF2(摘要) 校验通过，无需迁移
        if (verifyPassword(digest, user.password)) {
            console.log(`[跳过] ${username}：已是摘要模式`);
            skipped++;
            continue;
        }
        // 老模式：用原密码校验 PBKDF2(明文)，通过后升级为 PBKDF2(摘要)
        if (!verifyPassword(plain, user.password)) {
            console.error(`[失败] ${username}：原密码校验不通过，未迁移`);
            failed++;
            continue;
        }
        user.password = hashPassword(digest);
        if (user.mustChangePassword) user.mustChangePassword = false;
        console.log(`[成功] ${username}：已升级为摘要模式（原密码不变）`);
        migrated++;
    }

    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
    console.log(`\n[完成] 迁移 ${migrated}，跳过 ${skipped}，失败 ${failed}`);
    if (failed > 0) {
        console.error('[警告] 存在失败项，请核对原密码后重试；原始数据可从 .bak 恢复');
        process.exit(2);
    }
}

main();
