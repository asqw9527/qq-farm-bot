export {};
/**
 * 兼容层：原单管理员存储已迁移到 user-store 的完整多用户体系。
 * 保留 getAdminInfo / validateAdmin / changePassword 三个接口，内部委托 user-store，
 * 确保旧调用方不受影响；admin 用户即 role='admin' 的用户记录。
 */
const userStore = require('./user-store');

interface AuthResult {
    username: string;
    role: string;
    cardCode?: string;
    accountLimit: number;
    expiresAt?: number;
    isPermanent?: boolean;
    mustChangePassword?: boolean;
}

function toLegacyInfo(result: AuthResult): any {
    return {
        username: result.username,
        role: result.role,
        mustChangePassword: result.mustChangePassword === true,
        accountLimit: result.accountLimit,
        expiresAt: result.expiresAt,
        isPermanent: result.isPermanent === true,
        cardCode: result.cardCode,
    };
}

function getAdminInfo(): any {
    const admin = userStore.getUserByUsername('admin');
    if (!admin) return { username: 'admin', role: 'admin', mustChangePassword: false, accountLimit: -1 };
    const auth = userStore.effectiveAccountLimit
        ? {
            username: admin.username,
            role: admin.role,
            cardCode: admin.cardCode,
            accountLimit: userStore.effectiveAccountLimit(admin),
            expiresAt: admin.expiresAt || (admin.card ? admin.card.expiresAt : undefined),
            isPermanent: admin.isPermanent === true || (!!admin.card && admin.card.isPermanent === true),
            mustChangePassword: admin.mustChangePassword === true,
        }
        : null;
    return toLegacyInfo(auth || {
        username: 'admin', role: 'admin', accountLimit: -1,
        mustChangePassword: admin.mustChangePassword === true,
    });
}

function validateAdmin(username: string, password: string, ip: string = 'unknown'): any {
    const result = userStore.validateUser(String(username), String(password), ip);
    if (!result.ok) {
        return {
            error: result.errorType || 'invalid_credentials',
            message: result.error,
            remainingMs: result.remainingMs,
        };
    }
    return toLegacyInfo(result.user);
}

function changePassword(oldPassword: string, newPassword: string): { ok: boolean; error?: string; message?: string } {
    const result = userStore.changeUserPassword('admin', String(oldPassword), String(newPassword));
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, message: '密码修改成功' };
}

module.exports = { getAdminInfo, validateAdmin, changePassword };
