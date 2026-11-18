const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    readSecureJson,
    writeSecureJson,
    migratePlaintextIfNeeded,
} = require('../dist/services/secure-accounts-file.js');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'qqfarm-secure-'));
}

test('账号文件密文落盘，明文 Code 与 loginBuffer 不出现在文件里', () => {
    const dir = tempDir();
    const file = path.join(dir, 'accounts.json');
    const data = {
        accounts: [{ id: '1', name: 'A', code: 'SECRET-CODE-VALUE', loginBuffer: 'SECRET-BUFFER', napCatKey: 'SECRET-KEY' }],
        nextId: 2,
    };
    writeSecureJson(file, data);

    const raw = fs.readFileSync(file, 'utf8');
    assert.match(raw, /"__enc":\s*"qqfarm-accounts-v1"/);
    assert.equal(raw.includes('SECRET-CODE-VALUE'), false, '密文中不应出现明文 Code');
    assert.equal(raw.includes('SECRET-BUFFER'), false, '密文中不应出现明文 loginBuffer');
    assert.equal(raw.includes('SECRET-KEY'), false, '密文中不应出现明文 napCatKey');

    const restored = readSecureJson(file);
    assert.equal(restored.encrypted, true);
    assert.equal(restored.data.accounts[0].code, 'SECRET-CODE-VALUE');
    assert.equal(restored.data.accounts[0].loginBuffer, 'SECRET-BUFFER');

    // 同一目录复用同一把密钥，不需要重复生成
    const key = fs.readFileSync(path.join(dir, 'accounts.key'), 'utf8').trim();
    writeSecureJson(file, data);
    assert.equal(fs.readFileSync(path.join(dir, 'accounts.key'), 'utf8').trim(), key, '密钥文件应保持不变');
    assert.equal(readSecureJson(file).data.accounts[0].code, 'SECRET-CODE-VALUE');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('旧明文账号文件可被识别并迁移为密文，且留下一次性备份', () => {
    const dir = tempDir();
    const file = path.join(dir, 'accounts.json');
    const legacy = { accounts: [{ id: '1', name: 'A', code: 'LEGACY-CODE' }], nextId: 2 };
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2), 'utf8');

    const before = readSecureJson(file);
    assert.equal(before.encrypted, false, '明文文件应被识别为未加密');
    assert.equal(before.data.accounts[0].code, 'LEGACY-CODE');

    assert.equal(migratePlaintextIfNeeded(file, before.data), true);
    const after = readSecureJson(file);
    assert.equal(after.encrypted, true);
    assert.equal(after.data.accounts[0].code, 'LEGACY-CODE');

    const backup = path.join(dir, 'accounts.json.plain.bak');
    assert.equal(fs.existsSync(backup), true, '迁移应留下明文备份');
    assert.match(fs.readFileSync(backup, 'utf8'), /LEGACY-CODE/);

    fs.rmSync(dir, { recursive: true, force: true });
});

test('密文被篡改时解密失败而不是返回脏数据', () => {
    const dir = tempDir();
    const file = path.join(dir, 'accounts.json');
    writeSecureJson(file, { accounts: [{ id: '1', code: 'CODE-X' }], nextId: 2 });

    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    envelope.data = Buffer.from('tampered-payload').toString('base64');
    fs.writeFileSync(file, JSON.stringify(envelope), 'utf8');

    assert.throws(() => readSecureJson(file), /unable to authenticate|bad decrypt|结构/i);

    fs.rmSync(dir, { recursive: true, force: true });
});
