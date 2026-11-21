import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handlers } from '../src/rpc';
import type { Ctx } from '../src/services/common';
import { profile, resolveProfile } from '../src/services/supabase-auth';
import { ALL, rejects, setup } from './helpers/setup';

const uuid = 'b1234567-1234-4234-9234-123456789abc';

test('Supabase 가입은 같은 이메일의 인증 증명과 세션이 필요하고 역할은 앱 DB로 결정한다', async () => {
  const t = setup();
  const email = 'new@example.com';
  const anon = t.ctxFor(null);
  await handlers['auth.requestEmailCode'](anon, email);
  const { proof } = await handlers['auth.verifyEmailCode'](anon, email, t.sent[0].code) as { proof: string };
  const principal = { id: uuid, email, email_confirmed_at: '2026-11-06T00:00:00Z',
    identities: [{ provider: 'email' }], app_metadata: { provider: 'email', role: 'admin' } } as NonNullable<Ctx['authUser']>;
  const ctx = { ...anon, authUser: principal };
  const input = { nickname: '테스트', consents: ALL, identity: { name: '홍길동', birthDate: '2000-05-17', phone: '01012345678' }, role: 'admin' };
  await rejects(handlers['auth.signup'](anon, { ...input, emailProof: proof }), '이메일 계정');
  await rejects(handlers['auth.signup'](ctx, input), '다시 완료');
  await handlers['auth.signup'](ctx, { ...input, emailProof: proof, email: 'spoof@example.com' });
  const me = await resolveProfile(ctx, uuid);
  const emailView = await profile({ ...ctx, me });
  const naverView = await profile({ ...ctx, me, authUser: { ...principal, app_metadata: { provider: 'custom:naver' } } });
  assert.equal(emailView.email, email);
  assert.equal(emailView.id, uuid);
  assert.equal(emailView.userType, 'user');
  assert.equal(naverView.userType, emailView.userType);
  assert.equal(naverView.id, emailView.id);
  assert.equal(await resolveProfile(ctx, 'different-auth-id'), null);
  assert.equal(Object.hasOwn(handlers, 'auth.login'), false);
});
