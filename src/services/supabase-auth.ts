import { HttpError } from '../lib/errors';
import { verifyPassword } from '../lib/security';
import { check, normEmail, str, userView, type Ctx, type UserRow } from './common';

export async function resolveProfile(ctx: Ctx, authUserId: string): Promise<UserRow | null> {
  const user = check(await ctx.db.from('users').select('*').eq('auth_user_id', authUserId).maybeSingle()) as UserRow | null;
  if (!user) return null;
  await assertNotBlocked(ctx, user.email);
  return user;
}

export async function assertNotBlocked(ctx: Ctx, email: string) {
  if (check(await ctx.db.from('blocked_emails').select('email').eq('email', email).maybeSingle())) {
    throw new HttpError(403, '이용이 제한된 이메일이에요.');
  }
}

export async function profile(ctx: Ctx) {
  if (!ctx.authUser) throw new HttpError(401, '로그인이 필요해요.');
  if (!ctx.me) {
    const email = ctx.authUser.email;
    if (email && ctx.authUser.identities?.some((identity) => identity.provider === 'email')) {
      await assertNotBlocked(ctx, normEmail(email));
      const existing = check(await ctx.db.from('users').select('id').eq('email', normEmail(email)).maybeSingle());
      if (!existing) throw new HttpError(403, '모먼트리 가입을 완료해주세요.', 'PROFILE_PENDING');
    }
    throw new HttpError(403, '연결된 모먼트리 계정이 없어요. 이메일 로그인 후 네이버를 연결해주세요.');
  }
  const view = await userView(ctx, ctx.me);
  return { ...view, name: view.nickname, userType: view.role, isActive: !view.restrictedUntil,
    provider: ctx.authUser.app_metadata.provider ?? 'email' };
}

// Existing app accounts have scrypt hashes, not Supabase Auth credentials. Verify the
// old password before creating and binding the Auth identity; never bind by email alone.
export async function migrate(ctx: Ctx, emailArg: unknown, passwordArg: unknown): Promise<void> {
  const email = normEmail(str(emailArg, 200));
  const password = str(passwordArg, 200);
  await assertNotBlocked(ctx, email);
  const existing = check(await ctx.db.from('users').select('*').eq('email', email).maybeSingle()) as UserRow | null;
  if (!existing || existing.auth_user_id || !(await verifyPassword(password, existing.password_hash))) {
    throw new HttpError(401, '이메일 또는 비밀번호를 확인해주세요.');
  }
  const { data, error } = await ctx.db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new HttpError(409, '인증 계정을 자동으로 이전할 수 없어요. 관리자에게 문의해주세요.');
  const authId = data.user.id;
  try {
    const linked = check(await ctx.db.from('users').update({ auth_user_id: authId })
      .eq('id', existing.id).is('auth_user_id', null).select('id').maybeSingle());
    if (!linked) throw new HttpError(409, '이미 이전된 계정이에요. 다시 로그인해주세요.');
  } catch (error) {
    await ctx.db.auth.admin.deleteUser(authId);
    throw error;
  }
}
