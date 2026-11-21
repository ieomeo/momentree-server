import { hashPassword, verifyPassword } from '../lib/security';
import { Ctx, Row, UserRow, check, iso, newId, nicknameKey } from './common';

export async function ensureSuperAdmin(ctx: Ctx): Promise<void> {
  const { db, env } = ctx;
  const existing = check(await db.from('users').select('*').eq('email', env.superAdminEmail).maybeSingle()) as UserRow | null;
  const key = nicknameKey(env.superAdminNickname);

  // 같은 닉네임을 쓰던 다른 계정이 있으면 이름을 바꿔 중복을 없애요.
  const clash = check(await db.from('users').select('id,nickname').eq('nickname_key', key).maybeSingle()) as Row | null;
  if (clash && clash.id !== existing?.id) {
    const renamed = `${clash.nickname as string}_${(clash.id as string).slice(0, 4)}`;
    check(await db.from('users').update({ nickname: renamed, nickname_key: nicknameKey(renamed) }).eq('id', clash.id as string));
  }

  if (!existing) {
    check(
      await db.from('users').insert({
        id: newId(), email: env.superAdminEmail, password_hash: await hashPassword(env.superAdminPassword),
        nickname: env.superAdminNickname, nickname_key: key, role: 'admin', leaves: 0, earned_today: 0,
        earned_date: null, created_at: iso(ctx),
      }),
    );
  } else {
    // 이메일·비밀번호·닉네임·권한을 항상 설정한 값으로 맞춰요.
    const patch: Row = {};
    if (existing.role !== 'admin') patch.role = 'admin';
    if (existing.nickname !== env.superAdminNickname) {
      patch.nickname = env.superAdminNickname;
      patch.nickname_key = key;
    }
    if (!(await verifyPassword(env.superAdminPassword, existing.password_hash))) {
      if (existing.auth_user_id) {
        const { error } = await db.auth.admin.updateUserById(existing.auth_user_id, { password: env.superAdminPassword });
        if (error) throw new Error('총괄 운영자 인증 비밀번호를 갱신하지 못했어요.');
      }
      patch.password_hash = await hashPassword(env.superAdminPassword);
    }
    if (Object.keys(patch).length > 0) check(await db.from('users').update(patch).eq('id', existing.id));
  }

  // 총괄 운영자 이메일이 차단·탈퇴 목록에 남아 있으면 제거
  check(await db.from('blocked_emails').delete().eq('email', env.superAdminEmail));
  check(await db.from('withdrawn_emails').delete().eq('email', env.superAdminEmail));
}

// 기간이 지난 임시 데이터를 지워요. (처리방침에 적은 보관 기간을 실제로 지키기 위한 작업)
//  - 재가입 제한(30일)이 끝난 탈퇴 이메일, 만료된 인증번호·인증 완료 기록
//  - 1년이 지난 개인정보 열람 기록, 접수 후 1년이 지난 처리 완료 신고·위기 알림
export async function purgeExpired(ctx: Ctx): Promise<void> {
  const now = ctx.now();
  const nowIso = now.toISOString();
  check(await ctx.db.from('withdrawn_emails').delete().lt('until', nowIso));
  check(await ctx.db.from('email_codes').delete().lt('expires_at', nowIso));
  check(await ctx.db.from('email_verified').delete().lt('until', nowIso));
  const yearAgo = new Date(now.getTime() - 365 * 86400000).toISOString();
  check(await ctx.db.from('identity_logs').delete().lt('at', yearAgo));
  check(await ctx.db.from('reports').delete().eq('status', 'done').lt('created_at', yearAgo));
  check(await ctx.db.from('crisis_alerts').delete().eq('status', 'done').lt('created_at', yearAgo));
}
