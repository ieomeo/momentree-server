import { HttpError } from '../lib/errors';
import {
  Ctx, NOTE_MAX, REPORT_REASONS, Row, SUBSCRIBE_COST,
  assertNotRestricted, check, iso, newId, pushNotifications, requireUser, selectIn, shorten, str,
} from './common';

// ---------- 구독 · 차단 ----------
export async function subscribe(ctx: Ctx, authorIdArg: unknown): Promise<void> {
  const me = requireUser(ctx);
  assertNotRestricted(ctx, me);
  const authorId = str(authorIdArg, 60);
  if (authorId === me.id) throw new HttpError(400, '나 자신은 구독할 수 없어요.');
  const target = check(await ctx.db.from('users').select('id,nickname').eq('id', authorId).maybeSingle()) as Row | null;
  if (!target) throw new HttpError(404, '사용자를 찾을 수 없어요.');
  const already = check(
    await ctx.db.from('subscriptions').select('author_id').eq('subscriber_id', me.id).eq('author_id', authorId).maybeSingle(),
  );
  if (already) throw new HttpError(409, '이미 구독 중이에요.');
  const result = check(await ctx.db.rpc('subscribe_with_leaves', { p_user: me.id, p_author: authorId, p_label: `구독 (${target.nickname})` }));
  if (result === 'insufficient') throw new HttpError(400, `나뭇잎이 부족해요. (${SUBSCRIBE_COST}개 필요)`);
  if (result === 'duplicate') throw new HttpError(409, '이미 구독 중이에요.');
  await pushNotifications(ctx, [{ userId: authorId, type: 'subscribe', text: `${me.nickname}님이 나를 구독했어요` }]);
}

export async function block(ctx: Ctx, userIdArg: unknown): Promise<void> {
  const me = requireUser(ctx);
  const userId = str(userIdArg, 60);
  if (userId === me.id) throw new HttpError(400, '나 자신은 차단할 수 없어요.');
  const target = check(await ctx.db.from('users').select('id').eq('id', userId).maybeSingle());
  if (!target) throw new HttpError(404, '사용자를 찾을 수 없어요.');
  check(await ctx.db.from('blocks').upsert({ blocker_id: me.id, blocked_id: userId }, { onConflict: 'blocker_id,blocked_id' }));
  check(await ctx.db.from('subscriptions').delete().eq('subscriber_id', me.id).eq('author_id', userId));
}

export async function unblock(ctx: Ctx, userIdArg: unknown): Promise<void> {
  const me = requireUser(ctx);
  check(await ctx.db.from('blocks').delete().eq('blocker_id', me.id).eq('blocked_id', str(userIdArg, 60)));
}

export async function blockedUsers(ctx: Ctx) {
  const me = requireUser(ctx);
  const rows = check(await ctx.db.from('blocks').select('blocked_id').eq('blocker_id', me.id)) as Row[];
  if (rows.length === 0) return [];
  const users = await selectIn(ctx, 'users', 'id,nickname', 'id', rows.map((r) => r.blocked_id as string));
  return users.map((u) => ({ id: u.id as string, nickname: u.nickname as string }));
}

// ---------- 나뭇잎 내역 ----------
export async function leafLogs(ctx: Ctx) {
  const me = requireUser(ctx);
  const rows = check(
    await ctx.db.from('leaf_logs').select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(100),
  ) as Row[];
  return rows.map((r) => ({
    id: r.id as string, userId: r.user_id as string, type: r.type as string, label: r.label as string,
    amount: r.amount as number, createdAt: r.created_at as string,
  }));
}

// ---------- 오늘의 쉼표 (나만 볼 수 있어요) ----------
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function noteDate(value: unknown): string {
  const date = str(value, 20);
  if (!DATE_PATTERN.test(date)) throw new HttpError(400, '날짜 형식이 올바르지 않아요.');
  return date;
}

export async function noteToday(ctx: Ctx, dateArg: unknown): Promise<string> {
  const me = requireUser(ctx);
  const row = check(
    await ctx.db.from('daily_notes').select('text').eq('user_id', me.id).eq('note_date', noteDate(dateArg)).maybeSingle(),
  ) as Row | null;
  return row ? (row.text as string) : '';
}

// 비어 있는 글을 저장하면 오늘의 쉼표를 지워요.
export async function saveNote(ctx: Ctx, textArg: unknown, dateArg: unknown): Promise<void> {
  const me = requireUser(ctx);
  const date = noteDate(dateArg);
  const text = str(textArg, 2000).trim();
  if (text.length > NOTE_MAX) throw new HttpError(400, `${NOTE_MAX}자 이하로 적어주세요.`);
  if (!text) {
    check(await ctx.db.from('daily_notes').delete().eq('user_id', me.id).eq('note_date', date));
    return;
  }
  check(
    await ctx.db.from('daily_notes').upsert(
      { user_id: me.id, note_date: date, text, updated_at: iso(ctx) },
      { onConflict: 'user_id,note_date' },
    ),
  );
}

// ---------- 알림 ----------
export async function notificationList(ctx: Ctx) {
  const me = requireUser(ctx);
  const rows = check(
    await ctx.db.from('notifications').select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(100),
  ) as Row[];
  return rows.map((r) => ({
    id: r.id as string, userId: r.user_id as string, type: r.type as string, text: r.text as string,
    link: (r.link as string | null) ?? undefined, createdAt: r.created_at as string, read: r.read as boolean,
  }));
}

export async function notificationsMarkAllRead(ctx: Ctx): Promise<void> {
  const me = requireUser(ctx);
  check(await ctx.db.from('notifications').update({ read: true }).eq('user_id', me.id).eq('read', false));
}

export async function notificationsClear(ctx: Ctx): Promise<void> {
  const me = requireUser(ctx);
  check(await ctx.db.from('notifications').delete().eq('user_id', me.id));
}

// ---------- 신고 ----------
export async function createReport(ctx: Ctx, inputArg: unknown): Promise<void> {
  const me = requireUser(ctx);
  assertNotRestricted(ctx, me);
  const input = (inputArg ?? {}) as Row;
  const targetType = input.targetType === 'comment' ? 'comment' : input.targetType === 'post' ? 'post' : '';
  const reason = str(input.reason, 100);
  if (!targetType) throw new HttpError(400, '신고 대상이 올바르지 않아요.');
  if (!REPORT_REASONS.includes(reason)) throw new HttpError(400, '신고 사유를 선택해주세요.');
  const targetId = str(input.targetId, 60);

  // 신고 대상의 요약은 서버가 직접 찾아서 적어요. (클라이언트가 꾸밀 수 없게)
  let preview: string;
  if (targetType === 'post') {
    const post = check(await ctx.db.from('posts').select('id,title').eq('id', targetId).maybeSingle()) as Row | null;
    if (!post) throw new HttpError(404, '신고할 글을 찾을 수 없어요.');
    preview = shorten(post.title as string, 40);
  } else {
    const comment = check(await ctx.db.from('comments').select('id,content').eq('id', targetId).maybeSingle()) as Row | null;
    if (!comment) throw new HttpError(404, '신고할 댓글을 찾을 수 없어요.');
    preview = shorten(comment.content as string, 40);
  }
  const detail = str(input.detail, 200).trim();
  check(
    await ctx.db.from('reports').insert({
      id: newId(), target_type: targetType, target_id: targetId, target_preview: preview, reason,
      detail: detail || null, reporter_id: me.id, status: 'pending', created_at: iso(ctx),
    }),
  );
}
