import type { User as AuthUser } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Db } from '../config/supabase';
import type { Env } from '../config/env';
import { HttpError } from '../lib/errors';
import type { Mailer } from '../lib/mailer';

// ---------- 서비스 규칙(상수) ----------
export const DAILY_CAP = 20; // 하루 나뭇잎 적립 상한
export const SUBSCRIBE_COST = 10;
export const WITHDRAW_BLOCK_DAYS = 30;
export const NICKNAME_MAX = 12;
export const NOTE_MAX = 300;
export const LIKES_WINDOW_MS = 24 * 3600 * 1000;
export const DELETED_NICKNAME = '탈퇴한 사용자';
export const NOTICE_CATEGORY = '공지글';
export const CATEGORIES = ['시', '가사', '일기', '단상', '한 줄 문구', '작은 온기', '연결'];
export const ALL_CATEGORIES = [NOTICE_CATEGORY, ...CATEGORIES];
export const REPORT_REASONS = ['자극적이거나 위험한 내용(방법·수단 묘사)', '욕설·악성 표현', '스팸·광고', '기타'];
export const REPORT_ACTIONS = ['문제 없음', '경고 및 게시 중단', '이용 제한'];
// 이용 제한 기간(일). 0은 영구 제한이에요.
export const RESTRICT_DAYS = [1, 3, 7, 30, 90, 0];
export const PERMANENT_UNTIL = '9999-12-31T00:00:00.000Z';
export const MIN_AGE = 14;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  auth_user_id?: string | null;
  nickname: string;
  nickname_key: string;
  role: 'user' | 'admin';
  leaves: number;
  earned_today: number;
  earned_date: string | null;
  avatar: string | null;
  restricted_until: string | null;
  restriction_reason: string | null;
  created_at: string;
}

export interface Ctx {
  db: Db;
  env: Env;
  mailer: Mailer;
  me: UserRow | null;
  authUser?: AuthUser | null;
  now: () => Date;
}

export type NotificationType =
  | 'like' | 'comment' | 'subscribe' | 'new-post' | 'notice'
  | 'warning' | 'removed' | 'restricted' | 'crisis' | 'care';

// ---------- 작은 도우미 ----------
export const newId = (): string => randomUUID();
export const iso = (ctx: Ctx): string => ctx.now().toISOString();
export const normEmail = (email: string): string => email.trim().toLowerCase();
export const nicknameKey = (nickname: string): string => nickname.replace(/\s+/g, '').toLowerCase();
export const shorten = (text: string, max = 24): string => (text.length > max ? `${text.slice(0, max)}…` : text);
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 클라이언트가 보낸 값은 믿지 않고 문자열로 정리합니다.
export const str = (value: unknown, max = 10000): string => (typeof value === 'string' ? value.slice(0, max) : '');

export function check<T>(res: { data: T; error: { code?: string; message: string } | null }): T {
  if (res.error) {
    console.error('[Supabase]', res.error.code ?? 'error', res.error.message);
    throw new HttpError(503, 'DB 요청에 실패했어요. 잠시 뒤 다시 시도해주세요.');
  }
  return res.data;
}

export const isUniqueViolation = (error: { code?: string } | null): boolean => error?.code === '23505';

// .in()에 넣는 id가 많으면 주소가 너무 길어지므로 나눠서 조회합니다.
export async function selectIn(ctx: Ctx, table: string, columns: string, column: string, ids: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    out.push(...(check(await ctx.db.from(table).select(columns).in(column, part)) as Row[]));
  }
  return out;
}

// ---------- 권한 ----------
export function requireUser(ctx: Ctx): UserRow {
  if (!ctx.me) throw new HttpError(401, '로그인이 필요해요.');
  return ctx.me;
}

export function requireAdmin(ctx: Ctx): UserRow {
  const me = requireUser(ctx);
  if (me.role !== 'admin') throw new HttpError(403, '운영자만 접근할 수 있어요.');
  return me;
}

// 총괄 운영자: 고정 운영자 이메일을 쓰는 운영자 계정 하나
export const isSuperAdmin = (ctx: Ctx, user: UserRow): boolean =>
  user.role === 'admin' && normEmail(user.email) === ctx.env.superAdminEmail;

export function requireSuperAdmin(ctx: Ctx): UserRow {
  const me = requireUser(ctx);
  if (!isSuperAdmin(ctx, me)) throw new HttpError(403, '총괄 운영자만 사용할 수 있어요.');
  return me;
}

// ---------- 사용자 조회 ----------
export async function usersByIds(ctx: Ctx, ids: string[]): Promise<Map<string, Row>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const rows = unique.length ? await selectIn(ctx, 'users', 'id,nickname,role', 'id', unique) : [];
  return new Map(rows.map((r) => [r.id as string, r]));
}

// ---------- 이용 제한 ----------
export function isRestricted(ctx: Ctx, user: Pick<UserRow, 'restricted_until'>): boolean {
  return !!user.restricted_until && Date.parse(user.restricted_until) > ctx.now().getTime();
}

export function restrictionLabel(until: string): string {
  return Date.parse(until) >= Date.parse('9000-01-01') ? '계속' : `${new Date(until).toISOString().slice(0, 10)}까지`;
}

// 이용 제한 중이면 글쓰기·댓글·공감·구독·신고 같은 활동을 막아요. (읽기·내 글 관리·알림·탈퇴는 가능)
export function assertNotRestricted(ctx: Ctx, user: UserRow): void {
  if (!isRestricted(ctx, user) || !user.restricted_until) return;
  const reason = user.restriction_reason ? `, 사유: ${user.restriction_reason}` : '';
  throw new HttpError(
    403,
    `이용이 제한된 상태예요. (${restrictionLabel(user.restricted_until)}${reason}) 이의가 있으면 이용약관의 이의 제기 절차를 확인해주세요.`,
  );
}

export async function userView(ctx: Ctx, user: UserRow) {
  const [subs, blocks] = await Promise.all([
    ctx.db.from('subscriptions').select('author_id').eq('subscriber_id', user.id),
    ctx.db.from('blocks').select('blocked_id').eq('blocker_id', user.id),
  ]);
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    role: user.role,
    leaves: user.leaves,
    earnedToday: user.earned_today,
    earnedDate: user.earned_date ?? '',
    avatar: user.avatar ?? undefined,
    createdAt: user.created_at,
    subscribed: (check(subs) as Row[]).map((r) => r.author_id as string),
    blocked: (check(blocks) as Row[]).map((r) => r.blocked_id as string),
    isSuperAdmin: isSuperAdmin(ctx, user),
    restrictedUntil: isRestricted(ctx, user) ? (user.restricted_until as string) : undefined,
    restrictionReason: isRestricted(ctx, user) ? (user.restriction_reason ?? undefined) : undefined,
  };
}

// 내가 차단했거나 나를 차단한 사람 (서로의 글·댓글이 보이지 않아요)
export async function hiddenAuthorIds(ctx: Ctx, meId: string): Promise<Set<string>> {
  const [mine, theirs] = await Promise.all([
    ctx.db.from('blocks').select('blocked_id').eq('blocker_id', meId),
    ctx.db.from('blocks').select('blocker_id').eq('blocked_id', meId),
  ]);
  return new Set([
    ...(check(mine) as Row[]).map((r) => r.blocked_id as string),
    ...(check(theirs) as Row[]).map((r) => r.blocker_id as string),
  ]);
}

// ---------- 알림 · 나뭇잎 ----------
export interface NewNotification {
  userId: string;
  type: NotificationType;
  text: string;
  link?: string;
}

// 같은 내용의 '읽지 않은' 알림이 이미 있으면 중복해서 만들지 않아요.
export async function pushNotifications(ctx: Ctx, items: NewNotification[]): Promise<void> {
  if (items.length === 0) return;
  const unread = await selectIn(ctx, 'notifications', 'user_id,type,text,link,read', 'user_id', [...new Set(items.map((n) => n.userId))]);
  const unreadRows = unread.filter((r) => r.read === false);
  const seen = new Set(unreadRows.map((r) => `${r.user_id}|${r.type}|${r.text}|${r.link ?? ''}`));
  const fresh = items
    .filter((n) => {
      const key = `${n.userId}|${n.type}|${n.text}|${n.link ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((n) => ({
      id: newId(), user_id: n.userId, type: n.type, text: n.text, link: n.link ?? null, read: false, created_at: iso(ctx),
    }));
  if (fresh.length === 0) return;
  check(await ctx.db.from('notifications').insert(fresh));
}

// DB locks the source and balance, then records the actual credited reward together.
export async function earnLeaves(ctx: Ctx, userId: string, amount: number, label: string, source: { type: 'post' | 'comment'; id: string }): Promise<void> {
  check(await ctx.db.rpc('earn_content_leaves', { p_user: userId, p_amount: amount, p_label: label,
    p_source_type: source.type, p_source_id: source.id, p_now: iso(ctx) }));
}
