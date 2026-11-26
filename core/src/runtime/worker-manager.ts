export {};
const { createScheduler } = require('../services/scheduler');

const { BackendChildTracker } = require('@qq-farm-bot/session-contract');
const { accountSessionKey, findAccountSession, listHostedSessions, stopHostedAccount } = require('../session/ipc');
const { getRuntimePaths } = require('../config/runtime-paths');
const path = require('node:path');

const DEFAULT_API_CALL_TIMEOUT_MS = 10000;
// 被踢下线（其他位置登录）后：先静默等待固定时长，避开与另一处登录互相顶号，
// 等待结束后再用当前保存的同一个 code 重连固定次数。
const KICKOUT_RECONNECT_WAIT_MS = 5 * 60 * 1000;
const KICKOUT_RECONNECT_ATTEMPTS = 2;
// 最后一次尝试后的判定余量：给 worker 时间连上并回传状态，再收尾。
const KICKOUT_RECONNECT_FINALIZE_MS = 30000;
// 普通断线（非 400）自动重连：仅当 code 未被判定失效（未收到 WS 400）时启用。
// 窗口内复用账号当前保存的同一个 code 周期性拉起 worker，不把 code 当一次性消耗。
const RECONNECT_WINDOW_MS = 3 * 60 * 1000;
const RECONNECT_FIRST_DELAY_MS = 3000;
const RECONNECT_RETRY_MS = 5000;
// 好友现场天气需要逐个 Enter/Leave，单批最多 5 位好友；
// 好友列表只读缓存或拉一次名单，给的余量少一些。
const API_CALL_TIMEOUTS_MS: Record<string, number> = {
    getPetDiary: 90000,
    operatePetDiary: 180000,
    getPetDiaryRecords: 30000,
    getPetDiaryFriend: 30000,
    scanWeatherFriends: 60000,
    getWeatherFriends: 30000,
    clearRanchIllustratedNew: 40000,
};

interface WorkerManagerOptions {
    fork: any;
    WorkerThread: any;
    runtimeMode?: string;
    processRef: any;
    mainEntryPath: string;
    workerScriptPath: string;
    workers: Record<string, any>;
    globalLogs: any[];
    log: (tag: string, msg: string, extra?: any) => void;
    addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
    normalizeStatusForPanel: (data: any, accountId: string, accountName: string) => any;
    buildConfigSnapshotForAccount: (accountId: string) => any;
    getOfflineAutoDeleteMs: () => number;
    triggerOfflineReminder: (payload: any) => void;
    sendConfiguredPush?: (payload: any) => Promise<void> | void;
    addOrUpdateAccount: (acc: any) => any;
    deleteAccount: (id: string) => void;
    onStatusSync?: (accountId: string, status: any, accountName?: string) => void;
    onWorkerLog?: (entry: any, accountId: string, accountName?: string) => void;
    getAccountById?: (accountId: string) => any;
    // 挤号/400 后换取新 Code：微信走本地长凭据，QQ 走账号绑定的 NapCat（含 uin 比对）
    refreshAccountCode?: (account: any) => Promise<{ ok: boolean; code?: string; uin?: string; reason?: string; warn?: string }>;
    // 这个账号是否有换码出口（微信长凭据 / 可用 NapCat）。缺省视为有，兼容旧调用方。
    canRefreshAccountCode?: (account: any) => boolean;
}

function createWorkerManager(options: WorkerManagerOptions) {
    const {
        fork,
        WorkerThread,
        runtimeMode = 'thread',
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        sendConfiguredPush,
        addOrUpdateAccount,
        deleteAccount,
        onStatusSync,
        onWorkerLog,
        getAccountById,
        refreshAccountCode,
        canRefreshAccountCode,
    } = options;
    const managerScheduler = createScheduler('worker_manager');

    // 重连计划：key=accountId。收到 WS 400（code 失效）时清除并不再重连。
    // kickout：被其他位置顶下线，先等待 waitUntil 再用同一个 code 重连 attemptsLeft 次；
    // disconnect：普通断线，在 until 之前按间隔快速重连。
    type ReconnectPlan = {
        mode: 'kickout' | 'disconnect';
        reason: string;
        // kickout：等待期结束时间（到达后才开始重连）；disconnect 不使用
        waitUntil?: number;
        // kickout：整体收尾时间（等待期 + 最后一次尝试的判定余量）；disconnect：重试窗口截止时间
        until: number;
        // kickout：剩余重连次数；disconnect 不使用
        attemptsLeft: number;
    };
    const reconnectWindows = new Map<string, ReconnectPlan>();
    // 正在进行"手动启动前换码"的账号。换码要十几秒且期间没有 worker，
    // 不加标记的话用户在换码途中再点一次启动，会因为重连计划已被清空而
    // 直接拿旧 Code 同步启动，又撞一次 400。
    const codeRefreshing = new Set<string>();

    // 该账号有没有换码出口（微信长凭据 / 可用 NapCat）。
    // 两个场景的"未注入时默认值"不一样，别合并成一个：
    // - 被踢：本来就只是"等 5 分钟复用旧 Code"，换码是增强，判不出来时保持旧行为（按有处理）；
    // - WS 400：原本只有具备换码能力才重连，判不出来时沿用"换码函数存在即视为有"。
    function accountCanRefreshOnKickout(account: any): boolean {
        if (typeof canRefreshAccountCode === 'function') {
            try {
                return !!canRefreshAccountCode(account);
            }
            catch {
                return true;
            }
        }
        return true;
    }

    function accountCanRefreshOn400(account: any): boolean {
        if (typeof canRefreshAccountCode === 'function') {
            try {
                return !!canRefreshAccountCode(account);
            }
            catch {
                return false;
            }
        }
        return typeof refreshAccountCode === 'function';
    }
    const useThreadRuntime = runtimeMode === 'thread' && !(processRef as any).pkg && typeof WorkerThread === 'function';

    const managed = Boolean(processRef.env.FARM_SESSION_SOCKET);
    const tracker = managed && !useThreadRuntime ? new BackendChildTracker(path.join(getRuntimePaths().runtimeDir, 'backend-children.json')) : null;
    let shuttingDown = false;

    function createThreadWorker(account: any): any {
        const workerOptions: any = {
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread',
            },
        };
        // When running from source with tsx, configure worker to use tsx
        if (workerScriptPath.endsWith('.ts')) {
            workerOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        const worker = new WorkerThread(workerScriptPath, workerOptions);
        worker.send = (payload: any) => worker.postMessage(payload);
        worker.kill = () => worker.terminate();
        return worker;
    }

    function createForkWorker(account: any): any {
        if ((processRef as any).pkg) {
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: { ...processRef.env, FARM_WORKER: '1', FARM_ACCOUNT_ID: String(account.id || '') },
            });
        }
        const forkOptions: any = {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...processRef.env, FARM_ACCOUNT_ID: String(account.id || '') },
        };
        if (workerScriptPath.endsWith('.ts')) {
            forkOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        return fork(workerScriptPath, [], forkOptions);
    }

    function createWorkerProcess(account: any): any {
        if (useThreadRuntime) return createThreadWorker(account);
        return createForkWorker(account);
    }

    // 兼容两种调用形态：
    // - 本地断线重连体系：startWorker(account, { keepReconnectPlan, skipCodeRefresh })
    // - 上游会话托管体系：startWorker(account, sessionId)
    // options.keepReconnectPlan：自动重连自己拉起 worker 时保留计划；
    // 其余入口（用户手动启动、手动重启、开机自启）视为人工干预，立即取消等待中的重连计划。
    // options.skipCodeRefresh：内部递归调用标记，避免手动启动换码后再次进入换码分支。
    function startWorker(account: any, optionsOrSessionId: { keepReconnectPlan?: boolean; skipCodeRefresh?: boolean } | string = {}): boolean {
        if (shuttingDown) return false;
        const options = typeof optionsOrSessionId === 'string' ? {} : optionsOrSessionId;
        const sessionId = typeof optionsOrSessionId === 'string' ? optionsOrSessionId : undefined;
        if (!account || !account.id) return false;
        if (workers[account.id]) return false;
        // 已在换码中：把这次启动并入那一次，换码完成后会自行拉起，避免并发拿旧 Code 启动。
        if (codeRefreshing.has(String(account.id))) return true;
        const pendingPlan = reconnectWindows.get(account.id);
        const resumingFromKickout = !options.keepReconnectPlan && !!pendingPlan && pendingPlan.mode === 'kickout';
        if (!options.keepReconnectPlan) cancelReconnectPlan(account.id, account.name, '已手动启动');

        // 手动启动发生在挤号等待期内时，账号里存的旧 Code 已被对方顶号作废，
        // 直接用它会撞 WS 400。这里先换新 Code，换不到才用旧 Code 兜底。
        if (resumingFromKickout && !options.skipCodeRefresh && typeof refreshAccountCode === 'function') {
            const refreshKey = String(account.id);
            codeRefreshing.add(refreshKey);
            void (async () => {
                let target = account;
                try {
                    const outcome = await refreshAccountCode(account);
                    if (outcome && outcome.ok && outcome.code) {
                        const patch: any = { id: account.id, code: String(outcome.code) };
                        if (outcome.uin && !account.uin) patch.uin = String(outcome.uin);
                        try { addOrUpdateAccount(patch); } catch { /* 写盘失败仍用内存新 Code */ }
                        target = { ...account, ...patch };
                        log('系统', `账号 ${account.name} 手动启动：已换取新 Code`, {
                            accountId: String(account.id), accountName: account.name,
                        });
                        if (outcome.warn) log('警告', `账号 ${account.name}：${outcome.warn}`, { accountId: String(account.id), accountName: account.name });
                        addAccountLog('kickout_code_refreshed', `账号 ${account.name} 手动启动已换取新 Code`, account.id, account.name, { trigger: 'manual_start' });
                    } else {
                        const reason = String(outcome?.reason || '未获取到新 Code');
                        log('错误', `账号 ${account.name} 手动启动：换取新 Code 失败（${reason}），使用旧 Code 尝试`, {
                            accountId: String(account.id), accountName: account.name,
                        });
                        addAccountLog('kickout_code_refresh_failed', `账号 ${account.name} 手动启动换取新 Code 失败（${reason}），使用旧 Code`, account.id, account.name, { trigger: 'manual_start' });
                    }
                } catch (error: any) {
                    const reason = String(error?.message || error || '未知错误');
                    log('错误', `账号 ${account.name} 手动启动：换取新 Code 异常（${reason}），使用旧 Code 尝试`, {
                        accountId: String(account.id), accountName: account.name,
                    });
                } finally {
                    // 先解除标记再拉起，否则内部这次调用会被当成"换码中"直接返回。
                    codeRefreshing.delete(refreshKey);
                    try {
                        startWorker(target, { keepReconnectPlan: true, skipCodeRefresh: true });
                    } catch (error: any) {
                        log('错误', `账号 ${account.name} 手动启动失败: ${error && error.message ? error.message : error}`, {
                            accountId: String(account.id), accountName: account.name,
                        });
                    }
                }
            })();
            return true;
        }

        log('系统', `正在启动账号: ${account.name}`, { accountId: String(account.id), accountName: account.name });

        let child: any = null;
        try {
            child = createWorkerProcess(account);
            tracker?.register(child.pid, 'account', String(account.id));
        } catch (err: any) {
            const reason = err && err.message ? err.message : String(err || 'unknown error');
            log('错误', `账号 ${account.name} 启动失败: ${reason}`, { accountId: String(account.id), accountName: account.name });
            addAccountLog('start_failed', `账号 ${account.name} 启动失败`, account.id, account.name, { reason });
            return false;
        }

        workers[account.id] = {
            process: child,
            accountKey: accountSessionKey(account),
            status: null,
            logs: [],
            requests: new Map(),
            reqId: 1,
            name: account.name,
            nick: account.nick || '',
            avatar: account.avatar || '',
            stopping: false,
            disconnectedSince: 0,
            autoDeleteTriggered: false,
            terminalHandled: false,
            wsError: null,
        };

        const initialConfigSnapshot = buildConfigSnapshotForAccount(account.id);
        child.send({
            type: 'start',
            config: {
                code: sessionId ? undefined : account.code,
                accountId: String(account.id), accountKey: accountSessionKey(account), sessionId,
                platform: account.platform,
                systemTimeZone: initialConfigSnapshot.systemTimeZone,
                systemServerUrl: initialConfigSnapshot.systemServerUrl,
                systemClientVersion: initialConfigSnapshot.systemClientVersion,
                systemWxClientVersion: initialConfigSnapshot.systemWxClientVersion,
                systemDeviceInfo: initialConfigSnapshot.systemDeviceInfo,
            },
        });
        child.send({ type: 'config_sync', config: initialConfigSnapshot });

        child.on('message', (msg: any) => {
            handleWorkerMessage(account.id, child, msg);
        });

        child.on('error', (err: any) => {
            log('系统', `账号 ${account.name} 子进程启动失败: ${err && err.message ? err.message : err}`, { accountId: String(account.id), accountName: account.name });
        });

        child.on('exit', (code: number, signal: string) => {
            tracker?.unregister(child.pid);
            const current = workers[account.id];
            if (!current || current.process !== child) return;
            const displayName = current.name || account.name;
            log('系统', `账号 ${displayName} 进程退出 (code=${code}, signal=${signal || 'none'})`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: useThreadRuntime ? 'thread' : 'fork',
            });

            managerScheduler.clear(`force_kill_${account.id}`);
            managerScheduler.clear(`restart_fallback_${account.id}`);

            if (current && current.requests && current.requests.size > 0) {
                for (const [reqId, req] of current.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${account.id}_${reqId}`);
                    try {
                        req.reject(new Error('Worker exited'));
                    } catch {}
                }
                current.requests.clear();
            }

            if (current && current.process === child) {
                delete workers[account.id];
            }
        });
        return true;
    }

    function stopWorker(accountId: string): void {
        const worker = workers[accountId];
        if (!worker) return;

        const proc = worker.process;
        worker.stopping = true;
        worker.process.send({ type: 'stop' });
        managerScheduler.setTimeoutTask(`force_kill_${accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === proc) {
                current.process.kill();
                delete workers[accountId];
            }
        });
    }

    // ===== 上游会话托管能力（FARM_SESSION_SOCKET 模式）=====
    // 先停止本实例的业务工作进程。只有面板显式停止账号才关闭游戏连接。
    function endWorker(worker: any, type: 'stop' | 'detach'): Promise<void> {
        worker.stopping = true;
        const child = worker.process;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { child.kill(); }, 2500);
            const onExit = () => { clearTimeout(timer); resolve(); };
            child.once('exit', onExit);
            if (child.exitCode != null || child.signalCode) { onExit(); return; }
            try { child.send({ type }); }
            catch (err) { if (child.connected !== false) { clearTimeout(timer); child.off('exit', onExit); reject(err); } }
        });
    }

    async function startAccountWorker(account: any) {
        if (!managed || workers[account.id]) return startWorker(account);
        const session = findAccountSession(await listHostedSessions(), account);
        return startWorker(account, session?.sessionId);
    }

    async function stopAccountWorker(account: any) {
        if (!managed) { stopWorker(account.id); return; }
        const worker = workers[account.id];
        const key = worker?.accountKey || accountSessionKey(account);
        if (worker) await endWorker(worker, 'stop');
        await stopHostedAccount(String(account.id), key);
    }

    async function detachAllWorkers() {
        shuttingDown = true;
        await Promise.all(Object.values(workers).map(worker => endWorker(worker, 'detach')));
    }

    // ===== 本地断线重连体系 =====
    // 清除某账号的重连计划与重试定时器。
    function clearReconnectWindow(accountId: string): void {
        reconnectWindows.delete(accountId);
        managerScheduler.clear(`auto_reconnect_${accountId}`);
    }

    // 手动干预（启动/停止/重启）时取消等待中的重连计划；返回是否确实取消了计划。
    function cancelReconnectPlan(accountId: string, accountName: string, trigger: string): boolean {
        const plan = reconnectWindows.get(accountId);
        if (!plan) return false;
        clearReconnectWindow(accountId);
        const label = plan.mode === 'kickout' ? '被踢下线后的等待重连' : '自动重连窗口';
        log('系统', `账号 ${accountName} ${trigger}，已取消${label}`, {
            accountId: String(accountId), accountName, mode: plan.mode, reason: plan.reason,
        });
        addAccountLog('reconnect_cancelled', `账号 ${accountName} ${trigger}，已取消自动重连`, accountId, accountName, { mode: plan.mode });
        return true;
    }

    // 判定 code 是否已失效：只有服务端明确给的 WS 400 才是可靠依据。
    function markCodeExpired(accountId: string, reason: string): void {
        const hadWindow = reconnectWindows.has(accountId);
        clearReconnectWindow(accountId);
        if (hadWindow) {
            log('系统', `账号 ${accountId} 重连期间确认 Code 已失效（reason=${reason}），停止自动重连，请重新扫码`, { accountId: String(accountId) });
        }
    }

    // 400 后"换码重连"的每日次数上限：换到的 Code 若仍被立即作废（例如对方持续
    // 用新 Code 顶号），没有上限就会变成每 5 分钟一次的静默循环，日志里也看不出规律。
    const CODE_EXPIRED_RETRY_LIMIT = 5;
    const codeExpiredRetries = new Map<string, { date: string; count: number }>();
    function recordCodeExpiredRetry(accountId: string): boolean {
        const day = new Date().toISOString().slice(0, 10);
        const key = String(accountId || '');
        const current = codeExpiredRetries.get(key);
        const entry = !current || current.date !== day ? { date: day, count: 0 } : current;
        if (entry.count >= CODE_EXPIRED_RETRY_LIMIT) {
            codeExpiredRetries.set(key, entry);
            return false;
        }
        entry.count += 1;
        codeExpiredRetries.set(key, entry);
        return true;
    }

    // 发一条"恢复上线"通知（仅一次）。
    function notifyRecovery(accountId: string, accountName: string): void {
        const title = '账号恢复上线通知';
        const content = `账号 ${accountName} 已自动重连成功，恢复正常运行。`;
        log('系统', `账号 ${accountName} 自动重连成功，已恢复运行`, { accountId: String(accountId), accountName });
        addAccountLog('reconnect_success', `账号 ${accountName} 自动重连成功，已恢复运行`, accountId, accountName);
        if (typeof sendConfiguredPush === 'function') {
            Promise.resolve(sendConfiguredPush({ title, content, accountId, accountName, logLabel: '恢复通知' }))
                .catch((e: any) => log('错误', `恢复通知发送异常: ${e && e.message ? e.message : e}`));
        }
    }

    // 开启普通断线重连窗口（非挤号）：窗口内复用当前 code 按间隔重连。
    function beginReconnectWindow(accountId: string, accountName: string, reason: string): void {
        const now = Date.now();
        const existing = reconnectWindows.get(accountId);
        if (existing && existing.until > now) return; // 已有计划在跑，沿用截止时间，避免反复重置
        reconnectWindows.set(accountId, { mode: 'disconnect', until: now + RECONNECT_WINDOW_MS, reason, attemptsLeft: 0 });
        log('系统', `账号 ${accountName} 进入 3 分钟自动重连窗口（reason=${reason}），窗口内复用当前 Code 尝试重连`, {
            accountId: String(accountId), accountName, reason,
        });
        addAccountLog('reconnect_window', `账号 ${accountName} 断线，进入 3 分钟自动重连窗口`, accountId, accountName, { reason });
        scheduleReconnectAttempt(accountId, RECONNECT_FIRST_DELAY_MS);
    }

    // 挤号重连计划：其他位置登录顶下线后，先静默等待固定时长，
    // 再用账号当前保存的同一个 code 重连固定次数，避免与原登录处反复互踢。
    function beginKickoutReconnect(accountId: string, accountName: string, reason: string): void {
        const existing = reconnectWindows.get(accountId);
        if (existing && existing.mode === 'kickout' && existing.until > Date.now()) {
            // 已在等待期内，沿用原计划，避免反复被踢时不断重置等待时间。
            return;
        }
        clearReconnectWindow(accountId);
        const now = Date.now();
        const waitUntil = now + KICKOUT_RECONNECT_WAIT_MS;
        reconnectWindows.set(accountId, {
            mode: 'kickout',
            reason,
            waitUntil,
            until: waitUntil + KICKOUT_RECONNECT_FINALIZE_MS,
            attemptsLeft: KICKOUT_RECONNECT_ATTEMPTS,
        });
        const waitMinutes = Math.round(KICKOUT_RECONNECT_WAIT_MS / 60000);
        log('系统', `账号 ${accountName} 被踢下线，进入 ${waitMinutes} 分钟等待（不立即重连），等待结束后换取新 Code 重连 ${KICKOUT_RECONNECT_ATTEMPTS} 次`, {
            accountId: String(accountId), accountName, reason,
        });
        addAccountLog('kickout_wait', `账号 ${accountName} 被踢下线，等待 ${waitMinutes} 分钟后换取新 Code 重连 ${KICKOUT_RECONNECT_ATTEMPTS} 次`, accountId, accountName, { reason });
        scheduleKickoutAttempt(accountId, KICKOUT_RECONNECT_WAIT_MS);
    }

    // 挤号计划的一次检查：等待期内不发起重连；到点后按剩余次数拉起 worker。
    function scheduleKickoutAttempt(accountId: string, delayMs: number): void {
        managerScheduler.setTimeoutTask(`auto_reconnect_${accountId}`, delayMs, () => {
            try {
                const plan = reconnectWindows.get(accountId);
                if (!plan || plan.mode !== 'kickout') return;
                const acc = typeof getAccountById === 'function' ? getAccountById(accountId) : null;
                const name = acc?.name || accountId;

                const now = Date.now();
                // 定时器被提前触发（时钟漂移、调度器重排）时，按剩余等待时间重新排队，确保足额等满。
                const waitUntil = Number(plan.waitUntil) || 0;
                if (now < waitUntil) {
                    scheduleKickoutAttempt(accountId, waitUntil - now);
                    return;
                }

                if (now > plan.until) {
                    clearReconnectWindow(accountId);
                    log('系统', `账号 ${name} 被踢下线后的自动重连已结束，请手动启动或重新扫码`, { accountId: String(accountId), accountName: name });
                    addAccountLog('reconnect_timeout', `账号 ${name} 自动重连 ${KICKOUT_RECONNECT_ATTEMPTS} 次未成功，请手动启动或重新扫码`, accountId, name);
                    return;
                }

                if (plan.attemptsLeft <= 0) {
                    // 次数已用完，留在计划里等收尾时间到达后再清理。
                    scheduleKickoutAttempt(accountId, RECONNECT_RETRY_MS);
                    return;
                }

                // 已有存活 worker（外部已拉起或上次尝试仍在连接）则不重复启动，等状态回传。
                if (workers[accountId]) {
                    scheduleKickoutAttempt(accountId, RECONNECT_RETRY_MS);
                    return;
                }

                if (!acc || !acc.id) {
                    clearReconnectWindow(accountId);
                    return;
                }

                plan.attemptsLeft -= 1;
                const attemptNo = KICKOUT_RECONNECT_ATTEMPTS - plan.attemptsLeft;
                log('系统', `账号 ${name} 等待结束，第 ${attemptNo}/${KICKOUT_RECONNECT_ATTEMPTS} 次自动重连：先换取新 Code`, {
                    accountId: String(accountId), accountName: name, reason: plan.reason,
                });
                addAccountLog('kickout_reconnect', `账号 ${name} 第 ${attemptNo}/${KICKOUT_RECONNECT_ATTEMPTS} 次自动重连：正在换取新 Code`, accountId, name, { reason: plan.reason });
                void launchKickoutAttempt(accountId, acc, name, attemptNo);
            } catch {
                // ignore kickout reconnect scheduling errors
            }
        });
    }

    // 挤号后的一次真实尝试：先换新 Code（旧 Code 已被对方顶号作废），
    // 换不到才退回旧 Code 兜底。整个过程保持计划不取消，直到真正拉起 worker。
    async function launchKickoutAttempt(accountId: string, account: any, name: string, attemptNo: number): Promise<void> {
        // 用户手动启动正在换码：让那次换码结果决定，别并发再换一次（会连续换两张 Code）。
        if (codeRefreshing.has(String(accountId))) return;
        let target = account;
        if (typeof refreshAccountCode === 'function') {
            // 换码可能要十几秒（QQ 要等插件、微信要做握手），给收尾判定留足余量，
            // 避免刚启动就被判超时清理。只在确实要换码时才延长。
            const plan = reconnectWindows.get(accountId);
            if (plan && plan.mode === 'kickout') {
                plan.until = Math.max(plan.until, Date.now() + KICKOUT_RECONNECT_FINALIZE_MS + 60000);
            }
            try {
                const outcome = await refreshAccountCode(account);
                // 换码期间用户可能手动启动/停止，计划已不在则放弃本次尝试。
                if (!reconnectWindows.has(accountId)) return;
                if (outcome && outcome.ok && outcome.code) {
                    const patch: any = { id: account.id, code: String(outcome.code) };
                    if (outcome.uin && !account.uin) patch.uin = String(outcome.uin);
                    try { addOrUpdateAccount(patch); } catch { /* 写盘失败仍用新 Code 内存值重连 */ }
                    target = { ...account, ...patch };
                    log('系统', `账号 ${name} 已换取新 Code，第 ${attemptNo}/${KICKOUT_RECONNECT_ATTEMPTS} 次重连使用新 Code`, {
                        accountId: String(accountId), accountName: name,
                    });
                    if (outcome.warn) log('警告', `账号 ${name}：${outcome.warn}`, { accountId: String(accountId), accountName: name });
                    addAccountLog('kickout_code_refreshed', `账号 ${name} 已换取新 Code，使用新 Code 重连`, accountId, name, { attempt: attemptNo });
                } else {
                    const reason = String(outcome?.reason || '未获取到新 Code');
                    log('错误', `账号 ${name} 换取新 Code 失败（${reason}），改用旧 Code 兜底重连`, {
                        accountId: String(accountId), accountName: name,
                    });
                    addAccountLog('kickout_code_refresh_failed', `账号 ${name} 换取新 Code 失败（${reason}），改用旧 Code 兜底`, accountId, name, { attempt: attemptNo });
                }
            } catch (error: any) {
                if (!reconnectWindows.has(accountId)) return;
                const reason = String(error?.message || error || '未知错误');
                log('错误', `账号 ${name} 换取新 Code 异常（${reason}），改用旧 Code 兜底重连`, {
                    accountId: String(accountId), accountName: name,
                });
                addAccountLog('kickout_code_refresh_failed', `账号 ${name} 换取新 Code 异常（${reason}），改用旧 Code 兜底`, accountId, name, { attempt: attemptNo });
            }
        }
        // 期间可能已被手动拉起，或计划被取消（手动停止/400 判定失效）。
        if (!reconnectWindows.has(accountId) || workers[accountId]) return;
        startWorker(target, { keepReconnectPlan: true });
        scheduleKickoutAttempt(accountId, RECONNECT_RETRY_MS);
    }

    // 安排一次重连尝试。
    function scheduleReconnectAttempt(accountId: string, delayMs: number): void {
        const window = reconnectWindows.get(accountId);
        if (!window) return;
        managerScheduler.setTimeoutTask(`auto_reconnect_${accountId}`, delayMs, () => {
            try {
                const active = reconnectWindows.get(accountId);
                if (!active) return;
                if (Date.now() > active.until) {
                    clearReconnectWindow(accountId);
                    const acc = typeof getAccountById === 'function' ? getAccountById(accountId) : null;
                    const name = acc?.name || accountId;
                    log('系统', `账号 ${name} 3 分钟自动重连窗口结束，仍未连上，请重新扫码获取新 Code`, { accountId: String(accountId), accountName: name });
                    addAccountLog('reconnect_timeout', `账号 ${name} 自动重连超时，请重新扫码`, accountId, name);
                    return;
                }
                // 已有存活 worker（例如外部 Helper 已刷新 Code 并拉起）则不重复启动，等下次检查状态。
                if (workers[accountId]) {
                    scheduleReconnectAttempt(accountId, RECONNECT_RETRY_MS);
                    return;
                }
                const acc = typeof getAccountById === 'function' ? getAccountById(accountId) : null;
                if (!acc || !acc.id) {
                    clearReconnectWindow(accountId);
                    return;
                }
                log('系统', `账号 ${acc.name || accountId} 自动重连中（复用当前 Code）`, { accountId: String(accountId), accountName: acc.name || '' });
                startWorker(acc);
                scheduleReconnectAttempt(accountId, RECONNECT_RETRY_MS);
            } catch {
                // ignore reconnect scheduling errors
            }
        });
    }

    // 收到在线状态且 connected=true：若处于重连窗口，判定恢复成功。
    function handleReconnectRecovery(accountId: string, accountName: string): void {
        if (!reconnectWindows.has(accountId)) return;
        clearReconnectWindow(accountId);
        notifyRecovery(accountId, accountName);
    }

    function restartWorker(account: any): void | Promise<void> {
        // 会话托管模式优先走上游的停止-启动流程；非托管模式走本地重连体系。
        if (managed && account) return stopAccountWorker(account).then(() => { startWorker(account); });
        if (!account) return;
        const accountId = account.id;
        const worker = workers[accountId];
        if (!worker) { startWorker(account); return; }
        const proc = worker.process;
        let started = false;
        const startOnce = () => {
            if (started) return;
            started = true;
            managerScheduler.clear(`restart_fallback_${accountId}`);
            const current = workers[accountId];
            if (!current) { startWorker(account); return; }
            if (current.process !== proc) return;
            delete workers[accountId];
            startWorker(account);
        };
        const killIfStale = () => {
            const current = workers[accountId];
            if (!current || current.process !== proc) return false;
            try {
                current.process.kill();
            } catch {}
            delete workers[accountId];
            return true;
        };
        if (typeof proc.exitCode === 'number' || proc.signalCode) {
            startOnce();
            return;
        }
        proc.once('exit', startOnce);
        stopWorker(accountId);
        managerScheduler.setTimeoutTask(`restart_fallback_${accountId}`, 1500, () => {
            if (started) return;
            killIfStale();
            startOnce();
        });
    }

    function errorFromWorkerPayload(payload: any): Error & { code?: string | number; errorMessage?: string } {
        if (!payload || typeof payload !== 'object') return new Error(String(payload || 'Worker API error'));
        const error: Error & { code?: string | number; errorMessage?: string } = new Error(String(payload.message || 'Worker API error'));
        if (payload.name) error.name = String(payload.name);
        if (payload.code !== undefined && payload.code !== null && payload.code !== '') error.code = payload.code;
        const protocolMessage = payload.errorMessage ?? payload.error_message;
        if (protocolMessage !== undefined && protocolMessage !== null) error.errorMessage = String(protocolMessage);
        return error;
    }

    function handleWorkerMessage(accountId: string, sourceProcess: any, msg: any): void {
        const worker = workers[accountId];
        if (!worker || worker.process !== sourceProcess) return;

        if (msg.type === 'status_sync') {
            worker.status = normalizeStatusForPanel(msg.data, accountId, worker.name);
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, worker.status, worker.name);
            }

            const profile = msg.data && msg.data.status && typeof msg.data.status === 'object'
                ? msg.data.status
                : {};
            const accountUpdate: any = { id: accountId };
            let profileChanged = false;

            if (profile.name) {
                const newNick = String(profile.name).trim();
                if (newNick && newNick !== '未知' && newNick !== '未登录') {
                    if (worker.nick !== newNick) {
                        const oldNick = worker.nick;
                        worker.nick = newNick;
                        accountUpdate.nick = newNick;
                        profileChanged = true;
                        if (oldNick !== newNick) {
                            log('系统', `已同步账号昵称: ${oldNick || 'None'} -> ${newNick}`, { accountId, accountName: worker.name });
                        }
                    }
                }
            }

            const newAvatar = String(profile.avatarUrl || profile.avatar_url || '').trim();
            if (newAvatar && worker.avatar !== newAvatar) {
                worker.avatar = newAvatar;
                accountUpdate.avatar = newAvatar;
                profileChanged = true;
            }

            if (profileChanged) {
                addOrUpdateAccount(accountUpdate);
            }

            const connected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (connected) {
                worker.disconnectedSince = 0;
                worker.autoDeleteTriggered = false;
                worker.wsError = null;
                // 重连窗口内一旦真正连上，判定恢复并发恢复通知。
                handleReconnectRecovery(accountId, worker.name);
            } else if (!worker.stopping) {
                const now = Date.now();
                if (!worker.disconnectedSince) worker.disconnectedSince = now;
                const offlineMs = now - worker.disconnectedSince;
                const autoDeleteMs = getOfflineAutoDeleteMs();
                if (!worker.autoDeleteTriggered && offlineMs >= autoDeleteMs) {
                    worker.autoDeleteTriggered = true;
                    const offlineMin = Math.floor(offlineMs / 60000);
                    log('系统', `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，自动删除账号信息`);
                    triggerOfflineReminder({
                        accountId,
                        accountName: worker.name,
                        reason: 'offline_timeout',
                        offlineMs,
                    });
                    addAccountLog(
                        'offline_delete',
                        `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，已自动删除`,
                        accountId,
                        worker.name,
                        { reason: 'offline_timeout', offlineMs },
                    );
                    stopWorker(accountId);
                    try {
                        deleteAccount(accountId);
                    } catch (e: any) {
                        log('错误', `删除离线账号失败: ${e.message}`);
                    }
                }
            }
        } else if (msg.type === 'log') {
            const logEntry = {
                ...msg.data,
                accountId,
                accountName: worker.name,
                ts: Date.now(),
                meta: msg.data && msg.data.meta ? msg.data.meta : {},
            };
            logEntry._searchText = `${logEntry.msg || ''} ${logEntry.tag || ''} ${JSON.stringify(logEntry.meta || {})}`.toLowerCase();
            worker.logs.push(logEntry);
            if (worker.logs.length > 1000) worker.logs.shift();
            globalLogs.push(logEntry);
            if (globalLogs.length > 1000) globalLogs.shift();
            if (typeof onWorkerLog === 'function') {
                onWorkerLog(logEntry, accountId, worker.name);
            }
        } else if (msg.type === 'error') {
            const workerError = errorFromWorkerPayload(msg.error);
            log('错误', `账号[${accountId}]进程报错: ${workerError.message}`, {
                accountId: String(accountId),
                accountName: worker.name,
                errorCode: workerError.code,
                errorName: workerError.name,
            });
        } else if (msg.type === 'ws_error') {
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            worker.wsError = { code, message, at: Date.now() };
            if (code === 400) {
                // WS 400 = 服务端明确拒绝 Code。旧 Code 已被作废，如果账号具备
                // 换码能力（微信长凭据 / QQ NapCat），就安排一次换码重连；
                // 换码不可用或今天的换码重连已用尽，则照旧停止并提示人工处理。
                const hadPlan = reconnectWindows.has(accountId);
                markCodeExpired(accountId, 'ws_400');
                const expiredAccount = typeof getAccountById === 'function' ? getAccountById(accountId) : null;
                const canRefresh = accountCanRefreshOn400(expiredAccount);
                if (canRefresh && !hadPlan && recordCodeExpiredRetry(accountId)) {
                    log('系统', `账号 ${worker.name} Code 已失效（WS 400），已安排换取新 Code 后重连`, {
                        accountId: String(accountId), accountName: worker.name,
                    });
                    addAccountLog(
                        'ws_400',
                        `账号 ${worker.name} Code 已失效（WS 400），已安排换取新 Code 后重连`,
                        accountId,
                        worker.name,
                    );
                    stopWorker(accountId);
                    beginKickoutReconnect(accountId, worker.name, 'kickout:ws_400');
                } else {
                    const detail = canRefresh
                        ? `今天的换码重连次数已用尽（上限 ${CODE_EXPIRED_RETRY_LIMIT} 次）`
                        : '该账号没有可用的换码出口（微信未存长凭据 / QQ 未配 NapCat）';
                    log('错误', `账号 ${worker.name} Code 已失效（WS 400）：${detail}，停止自动重连，请重新扫码`, {
                        accountId: String(accountId), accountName: worker.name,
                    });
                    addAccountLog(
                        'ws_400',
                        `账号 ${worker.name} 登录失效（Code 已到期）：${detail}，停止自动重连，请重新扫码`,
                        accountId,
                        worker.name,
                    );
                }
            }
        } else if (msg.type === 'account_kicked') {
            if (worker.terminalHandled) return;
            worker.terminalHandled = true;
            const reason = msg.reason || '未知';
            const reasonCode = Number(msg.reasonCode) || 0;
            const diagnostics = msg.diagnostics || null;
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `kickout:${reason}`,
                offlineMs: 0,
            });

            // 一台机器只跑得起一个 NapCat 时，只有 NapCat 上正登着的那个 QQ 能自动换码。
            // 没有换码出口的账号如果还按 5 分钟等待 + 复用旧 Code 重连，纯属白撞 400，
            // 所以这里直接判死并明确要求重新扫码，把"等 5 分钟才发现没用"变成"立刻说清楚"。
            const kickedAccount = typeof getAccountById === 'function' ? getAccountById(accountId) : null;
            if (!accountCanRefreshOnKickout(kickedAccount)) {
                markCodeExpired(accountId, 'kickout:no_code_source');
                log('错误', `账号 ${worker.name} 被踢下线，且没有可用的换码出口（微信未存长凭据 / QQ 未配 NapCat），已停止自动重连，请重新扫码`, {
                    accountId: String(accountId), accountName: worker.name, reasonCode, diagnostics,
                });
                addAccountLog('kickout_need_new_code', `账号 ${worker.name} 被踢下线，无法自动换取新 Code（没有可用的 NapCat 或微信长凭据），需要重新扫码`, accountId, worker.name, { reason, reasonCode, diagnostics });
                stopWorker(accountId);
                return;
            }

            log('系统', `账号 ${worker.name} 被踢下线，进入 ${Math.round(KICKOUT_RECONNECT_WAIT_MS / 60000)} 分钟等待（等待结束后换取新 Code 重连 ${KICKOUT_RECONNECT_ATTEMPTS} 次）`, { accountId: String(accountId), accountName: worker.name, reasonCode, diagnostics });
            addAccountLog('kickout_wait', `账号 ${worker.name} 被踢下线，等待 ${Math.round(KICKOUT_RECONNECT_WAIT_MS / 60000)} 分钟后换取新 Code 重连 ${KICKOUT_RECONNECT_ATTEMPTS} 次`, accountId, worker.name, { reason, reasonCode, diagnostics });
            stopWorker(accountId);
            beginKickoutReconnect(accountId, worker.name, `kickout:${reason}`);
        } else if (msg.type === 'account_disconnected') {
            if (worker.terminalHandled) return;
            worker.terminalHandled = true;
            const source = String(msg.source || 'ws_close');
            const code = Number(msg.code) || 0;
            const reason = String(msg.reason || '连接已断开');
            const phase = String(msg.phase || 'unknown');
            if (worker.status?.connection) worker.status.connection.connected = false;
            if (worker.requests.size > 0) {
                for (const [reqId, req] of worker.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${accountId}_${reqId}`);
                    try { req.reject(new Error('账号连接已断开')); } catch {}
                }
                worker.requests.clear();
            }
            log('系统', `账号 ${worker.name} 连接已断开，已停止运行并等待 Helper 刷新 Code 或重新扫码`, {
                accountId: String(accountId),
                accountName: worker.name,
                source,
                disconnectCode: code,
                phase,
                reason,
                diagnostics: msg.diagnostics || null,
            });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `disconnect:${source}:${phase}:${code}`,
                offlineMs: 0,
            });
            addAccountLog(
                'disconnect_stop',
                `账号 ${worker.name} 连接已断开，已停止运行并等待 Helper 刷新 Code 或重新扫码`,
                accountId,
                worker.name,
                { source, disconnectCode: code, reason, phase, connectionId: Number(msg.connectionId) || 0, diagnostics: msg.diagnostics || null },
            );
            stopWorker(accountId);
            // WS 400 已在 ws_error 分支判定 Code 失效并停止重连；其他断线 Code 状态未知，进入重连窗口。
            const codeExpired = code === 400 || source === 'ws_error' || Number(worker.wsError?.code) === 400;
            // 挤号计划进行中（例如等待期内的探测失败）不改成普通断线窗口，保留原有等待与次数。
            const kickoutPlanActive = reconnectWindows.get(accountId)?.mode === 'kickout';
            if (!codeExpired && !kickoutPlanActive) {
                beginReconnectWindow(accountId, worker.name, `disconnect:${source}:${phase}:${code}`);
            }
        } else if (msg.type === 'api_response') {
            const { id, result, error } = msg;
            managerScheduler.clear(`api_timeout_${accountId}_${id}`);
            const req = worker.requests.get(id);
            if (req) {
                if (error) req.reject(errorFromWorkerPayload(error));
                else req.resolve(result);
                worker.requests.delete(id);
            }
        } else if (msg.type === 'ranch_friend_blacklist_add') {
            const gid = Number(msg.gid);
            if (!Number.isSafeInteger(gid) || gid <= 0) return;
            try {
                const { addRanchFriendToBlacklist } = require('../models/store');
                if (!addRanchFriendToBlacklist(accountId, gid)) return;
                worker.process.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(accountId) });
                log('牧场', `${msg.friendName || `GID:${gid}`} 不是好友，已加入牧场黑名单`, {
                    accountId: String(accountId), accountName: worker.name, module: 'ranch', event: 'ranch_friend_blacklist', result: 'ok',
                });
            } catch (error: any) {
                log('牧场', `同步牧场黑名单失败：${error.message}`, {
                    accountId: String(accountId), accountName: worker.name, module: 'ranch', event: 'ranch_friend_blacklist', result: 'error',
                });
            }
        } else if (msg.type === 'friend_blacklist_add') {
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { addFriendToBlacklist: addToBlacklist } = require('../models/store');
                addToBlacklist(accountId, gid);
                log('好友', `已将好友 ${msg.friendName || `GID:${gid}`} 加入黑名单`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                    friendGid: gid,
                    friendName: msg.friendName,
                    reason: msg.reason,
                });
                const worker_process = workers[accountId];
                if (worker_process && worker_process.process) {
                    worker_process.process.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(accountId) });
                }
            }
        } else if (msg.type === 'known_friend_gids_sync') {
            const { setKnownFriendGids } = require('../models/store');
            const gids: number[] = Array.isArray(msg.gids)
                ? msg.gids.map(Number).filter((gid: number) => Number.isFinite(gid) && gid > 0)
                : [];
            const saved: number[] = setKnownFriendGids(accountId, gids);
            worker.process.send({
                type: 'config_sync',
                config: buildConfigSnapshotForAccount(accountId),
            });
            log('好友', `已同步并持久化 ${saved.length} 个好友 GID`, {
                accountId: String(accountId),
                accountName: worker.name,
                friendCount: saved.length,
            });
        } else if (msg.type === 'push_notify') {
            if (!Array.isArray(msg.candidates) || typeof sendConfiguredPush !== 'function') return;
            Promise.resolve(sendConfiguredPush({
                candidates: msg.candidates,
                accountId,
                accountName: worker.name,
            })).catch((e: any) => {
                log('错误', `事件提醒发送异常: ${e && e.message ? e.message : e}`);
            });
        } else if (msg.type === 'known_friend_gid_remove') {
            const { getKnownFriendGids, setKnownFriendGids } = require('../models/store');
            const gid: number = Number(msg.gid) || 0;
            if (gid > 0) {
                const current: number[] = getKnownFriendGids(accountId);
                setKnownFriendGids(accountId, current.filter((item: number) => Number(item) !== gid));
                worker.process.send({
                    type: 'config_sync',
                    config: buildConfigSnapshotForAccount(accountId),
                });
            }
        }
    }

    function callWorkerApi(accountId: string, method: string, ...args: any[]): Promise<any> {
        const worker = workers[accountId];
        if (!worker) return Promise.reject(new Error('账号未运行'));
        if (worker.stopping || worker.terminalHandled) return Promise.reject(new Error('账号已离线'));

        return new Promise((resolve, reject) => {
            const id = worker.reqId++;
            worker.requests.set(id, { resolve, reject });

            const timeoutMs = API_CALL_TIMEOUTS_MS[method] || DEFAULT_API_CALL_TIMEOUT_MS;
            managerScheduler.setTimeoutTask(`api_timeout_${accountId}_${id}`, timeoutMs, () => {
                if (worker.requests.has(id)) {
                    worker.requests.delete(id);
                    reject(new Error('API Timeout'));
                }
            });

            worker.process.send({ type: 'api_call', id, method, args });
        });
    }

    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        // 手动停止账号时一并取消等待中的自动重连，避免停止后又被定时任务拉起。
        cancelReconnect: (accountId: string) => cancelReconnectPlan(accountId, String(accountId), '已手动停止'),
        // 上游会话托管能力。
        startAccountWorker, stopAccountWorker, detachAllWorkers,
    };
}

module.exports = {
    createWorkerManager,
};
