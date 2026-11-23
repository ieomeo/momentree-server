import assert from 'node:assert/strict';
import type { Env } from '../../src/config/env';
import type { Mailer } from '../../src/lib/mailer';
import { login, signup } from '../../src/services/auth';
import { handlers } from '../../src/rpc';
import type { Ctx, Row } from '../../src/services/common';
import { ensureSuperAdmin } from '../../src/services/seed';
import { createFakeDb } from './fakeDb';

// 가입 화면의 세 가지 필수 동의
export const ALL = { terms: true, consent: true, privacy: true };

export const SUPER = { email: 'khs9523007@ajou.ac.kr', password: 'super-pass-1', nickname: '세계수' };

export function setup(overrides: Partial<Env> = {}, mail: 'ok' | 'off' | 'fail' = 'ok') {
  let clock = Date.parse('2026-11-06T00:00:00Z');
  const db = createFakeDb(() => new Date(clock));
  const sent: { to: string; code: string }[] = [];
  const env: Env = {
    authSecret: 'x'.repeat(40), superAdminEmail: SUPER.email, superAdminPassword: SUPER.password,
    superAdminNickname: SUPER.nickname, corsOrigins: [], allowDemoCode: false, mailSenderName: '모먼트리', ...overrides,
  };
  const mailer: Mailer = {
    async sendCode(to, code) {
      if (mail === 'off') return { configured: false, ok: false };
      if (mail === 'fail') return { configured: true, ok: false };
      sent.push({ to, code });
      return { configured: true, ok: true };
    },
  };
  const ctxFor = (as: string | null): Ctx => ({
    db: db as never, env, mailer, now: () => new Date(clock),
    me: (as ? ((db.tables.users ?? []).find((u: Row) => u.id === as) ?? null) : null) as Ctx['me'],
  });
  // as: 사용자 id(로그인한 사람). null이면 로그인하지 않은 상태
  const call = (as: string | null, name: string, ...args: unknown[]): Promise<any> => name === 'auth.signup' ? signup(ctxFor(as), args[0]) : name === 'auth.login' ? login(ctxFor(as), args[0], args[1]) : handlers[name](ctxFor(as), ...args); // eslint-disable-line @typescript-eslint/no-explicit-any
  const tick = (ms: number) => { clock += ms; };

  const register = async (email: string, nickname: string, name = '홍길동', phone = '010-1234-5678') => {
    await call(null, 'auth.requestEmailCode', email);
    await call(null, 'auth.verifyEmailCode', email, sent[sent.length - 1].code);
    const res = await call(null, 'auth.signup', {
      email, password: '123456', nickname, consents: ALL, identity: { name, birthDate: '2000-05-17', phone },
    });
    return res.user as { id: string; nickname: string };
  };
  const seed = async () => {
    await ensureSuperAdmin(ctxFor(null));
    return (db.tables.users as Row[]).find((u) => u.email === SUPER.email)!.id as string;
  };
  return { db, env, sent, call, tick, register, seed, ctxFor };
}

// 오류가 나야 하는 호출을 검사합니다. (promise에 곧바로 처리기를 붙여야 해요)
export const rejects = (promise: Promise<unknown>, pattern?: RegExp | string): Promise<void> => {
  if (!pattern) return assert.rejects(promise);
  return assert.rejects(promise, (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    return typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message);
  });
};
