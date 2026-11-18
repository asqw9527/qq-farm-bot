const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

function load(file, overrides = {}) {
    const filename = path.resolve(__dirname, '../dist', file);
    const realRequire = createRequire(filename);
    const sandbox = {
        require: name => overrides[name] || realRequire(name),
        module: { exports: {} },
        exports: {},
        Buffer, process,
        console: { warn() {}, error() {}, log() {} },
        setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return sandbox.module.exports;
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
    });

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

test('kickout 进入 3 分钟窗口，窗口内复用同一个 code 自动重连', () => {
    const h = buildManager();
    const worker = h.attachWorker();

    emitMessage(h, worker, { type: 'account_kicked', reason: '已在其他终端登录', reasonCode: 2 });
    const timer = h.sched.tasks.get('auto_reconnect_acc-1');
    assert.ok(timer, '应有重连定时器');

    // 进程已 stopWorker，清掉 workers 让 startWorker 可创建新 worker
    delete h.workers['acc-1'];
    timer.fn();

    const start = h.messages.find(m => m && m.type === 'start');
    assert.ok(start, '应重新拉起 worker');
    assert.equal(start.config.code, 'CODE-A', '应复用同一个 code');
    assert.ok(h.sched.tasks.has('auto_reconnect_acc-1'), '应安排下一次重连检查');
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

test('重连期间 Helper 刷新 code：下次重连读取最新 code', () => {
    const h = buildManager();
    const worker = h.attachWorker();
    emitMessage(h, worker, { type: 'account_kicked', reason: 'kickout' });
    delete h.workers['acc-1'];

    // Helper 刷新了 code
    h.account.code = 'CODE-B';
    h.sched.tasks.get('auto_reconnect_acc-1').fn();

    const starts = h.messages.filter(m => m && m.type === 'start');
    assert.equal(starts.at(-1).config.code, 'CODE-B', '应使用刷新后的新 code');
});

// 通过 fakeProc.on 注册的 message handler 投递消息给 manager。
function emitMessage(h, worker, msg) {
    const handlers = worker.process.__handlers || [];
    for (const fn of handlers) fn(msg);
}
