/**
 * 账号归属隔离测试：
 * - 管理员可见全部账号（含无归属旧账号）
 * - 普通用户仅可见归属自己的账号
 * - 无 req（内部管理调用）返回全部账号
 * - resolveAccId 对普通用户不越权解析他人账号
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');
const middleware = require(path.join(DIST, 'controllers', 'admin', 'middleware.js'));

const ALL_ACCOUNTS = [
    { id: 'acc-admin-legacy', name: '久安(qq)', username: '' },       // 无归属旧账号（管理员的）
    { id: 'acc-admin-own', name: '管理员新号', username: 'admin' },    // 管理员自有
    { id: 'acc-jmy', name: '小贾同学', username: 'jmy' },              // 普通用户 jmy 自有
    { id: 'acc-other', name: '他人账号', username: 'alice' },          // 其他普通用户
];

function makeCtx() {
    return {
        provider: {
            getAccounts: () => ({ accounts: JSON.parse(JSON.stringify(ALL_ACCOUNTS)) }),
            resolveAccountId: (ref) => ref, // 模拟 provider 能解析任意 ref（测试绕过防护）
        },
    };
}

function reqAs(user) {
    return { currentUser: user, headers: {} };
}

const ADMIN = { username: 'admin', role: 'admin', accountLimit: -1 };
const JMY = { username: 'jmy', role: 'user', accountLimit: 3 };

function ids(list) {
    return list.map(a => a.id).sort();
}

// 1) 管理员可见全部账号
{
    const list = middleware.getAccountList(makeCtx(), reqAs(ADMIN));
    assert.deepEqual(ids(list), ids(ALL_ACCOUNTS), '管理员应可见全部账号');
    console.log('ok 1 - 管理员可见全部账号（含无归属旧账号）');
}

// 2) 普通用户仅可见归属自己的账号
{
    const list = middleware.getAccountList(makeCtx(), reqAs(JMY));
    assert.deepEqual(ids(list), ['acc-jmy'], '普通用户仅可见自己账号，且看不到无归属旧账号');
    console.log('ok 2 - 普通用户仅可见归属自己的账号');
}

// 3) 未传 req（内部调用）返回全部账号
{
    const list = middleware.getAccountList(makeCtx());
    assert.deepEqual(ids(list), ids(ALL_ACCOUNTS), '无 req 的内部调用应返回全部账号');
    console.log('ok 3 - 无 req 内部调用返回全部账号');
}

// 4) 普通用户可见列表 ID 正常解析
{
    const id = middleware.resolveAccId(makeCtx(), 'acc-jmy', reqAs(JMY));
    assert.equal(id, 'acc-jmy', '普通用户应能解析自己的账号');
    console.log('ok 4 - 普通用户可解析自己的账号 ID');
}

// 5) 普通用户不能解析他人账号（provider 虽能解析，但被归属过滤拦截）
{
    const cases = ['acc-admin-legacy', 'acc-admin-own', 'acc-other'];
    for (const ref of cases) {
        const id = middleware.resolveAccId(makeCtx(), ref, reqAs(JMY));
        assert.equal(id, '', `普通用户不应解析到他人账号 ${ref}，实际得到 ${id}`);
    }
    console.log('ok 5 - 普通用户无法解析无归属/他人账号（含 provider 绕过）');
}

// 6) 管理员可解析任意账号
{
    const id = middleware.resolveAccId(makeCtx(), 'acc-admin-legacy', reqAs(ADMIN));
    assert.equal(id, 'acc-admin-legacy', '管理员应能解析任意账号');
    console.log('ok 6 - 管理员可解析任意账号');
}

console.log('\n账号归属隔离测试全部通过');
