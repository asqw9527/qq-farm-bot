import type { Account, AccountsData } from '../../types/account';
export {};

const { ensureDataDir } = require('../../config/runtime-paths');
const { storageError } = require('../../services/json-db');
const { readSecureJson, writeSecureJson, migratePlaintextIfNeeded } = require('../../services/secure-accounts-file');

const { ACCOUNTS_FILE } = require('./shared-state');
let accountsCache: AccountsData | null = null;

function cloneAccounts(data: AccountsData): AccountsData {
    return { accounts: data.accounts.map(account => ({ ...account })), nextId: data.nextId };
}

function loadAccounts(): AccountsData {
    accountsCache = null;
    try {
        ensureDataDir();
        const loaded = readSecureJson(ACCOUNTS_FILE, () => ({ accounts: [], nextId: 1 }));
        const raw = loaded.data;
        if (!raw || !Array.isArray(raw.accounts)) throw new Error('Invalid accounts data');
        const data = normalizeAccountsData(raw);
        // 上游兼容：补齐旧账号缺失的 createdAt。
        // 本地安全增强：旧版本是明文 JSON，读到明文时立刻加密回写（含一次 .plain.bak 备份）。
        // 两者合并为一次保存，避免先明文回写再加密回写产生重复 I/O。
        const needCreatedAtBackfill = raw.accounts.some((account: any) => !Number(account?.createdAt));
        if (!loaded.encrypted && !loaded.missing) {
            try { migratePlaintextIfNeeded(ACCOUNTS_FILE, data); } catch { /* 交给下次保存 */ }
        } else if (needCreatedAtBackfill) {
            saveAccounts(data);
        }
        accountsCache = data;
        return cloneAccounts(data);
    } catch (error: any) {
        throw storageError('读取', ACCOUNTS_FILE, error);
    }
}

function saveAccounts(data: AccountsData): void {
    let normalized: AccountsData;
    try {
        ensureDataDir();
        normalized = normalizeAccountsData(data);
        // 账号文件含 code / loginBuffer / napCatKey，必须密文落盘。
        writeSecureJson(ACCOUNTS_FILE, normalized);
    }
    catch (error: any) { throw storageError('保存', ACCOUNTS_FILE, error); }
    accountsCache = normalized;
}

function getAccounts(): AccountsData {
    return accountsCache ? cloneAccounts(accountsCache) : loadAccounts();
}

function normalizeAccountsData(raw: unknown): AccountsData {
    const data: any = raw && typeof raw === 'object' ? raw : {};
    const accounts: Account[] = (Array.isArray(data.accounts) ? data.accounts : []).map(normalizeAccount);
    const maxId = accounts.reduce((m: number, a: any) => Math.max(m, Number.parseInt(a && a.id, 10) || 0), 0);
    let nextId = Number.parseInt(data.nextId, 10);
    if (!Number.isFinite(nextId) || nextId <= 0) nextId = maxId + 1;
    if (accounts.length === 0) nextId = 1;
    if (nextId <= maxId) nextId = maxId + 1;
    return { accounts, nextId };
}

function normalizeAccount(raw: any): Account {
    const source = raw && typeof raw === 'object' ? raw : {};
    const account: Account = {
        id: String(source.id || ''),
        name: String(source.name || ''),
        code: String(source.code || ''),
        platform: String(source.platform || 'qq'),
        uin: String(source.uin || ''),
        qq: String(source.qq || source.uin || ''),
        avatar: String(source.avatar || source.avatarUrl || ''),
        createdAt: Number(source.createdAt) || Date.now(),
        updatedAt: Number(source.updatedAt) || Date.now(),
    };
    const nick = String(source.nick || '').trim();
    if (nick) account.nick = nick;
    const username = String(source.username || '').trim();
    if (username) account.username = username;
    // 敏感/可选字段：只在有值时写入，避免产生大量空串字段。
    const wxid = String(source.wxid || '').trim();
    if (wxid) account.wxid = wxid;
    const loginBuffer = String(source.loginBuffer || '').trim();
    if (loginBuffer) account.loginBuffer = loginBuffer;
    const napCatBase = String(source.napCatBase || '').trim();
    if (napCatBase) account.napCatBase = napCatBase;
    const napCatKey = String(source.napCatKey || '').trim();
    if (napCatKey) account.napCatKey = napCatKey;
    const appId = String(source.appId || '').trim();
    if (appId) account.appId = appId;
    const ver = String(source.ver || '').trim();
    if (ver) account.ver = ver;
    return account;
}

function addOrUpdateAccount(acc: Partial<Account> & { avatarUrl?: string }): AccountsData {
    const { ensureAccountConfig } = require('./account-config');
    const data = getAccounts();
    let touchedAccountId = '';
    const source: any = acc || {};
    const cleanAccount: any = {};
    for (const key of ['id', 'name', 'code', 'platform', 'uin', 'qq', 'avatar', 'avatarUrl', 'nick', 'username',
        'wxid', 'loginBuffer', 'napCatBase', 'napCatKey', 'appId', 'ver']) {
        if (source[key] !== undefined) cleanAccount[key] = source[key];
    }
    acc = cleanAccount;
    if (acc.id) {
        const idx = data.accounts.findIndex(a => a.id === acc.id);
        if (idx >= 0) {
            data.accounts[idx] = { ...data.accounts[idx], ...acc, name: acc.name !== undefined ? acc.name : data.accounts[idx].name, updatedAt: Date.now() };
            touchedAccountId = String(data.accounts[idx].id || '');
        }
    } else {
        const id = data.nextId++;
        touchedAccountId = String(id);
        data.accounts.push({
            id: touchedAccountId,
            name: acc.name || `账号${id}`,
            code: acc.code || '',
            platform: acc.platform || 'qq',
            uin: acc.uin ? String(acc.uin) : '',
            qq: acc.qq ? String(acc.qq) : (acc.uin ? String(acc.uin) : ''),
            avatar: acc.avatar || acc.avatarUrl || '',
            // 归属人必须随账号一起落盘，否则新账号变成无归属账号，严格隔离后只有管理员可见。
            ...(acc.username ? { username: String(acc.username) } : {}),
            ...(acc.nick ? { nick: String(acc.nick) } : {}),
            ...(acc.wxid ? { wxid: String(acc.wxid) } : {}),
            ...(acc.loginBuffer ? { loginBuffer: String(acc.loginBuffer) } : {}),
            ...(acc.napCatBase ? { napCatBase: String(acc.napCatBase) } : {}),
            ...(acc.napCatKey ? { napCatKey: String(acc.napCatKey) } : {}),
            ...(acc.appId ? { appId: String(acc.appId) } : {}),
            ...(acc.ver ? { ver: String(acc.ver) } : {}),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
    }
    if (touchedAccountId) {
        ensureAccountConfig(touchedAccountId);
    }
    saveAccounts(data);
    return data;
}

// 解除某个用户名下所有账号的归属（删除用户时调用）。
// 解绑后账号变为无归属：普通用户不可见，仅管理员可见并可回收，避免同名重新注册继承旧账号。
function unbindAccountsByOwner(username: string): number {
    const name = String(username || '');
    if (!name) return 0;
    const data = getAccounts();
    let changed = 0;
    for (const account of data.accounts) {
        if (String((account as any).username || '') === name) {
            delete (account as any).username;
            account.updatedAt = Date.now();
            changed++;
        }
    }
    if (changed > 0) saveAccounts(data);
    return changed;
}

function deleteAccount(id: unknown): AccountsData {
    const { removeAccountConfig } = require('./account-config');
    const data = getAccounts();
    data.accounts = data.accounts.filter(a => a.id !== String(id));
    if (data.accounts.length === 0) {
        data.nextId = 1;
    }
    saveAccounts(data);
    removeAccountConfig(id);
    return data;
}

module.exports = {
    loadAccounts,
    saveAccounts,
    getAccounts,
    normalizeAccountsData,
    addOrUpdateAccount,
    deleteAccount,
    unbindAccountsByOwner,
};
