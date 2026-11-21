import { HttpError } from '../lib/errors';
import { hashPassword } from '../lib/security';
import { assertEmailAvailable, assertNicknameAvailable, assertPassword } from './auth';
import {
  Ctx, EMAIL_PATTERN, PERMANENT_UNTIL, REPORT_ACTIONS, RESTRICT_DAYS, Row, UserRow,
  check, isSuperAdmin, isUniqueViolation, iso, newId, nicknameKey, normEmail, pushNotifications,
  requireAdmin, requireSuperAdmin, restrictionLabel, shorten, str,
} from './common';

const STATUSES = ['pending', 'reviewing', 'done'];

// ---------- 신고 ----------
export async function reports(ctx: Ctx) {
  requireAdmin(ctx);
  const rows = check(await ctx.db.from('reports').select('*').order('created_at', { ascending: false }).limit(200)) as Row[];
  return rows.map((r) => ({
    id: r.id as string, targetType: r.target_type as string, targetId: r.target_id as string,
    targetPreview: r.target_preview as string, reason: r.reason as string, detail: (r.detail as string | null) ?? undefined,
    reporterId: (r.reporter_id as string | null) ?? '', status: r.status as string,
    action: (r.action as string | null) ?? undefined, createdAt: r.created_at as string,
  }));
}

export async function setReportStatus(ctx: Ctx, idArg: unknown, statusArg: unknown): Promise<void> {
  requireAdmin(ctx);
  const status = str(statusArg, 20);
  if (!STATUSES.includes(status)) throw new HttpError(400, '상태 값이 올바르지 않아요.');
  check(await ctx.db.from('reports').update({ status }).eq('id', str(idArg, 60)));
}

// 신고 처리: 문제 없음 / 경고 / 게시 중단 / 이용 제한. 처리 결과는 해당 작성자에게 알림으로 가요.
// 이용 제한은 기간(1·3·7·30일, 0=영구)을 함께 보내야 하고, 제한 중에는 글쓰기·댓글·공감·구독·신고를 할 수 없어요.
export async function resolveReport(ctx: Ctx, idArg: unknown, actionArg: unknown, daysArg?: unknown): Promise<void> {
  requireAdmin(ctx);
  const action = str(actionArg, 20);
  if (!REPORT_ACTIONS.includes(action)) throw new HttpError(400, '처리 방법이 올바르지 않아요.');
  const report = check(await ctx.db.from('reports').select('*').eq('id', str(idArg, 60)).maybeSingle()) as Row | null;
  if (!report) throw new HttpError(404, '신고를 찾을 수 없어요.');

  // 신고 대상과 작성자를 먼저 찾아요. (검사에 실패하면 아무것도 바꾸지 않아요)
  let authorId: string | null = null;
  let postId: string | null = null;
  let commentId: string | null = null;
  if (report.target_type === 'post') {
    const post = check(await ctx.db.from('posts').select('id,author_id').eq('id', report.target_id as string).maybeSingle()) as Row | null;
    authorId = (post?.author_id as string | null | undefined) ?? null;
    postId = post ? (post.id as string) : null;
  } else {
    const comment = check(await ctx.db.from('comments').select('id,author_id').eq('id', report.target_id as string).maybeSingle()) as Row | null;
    authorId = (comment?.author_id as string | null | undefined) ?? null;
    commentId = comment ? (comment.id as string) : null;
  }

  let restrictUntil: string | null = null;
  let periodLabel = '';
  if (action === '이용 제한') {
    const days = Number(daysArg);
    if (!RESTRICT_DAYS.includes(days)) throw new HttpError(400, '이용 제한 기간을 선택해주세요.');
    if (!authorId) throw new HttpError(400, '작성자를 찾을 수 없어 이용 제한을 적용할 수 없어요.');
    const author = check(await ctx.db.from('users').select('id,role').eq('id', authorId).maybeSingle()) as Row | null;
    if (!author) throw new HttpError(400, '작성자를 찾을 수 없어 이용 제한을 적용할 수 없어요.');
    if (author.role === 'admin') throw new HttpError(403, '운영자 계정은 이용 제한할 수 없어요.');
    restrictUntil = days === 0 ? PERMANENT_UNTIL : new Date(ctx.now().getTime() + days * 86400000).toISOString();
    periodLabel = days === 0 ? '영구' : `${days}일`;
  }

  check(await ctx.db.from('reports').update({ status: 'done', action }).eq('id', report.id as string));
  if (action === '게시 중단') {
    if (postId) check(await ctx.db.from('posts').update({ hidden: true }).eq('id', postId));
    if (commentId) check(await ctx.db.from('comments').delete().eq('id', commentId));
  }
  if (restrictUntil && authorId) {
    check(await ctx.db.from('users').update({ restricted_until: restrictUntil, restriction_reason: report.reason as string }).eq('id', authorId));
  }

  if (authorId) {
    const target = `‘${shorten(report.target_preview as string)}’ ${report.target_type === 'post' ? '글' : '댓글'}`;
    const reason = `사유: ${report.reason}`;
    if (action === '경고') {
      await pushNotifications(ctx, [{ userId: authorId, type: 'warning', text: `운영자 경고: ${target}이(가) 커뮤니티 약속에 어긋나요. (${reason})` }]);
    } else if (action === '게시 중단') {
      await pushNotifications(ctx, [{ userId: authorId, type: 'removed', text: `${target}이(가) 운영 정책에 따라 게시 중단됐어요. (${reason})` }]);
    } else if (restrictUntil) {
      await pushNotifications(ctx, [
        {
          userId: authorId,
          type: 'restricted',
          text: `운영 정책 위반으로 이용 제한 조치를 받았어요. (기간: ${periodLabel} · ${restrictionLabel(restrictUntil)}, ${reason}) 제한 중에는 글쓰기·댓글·공감·구독을 할 수 없어요.`,
        },
      ]);
    }
  }
}

// 이용 제한 해제: 신고 처리 기록으로 작성자를 찾아 제한을 풀어줘요. (이의 제기가 받아들여졌을 때 등)
export async function liftRestriction(ctx: Ctx, reportIdArg: unknown): Promise<void> {
  requireAdmin(ctx);
  const report = check(await ctx.db.from('reports').select('*').eq('id', str(reportIdArg, 60)).maybeSingle()) as Row | null;
  if (!report) throw new HttpError(404, '신고를 찾을 수 없어요.');
  let authorId: string | null = null;
  if (report.target_type === 'post') {
    const post = check(await ctx.db.from('posts').select('author_id').eq('id', report.target_id as string).maybeSingle()) as Row | null;
    authorId = (post?.author_id as string | null | undefined) ?? null;
  } else {
    const comment = check(await ctx.db.from('comments').select('author_id').eq('id', report.target_id as string).maybeSingle()) as Row | null;
    authorId = (comment?.author_id as string | null | undefined) ?? null;
  }
  if (!authorId) throw new HttpError(404, '작성자를 찾을 수 없어요.');
  check(await ctx.db.from('users').update({ restricted_until: null, restriction_reason: null }).eq('id', authorId));
  await pushNotifications(ctx, [{ userId: authorId, type: 'notice', text: '이용 제한이 해제됐어요. 다시 글쓰기·댓글·공감·구독을 할 수 있어요.' }]);
}

// ---------- 위기 알림 ----------
export async function alerts(ctx: Ctx) {
  requireAdmin(ctx);
  const rows = check(await ctx.db.from('crisis_alerts').select('*').order('created_at', { ascending: false }).limit(200)) as Row[];
  return rows.map((a) => ({
    id: a.id as string, postId: (a.post_id as string | null) ?? '', keywordCount: a.keyword_count as number,
    status: a.status as string, createdAt: a.created_at as string, careSent: a.care_sent as boolean,
  }));
}

export async function setAlertStatus(ctx: Ctx, idArg: unknown, statusArg: unknown): Promise<void> {
  requireAdmin(ctx);
  const status = str(statusArg, 20);
  if (!STATUSES.includes(status)) throw new HttpError(400, '상태 값이 올바르지 않아요.');
  check(await ctx.db.from('crisis_alerts').update({ status }).eq('id', str(idArg, 60)));
}

// 위기 알림이 걸린 글의 작성자에게 도움 안내를 보냅니다.
export async function sendCareNotice(ctx: Ctx, alertIdArg: unknown): Promise<void> {
  requireAdmin(ctx);
  const alert = check(await ctx.db.from('crisis_alerts').select('*').eq('id', str(alertIdArg, 60)).maybeSingle()) as Row | null;
  if (!alert) throw new HttpError(404, '위기 알림을 찾을 수 없어요.');
  if (alert.care_sent) throw new HttpError(409, '이미 도움 안내를 보냈어요.');
  const post = alert.post_id
    ? (check(await ctx.db.from('posts').select('id,author_id').eq('id', alert.post_id as string).maybeSingle()) as Row | null)
    : null;
  if (!post?.author_id) throw new HttpError(404, '글이 삭제되어 작성자를 찾을 수 없어요.');
  await pushNotifications(ctx, [
    {
      userId: post.author_id as string,
      type: 'care',
      text: '지금 마음이 많이 힘드신 것 같아요. 혼자가 아니에요. 자살예방 상담전화 109(24시간), 정신건강 위기상담 1577-0199, 청소년 상담전화 1388에서 이야기를 나눌 수 있어요.',
    },
  ]);
  check(await ctx.db.from('crisis_alerts').update({ care_sent: true }).eq('id', alert.id as string));
}

// ---------- 개인정보 열람 (열람할 때마다 기록이 남아요) ----------
async function readIdentity(ctx: Ctx, admin: UserRow, userId: string, reason: 'crisis-alert' | 'super-admin') {
  const target = check(await ctx.db.from('users').select('id,email,nickname').eq('id', userId).maybeSingle()) as Row | null;
  if (!target) throw new HttpError(404, '사용자를 찾을 수 없어요.');
  const found = check(await ctx.db.from('identities').select('name,birth_date,phone').eq('user_id', userId).maybeSingle()) as Row | null;
  check(
    await ctx.db.from('identity_logs').insert({
      id: newId(), admin_id: admin.id, admin_nickname: admin.nickname, target_nickname: target.nickname, reason, at: iso(ctx),
    }),
  );
  return {
    userId: target.id as string,
    nickname: target.nickname as string,
    email: target.email as string,
    identity: found ? { name: found.name as string, birthDate: found.birth_date as string, phone: found.phone as string } : null,
  };
}

// 모든 운영자: 처리가 끝나지 않은 위기 알림의 글 작성자만 열람할 수 있어요.
export async function identityForAlert(ctx: Ctx, alertIdArg: unknown) {
  const admin = requireAdmin(ctx);
  const alert = check(await ctx.db.from('crisis_alerts').select('*').eq('id', str(alertIdArg, 60)).maybeSingle()) as Row | null;
  if (!alert) throw new HttpError(404, '위기 알림을 찾을 수 없어요.');
  if (alert.status === 'done') throw new HttpError(403, '처리가 끝난 위기 알림이라 개인정보를 볼 수 없어요.');
  const post = alert.post_id
    ? (check(await ctx.db.from('posts').select('id,author_id').eq('id', alert.post_id as string).maybeSingle()) as Row | null)
    : null;
  if (!post?.author_id) throw new HttpError(404, '글이 삭제되어 작성자를 찾을 수 없어요.');
  return readIdentity(ctx, admin, post.author_id as string, 'crisis-alert');
}

// 총괄 운영자 전용: 모든 회원 목록(개인정보는 포함하지 않아요)
export async function listMembers(ctx: Ctx) {
  requireSuperAdmin(ctx);
  const users = check(await ctx.db.from('users').select('id,nickname,email,role,created_at').order('created_at', { ascending: true })) as Row[];
  const ids = new Set((check(await ctx.db.from('identities').select('user_id')) as Row[]).map((r) => r.user_id as string));
  return users.map((u) => ({
    id: u.id as string, nickname: u.nickname as string, email: u.email as string, role: u.role as string,
    createdAt: u.created_at as string, hasIdentity: ids.has(u.id as string),
  }));
}

export async function viewIdentity(ctx: Ctx, userIdArg: unknown) {
  const admin = requireSuperAdmin(ctx);
  return readIdentity(ctx, admin, str(userIdArg, 60), 'super-admin');
}

export async function identityLogs(ctx: Ctx) {
  requireSuperAdmin(ctx);
  const rows = check(await ctx.db.from('identity_logs').select('*').order('at', { ascending: false }).limit(50)) as Row[];
  return rows.map((l) => ({
    id: l.id as string, adminId: (l.admin_id as string | null) ?? '', adminNickname: l.admin_nickname as string,
    targetNickname: l.target_nickname as string, reason: l.reason as string, at: l.at as string,
  }));
}

// ---------- 운영자 계정 관리 ----------
// 운영자 계정을 만드는 유일한 경로. 운영자만 호출할 수 있어요.
export async function createAdmin(ctx: Ctx, inputArg: unknown): Promise<void> {
  requireAdmin(ctx);
  const input = (inputArg ?? {}) as Row;
  const email = normEmail(str(input.email, 200));
  const nickname = str(input.nickname, 100).trim();
  const password = str(input.password, 200);
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, '올바른 이메일 형식이 아니에요.');
  await assertEmailAvailable(ctx, email);
  await assertNicknameAvailable(ctx, nickname);
  assertPassword(password);
  const created = await ctx.db.from('users').insert({
    id: newId(), email, password_hash: await hashPassword(password), nickname, nickname_key: nicknameKey(nickname),
    role: 'admin', leaves: 0, earned_today: 0, earned_date: null, created_at: iso(ctx),
  });
  if (isUniqueViolation(created.error)) throw new HttpError(409, '이미 사용 중인 이메일 또는 닉네임이에요.');
  check(created);
}

export async function listAdmins(ctx: Ctx) {
  const me = requireSuperAdmin(ctx);
  const rows = check(await ctx.db.from('users').select('id,email,nickname,role,created_at').eq('role', 'admin').order('created_at', { ascending: true })) as Row[];
  return rows
    .filter((u) => u.id !== me.id && !isSuperAdmin(ctx, u as UserRow))
    .map((u) => ({ id: u.id as string, email: u.email as string, nickname: u.nickname as string, createdAt: u.created_at as string }));
}

// 운영자 계정을 삭제하고, 그 이메일의 로그인·가입을 막아요. (글은 "탈퇴한 사용자"로 남고 고정은 풀려요)
export async function removeAdmin(ctx: Ctx, userIdArg: unknown): Promise<void> {
  requireSuperAdmin(ctx);
  const userId = str(userIdArg, 60);
  const target = check(await ctx.db.from('users').select('*').eq('id', userId).maybeSingle()) as UserRow | null;
  if (!target || target.role !== 'admin') throw new HttpError(404, '운영자 계정을 찾을 수 없어요.');
  if (isSuperAdmin(ctx, target)) throw new HttpError(403, '총괄 운영자 계정은 삭제할 수 없어요.');
  check(await ctx.db.from('blocked_emails').upsert({ email: normEmail(target.email), at: iso(ctx) }, { onConflict: 'email' }));
  check(await ctx.db.from('posts').update({ pinned: false }).eq('author_id', userId));
  check(await ctx.db.from('users').delete().eq('id', userId));
  if (target.auth_user_id) {
    const { error } = await ctx.db.auth.admin.deleteUser(target.auth_user_id);
    if (error) console.error('[Auth] removed admin identity cleanup failed:', error.code);
  }
}

export async function blockedEmails(ctx: Ctx) {
  requireSuperAdmin(ctx);
  const rows = check(await ctx.db.from('blocked_emails').select('*').order('at', { ascending: false })) as Row[];
  return rows.map((r) => ({ email: r.email as string, at: r.at as string }));
}

export async function unblockEmail(ctx: Ctx, emailArg: unknown): Promise<void> {
  requireSuperAdmin(ctx);
  check(await ctx.db.from('blocked_emails').delete().eq('email', normEmail(str(emailArg, 200))));
}
