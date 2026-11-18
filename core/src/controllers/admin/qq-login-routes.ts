import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
import { cancelLoginTask, createLoginTask, getMiniappCode, QQ_MINIAPP_APP_ID, queryLoginStatus } from '../../services/qq-login/service';
export {};

const { createAuthRequired } = require('./middleware');

function publicTask(task: any) {
    return {
        task_id: task.taskId,
        status: task.status,
        qr_image: task.qrImage,
        expires_at: task.expiresAt,
    };
}

function sendError(res: Response, error: any, fallback: string): void {
    res.json({
        ok: false,
        error: String(error?.message || '').trim() || fallback,
    });
}

function mountQqLoginRoutes(app: Application, ctx: AdminContext): void {
    app.use('/api/qq-login', createAuthRequired(ctx));

    const ownerOf = (req: Request): string => String((req as any).currentUser?.username || '');

    app.post('/api/qq-login/tasks', async (req: Request, res: Response) => {
        try {
            const task = await createLoginTask(ownerOf(req));
            res.json({ ok: true, data: publicTask(task) });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 登录任务创建失败');
        }
    });

    app.post('/api/qq-login/tasks/:taskId/status', async (req: Request, res: Response) => {
        try {
            const task = await queryLoginStatus(String(req.params.taskId || ''), ownerOf(req));
            res.json({ ok: true, data: publicTask(task) });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 登录状态查询失败');
        }
    });

    app.post('/api/qq-login/tasks/:taskId/code', async (req: Request, res: Response) => {
        try {
            const result = await getMiniappCode(String(req.params.taskId || ''), ownerOf(req));
            // uin 一并返回：账号落盘 uin 后，被挤下线换新 Code 时才能校验
            // 「NapCat 当前登录的号」是否就是这个账号，避免多开时串号。
            res.json({
                ok: true,
                data: { code: result.code, nickname: result.nickname || '', uin: result.uin || '', app_id: QQ_MINIAPP_APP_ID },
            });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 小程序授权 Code 获取失败');
        }
    });

    app.post('/api/qq-login/tasks/:taskId/cancel', async (req: Request, res: Response) => {
        try {
            await cancelLoginTask(String(req.params.taskId || ''), ownerOf(req));
            res.json({ ok: true });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 登录任务取消失败');
        }
    });
}

module.exports = { mountQqLoginRoutes };
