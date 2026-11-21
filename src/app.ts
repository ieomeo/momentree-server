import cors from 'cors';
import express, { type ErrorRequestHandler, type Express, type NextFunction, type Request, type Response } from 'express';
import type { Env } from './config/env';
import type { Db } from './config/supabase';
import { HttpError } from './lib/errors';
import type { Mailer } from './lib/mailer';
import { createAuthProvidersReader } from './services/auth-providers';
import { profile, resolveProfile } from './services/supabase-auth';
import { handlers } from './rpc';
import type { Ctx } from './services/common';

export interface AppDeps {
  db: Db;
  env: Env;
  mailer: Mailer;
  now?: () => Date;
}

// 로그인·가입·인증번호 요청은 IP당 10분에 30번까지만 허용 (무작위 대입 공격 완화)
const attempts = new Map<string, { count: number; resetAt: number }>();
function tooMany(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 10 * 60000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 30;
}

export default function createApp({ db, env, mailer, now = () => new Date() }: AppDeps): Express {
  const app = express();
  app.set('trust proxy', 1); // Render 같은 프록시 뒤에서 실제 IP를 읽어요.

  app.use(
    cors({
      origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
        // 서버끼리 부르는 요청(origin 없음)이거나 허용 목록에 있는 주소만 통과
        callback(null, !origin || env.corsOrigins.length === 0 || env.corsOrigins.includes(origin));
      },
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  async function requestContext(req: Request): Promise<Ctx> {
    const ctx: Ctx = { db, env, mailer, me: null, now };
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return ctx;
    // Pass the JWT explicitly; the shared service client never adopts user sessions.
    const { data, error } = await db.auth.getUser(header.slice(7));
    if (error || !data.user) throw new HttpError(401, '로그인이 만료됐어요. 다시 로그인해주세요.');
    ctx.authUser = data.user;
    ctx.me = await resolveProfile(ctx, data.user.id);
    return ctx;
  }

  const readProviders = createAuthProvidersReader();
  app.get('/api/auth/providers', async (_req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').json({ data: await readProviders() });
    } catch (error) { next(error); }
  });

  app.get('/api/auth/me', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const user = await profile(await requestContext(req));
      res.json({ success: true, data: { user } });
    } catch (error) { next(error); }
  });

  app.post('/api/rpc/:name', async (req, res, next) => {
    try {
      const name = String(req.params.name);
      if (!Object.hasOwn(handlers, name)) throw new HttpError(404, 'Resource not found');
      if (name.startsWith('auth.') && name !== 'auth.me' && tooMany(req.ip ?? 'unknown')) {
        throw new HttpError(429, '요청이 너무 많아요. 잠시 뒤 다시 시도해주세요.');
      }

      const ctx = await requestContext(req);
      const body = req.body as { args?: unknown } | undefined;
      const args = Array.isArray(body?.args) ? (body.args as unknown[]) : [];
      const data = await handlers[name](ctx, ...args);
      res.set('Cache-Control', 'no-store').json({ data: data === undefined ? null : data });
    } catch (error) {
      next(error);
    }
  });

  app.use((_req: Request, _res: Response, next: NextFunction) => next(new HttpError(404, 'Resource not found')));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { message: err.message, ...(err.code ? { code: err.code } : {}) } });
      return;
    }
    console.error('[Server]', err instanceof Error ? err.stack ?? err.message : err);
    res.status(500).json({ error: { message: '서버에서 문제가 생겼어요. 잠시 뒤 다시 시도해주세요.' } });
  };
  app.use(onError);

  return app;
}
