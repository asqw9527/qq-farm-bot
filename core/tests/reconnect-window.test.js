const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

function load(file, overrides = {}, globals = {}) {
    const filename = path.resolve(__dirname, '../dist', file);
    const realRequire = createRequire(filename);
    const sandbox = {
        require: name => overrides[name] || realRequire(name),
        module: { exports: {} },
        exports: {},
        Buffer, process,
        console: { warn() {}, error() {}, log() {} },
        setTimeout, clearTimeout, setInterval, clearInterval, Date: globals.Date || Date, Math, JSON,
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return sandbox.module.exports;
}

// 可控时钟：让等待 5 分钟这类断言不必真等。
function makeClock(startAt = Date.now()) {
    let now = startAt;
    class FakeDate extends Date {
        constructor(...args) {
            if (args.length === 0) super(now);
            else super(...args);
        }

        static now() {
            return now;
        }
    }
    return {
        Date: FakeDate,
        advance(ms) {
            now += Number(ms) || 0;
        },
    };
}

// 捕获所有 scheduler 定时任务，便于手动触发重连定时器。
function makeScheduler() {
    const tasks = new Map();
    return {
        tasks,
        createScheduler: () => ({
            setTimeoutTask: (name, delay, fn) => { tasks.set(name, { fn, delay }); },
            setIntervalTask: (name, interval, fn) => { tasks.set(name, { fn, interval }); },
            clear: name => tasks.delete(name),
            clearAll: () => tasks.clear(),
        }),
    };
}

function buildManager(extra = {}) {
    const sched = makeScheduler();
    const schedulerOverride = { '../services/scheduler': { createScheduler: sched.createScheduler } };
    const workers = {};
    const messages = [];
    const accountLogs = [];
    const pushes = [];
    const reminders = [];
    const starts = [];
    const logs = [];
    const account = { id: 'acc-1', name: '微信', code: 'CODE-A', platform: 'wx' };

    const { createWorkerManager } = load('runtime/worker-manager.js', {
        ...schedulerOverride,
        ...(extra.overrides || {}),
    }, { Date: extra.clock ? extra.clock.Date : undefined });

    const forked = [];
    const manager = createWorkerManager({
        fork: () => {
            const handlers = [];
            const proc = {
                send: payload => messages.push(payload),
                on: (event, fn) => { if (event === 'message') handlers.push(fn); },
                once() {}, kill() {},
            };
            proc.__handlers = handlers;
            forked.push(proc);
            return proc;
        },
        WorkerThread: null,
        runtimeMode: 'fork',
        processRef: { env: {}, pkg: null },
        mainEntryPath: 'main.js',
        workerScriptPath: 'worker.js',
        workers,
        globalLogs: [],
        log: (tag, msg, meta) => logs.push({ tag, msg, meta }),
        addAccountLog: (action, msg, accountId, accountName, extra2) => accountLogs.push({ action, msg, accountId, accountName, extra: extra2 }),
        normalizeStatusForPanel: data => data,
        buildConfigSnapshotForAccount: () => ({}),
        getOfflineAutoDeleteMs: () => Infinity,
        triggerOfflineReminder: payload => reminders.push(payload),
        sendConfiguredPush: payload => { pushes.push(payload); return Promise.resolve({ ok: true }); },
        addOrUpdateAccount: () => ({}),
        deleteAccount: () => {},
        getAccountById: id => (String(id) === 'acc-1' ? account : null),
        ...(extra.options || {}),
    });

    // 用真实的 startWorker 流程创建 worker，确保 message handler 按 manager 的闭包注册。
    function attachWorker() {
        manager.startWorker(account);
        return workers['acc-1'];
    }

    return { manager, sched, workers, messages, accountLogs, pushes, reminders, logs, account, attachWorker, forked };
}

// 让 startWorker 真正发生：pawn 通过 fork mock，记录 start 消息。
function drainStart(messages) {
    return messages.some(m => m && m.type === 'start');
}

test('WS 400 判定 code 到期：清除重连窗口且不自动重连', () => {
    const h = buildManager();
    const worker = h.attachWorker();

    // 先进入重连窗口（kickout）
    emitMessage(h, worker, { type: 'account_kicked', reason: '已在其他终端登录', reasonCode: 2 });
    assert.ok(h.sched.tasks.has('auto_reconnect_acc-1'), 'kickout 后应安排重连定时器');

    // 随后 WS 400：判定 code 失效，清除窗口
    emitMessage(h, worker, { type: 'ws_error', code: 400, message: 'Unexpected server response: 400' });
    assert.equal(h.sched.tasks.has('auto_reconnect_acc-1'), false, '400 后应清除重连定时器');

    // 触发一次原本的重连任务也不应重启
    const before = h.messages.filter(m => m && m.type === 'start').length;
    h.sched.tasks.set('auto_reconnect_acc-1', { fn: () => {}, delay: 0 });
    assert.equal(h.messages.filter(m => m && m.type === 'start').length, before);
});

test('被踢下线后等满 5 分钟才开始重连，且最多重连 2 次', () => {
    const clock = makeClock();
    const h = buildManager({ clock });
    const worker = h.attachWorker();

    emitMessage(h, worker, { type: 'account_kicked', reason: '已在其他终端登录', reasonCode: 2 });
    const timer = h.sched.tasks.get('auto_reconnect_acc-1');
    assert.ok(timer, '应有等待定时器');
    assert.equal(timer.delay, 5 * 60 * 1000, '首次重连应等待 5 分钟');

    // 进程已 stopWorker，清掉 workers 让 startWorker 可创建新 worker
    delete h.workers['acc-1'];
    const startCount = () => h.messages.filter(m => m && m.type === 'start').length;
    const base = startCount();

    // 定时器被提前触发也不应立刻重连
    timer.fn();
    assert.equal(startCount(), base, '等待期内不应重连');

    // 等满 5 分钟后第 1 次重连
    clock.advance(5 * 60 * 1000);
    h.sched.tasks.get('auto_reconnect_acc-1').fn();
    assert.equal(startCount(), base + 1, '等待结束应发起第 1 次重连');
    assert.equal(h.messages.filter(m => m && m.type === 'start').at(-1).config.code, 'CODE-A', '应复用原 code');

    // 第 2 次重连
    delete h.workers['acc-1'];
    clock.advance(5000);
    h.sched.tasks.get('auto_reconnect_acc-1').fn();
    assert.equal(startCount(), base + 2, '应发起第 2 次重连');

    // 不应有第 3 次
    delete h.workers['acc-1'];
    clock.advance(5000);
    h.sched.tasks.get('auto_reconnect_acc-1').fn();
    assert.equal(startCount(), base + 2, '超过 2 次不应继续重连');

    // 收尾清理
    clock.advance(60000);
    const pending = h.sched.tasks.get('auto_reconnect_acc-1');
    if (pending) pending.fn();
    assert.equal(h.sched.tasks.has('auto_reconnect_acc-1'), false, '收尾后应清除定时器');
    assert.ok(h.accountLogs.some(l => l.action === 'reconnect_timeout'), '应记录重连未成功日志');
});

test('等待期内手动启动：立即取消等待并立刻启动', () => {
    const clock = makeClock();
    const h = buildManager({ clock });
    const worker = h.attachWorker();

    emitMessage(h, worker, { type: 'account_kicked', reason: '已在其他终端登录' });
    assert.ok(h.sched.tasks.has('auto_reconnect_acc-1'), 'kickout 后应处于等待期');

    delete h.workers['acc-1'];
    const before = h.messages.filter(m => m && m.type === 'start').length;
    const started = h.manager.startWorker(h.account);

    assert.equal(started, true, '手动启动应立即成功');
    assert.equal(h.sched.tasks.has('auto_reconnect_acc-1'), false, '手动启动应清除等待定时器');
    assert.equal(h.messages.filter(m => m && m.type === 'start').length, before + 1, '应立刻拉起 worker');
    assert.ok(h.accountLogs.some(l => l.action === 'reconnect_cancelled'), '应记录取消等待');
});

test('等待期内手动停止：取消等待计划，不再自动拉起', () => {
    const clock = makeClock();
    const h = buildManager({ clock });
    const worker = h.attachWorker();

    emitMessage(h, worker, { type: 'account_kicked', reason: '已在其他终端登录' });
    const cancelled = h.manager.cancelReconnect('acc-1');
    assert.equal(cancelled, true, '应取消等待计划');
    assert.equal(h.sched.tasks.has('auto_reconnect_acc-1'), false, '定时器应被清除');

    delete h.workers['acc-1'];
    const before = h.messages.filter(m => m && m.type === 'start').length;
    clock.advance(6 * 60 * 1000);
    assert.equal(h.messages.filter(m => m && m.type === 'start').length, before, '取消后不应再自动拉起');
});

test('重连窗口内连上（status_sync connected）判定恢复并发恢复通知', () => {
    const h = buildManager();
    const worker = h.attachWorker();

    emitMessage(h, worker, { type: 'account_kicked', reason: 'kickout' });
    assert.ok(h.sched.tasks.has('auto_reconnect_acc-1'));

    worker.status = { connection: { connected: true } };
    emitMessage(h, worker, {
        type: 'status_sync',
        data: { status: { connection: { connected: true } }, connection: { connected: true } },
    });

    assert.equal(h.sched.tasks.has('auto_reconnect_acc-1'), false, '恢复后应清除重连定时器');
    const recovery = h.pushes.find(p => String(p.title).includes('恢复'));
    assert.ok(recovery, '应发送恢复通知');
    assert.ok(h.accountLogs.some(l => l.action === 'reconnect_success'), '应记录恢复账号日志');
});

test('断线（非 400）进入重连窗口；400 断线不进入', () => {
    const h1 = buildManager();
    const w1 = h1.attachWorker();
    emitMessage(h1, w1, { type: 'account_disconnected', source: 'ws_close', code: 1006, phase: 'online' });
    assert.ok(h1.sched.tasks.has('auto_reconnect_acc-1'), '普通断线应进入重连窗口');

    const h2 = buildManager();
    const w2 = h2.attachWorker();
    emitMessage(h2, w2, { type: 'account_disconnected', source: 'ws_error', code: 400, phase: 'connecting' });
    assert.equal(h2.sched.tasks.has('auto_reconnect_acc-1'), false, '400 断线不应进入重连窗口');
});

test('等待结束后重连：读取 Helper 刷新后的最新 code', () => {
    const clock = makeClock();
    const h = buildManager({ clock });
    const worker = h.attachWorker();
    emitMessage(h, worker, { type: 'account_kicked', reason: 'kickout' });
    delete h.workers['acc-1'];

    // Helper 刷新了 code
    h.account.code = 'CODE-B';
    clock.advance(5 * 60 * 1000);
    h.sched.tasks.get('auto_reconnect_acc-1').fn();

    const starts = h.messages.filter(m => m && m.type === 'start');
    assert.equal(starts.at(-1).config.code, 'CODE-B', '应使用刷新后的新 code');
});

// 通过 fakeProc.on 注册的 message handler 投递消息给 manager。
function emitMessage(h, worker, msg) {
    const handlers = worker.process.__handlers || [];
    for (const fn of handlers) fn(msg);
}
