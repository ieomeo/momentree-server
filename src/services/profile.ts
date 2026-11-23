import { HttpError } from '../lib/errors';
import { assertNotRestricted, check, hiddenAuthorIds, isSuperAdmin, isUniqueViolation, newId, requireUser, str, usersByIds } from './common';
import type { Ctx, Row } from './common';

function uuid(arg: unknown) {
  const id = str(arg, 36);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400, '올바르지 않은 주소예요.');
  return id.toLowerCase();
}
function offset(arg: unknown) { return typeof arg === 'number' && Number.isSafeInteger(arg) && arg >= 0 && arg <= 1000000 ? arg : 0; }
export async function profile(ctx: Ctx, arg: unknown, startArg: unknown) {
  const me = requireUser(ctx), id = uuid(arg), start = offset(startArg);
  if ((await hiddenAuthorIds(ctx, me.id)).has(id)) throw new HttpError(404, '프로필을 볼 수 없어요.');
  const user = check(await ctx.db.from('users').select('nickname,avatar,bio').eq('id', id).maybeSingle());
  if (!user) throw new HttpError(404, '프로필을 볼 수 없어요.');
  const rows = check(await ctx.db.from('posts').select('id,title,category,created_at').eq('author_id', id)
    .eq('hidden', false).eq('moderation_hidden', false).eq('is_private', false)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).range(start, start + 20)) as Row[];
  return { ...user, own: me.id === id, more: rows.length > 20, posts: rows.slice(0, 20) };
}
export async function garden(ctx: Ctx) {
  const me = requireUser(ctx);
  const [user, total] = await Promise.all([ctx.db.from('users').select('bio').eq('id', me.id).single(), ctx.db.rpc('garden_total', { p_user: me.id })]);
  const u = check(user) as Row | null; return { bio: typeof u?.bio === 'string' ? u.bio : '', total: Number(check(total)) };
}
export async function saveBio(ctx: Ctx, arg: unknown) {
  const me = requireUser(ctx);
  assertNotRestricted(ctx, me);
  const bio = typeof arg === 'string' ? arg.trim() : '';
  if (Array.from(bio).length > 500) throw new HttpError(400, '자기소개는 500자까지 쓸 수 있어요.');
  check(await ctx.db.from('users').update({ bio }).eq('id', me.id));
}
export async function send(ctx: Ctx, recipient: unknown, arg: unknown) {
  const me = requireUser(ctx);
  const body = typeof arg === 'string' ? arg.trim() : '';
  if (!body || Array.from(body).length > 1000) throw new HttpError(400, '쪽지를 1~1,000자로 입력해주세요.');
  const result = check(await ctx.db.rpc('send_direct_note', { p_sender: me.id, p_recipient: uuid(recipient), p_body: body, p_unlimited: isSuperAdmin(ctx, me) }));
  if (result === 'insufficient') throw new HttpError(400, '나뭇잎이 30개 필요해요.');
  if (result !== 'sent') throw new HttpError(403, '이 계정에 쪽지를 보낼 수 없어요.');
}
export async function inbox(ctx: Ctx, arg: unknown) {
  const me = requireUser(ctx), start = offset(arg);
  const rows = check(await ctx.db.from('direct_notes').select('id,sender_id').eq('recipient_id', me.id).eq('hidden', false)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).range(start, start + 20)) as Row[];
  const names = await usersByIds(ctx, rows.map(r => r.sender_id as string));
  return { more: rows.length > 20, notes: rows.slice(0,20).map(r => ({ id: r.id, nickname: names.get(r.sender_id as string)?.nickname ?? '알 수 없음' })) };
}
export async function noteDetail(ctx: Ctx, arg: unknown) {
  const me = requireUser(ctx), id = uuid(arg);
  const note = check(await ctx.db.from('direct_notes').select('id,sender_id,body,created_at').eq('id', id).eq('recipient_id', me.id).eq('hidden', false).maybeSingle());
  if (!note) throw new HttpError(404, '이 쪽지를 볼 수 없어요.');
  const [names, reports] = await Promise.all([
    usersByIds(ctx, [note.sender_id]),
    ctx.db.from('reports').select('id').eq('target_type', 'note').eq('target_id', id).eq('reporter_id', me.id).limit(1),
  ]);
  return { ...note, nickname: names.get(note.sender_id)?.nickname ?? '알 수 없음', reported: (check(reports) as Row[]).length > 0 };
}
export async function report(ctx: Ctx, arg: unknown, reasonArg: unknown) {
  const me = requireUser(ctx), id = uuid(arg), reason = str(reasonArg, 250);
  if (!reason) throw new HttpError(400, '신고 이유를 입력해주세요.');
  const note = check(await ctx.db.from('direct_notes').select('body').eq('id', id).eq('recipient_id', me.id).maybeSingle());
  if (!note) throw new HttpError(404, '받은 쪽지만 신고할 수 있어요.');
  const result = await ctx.db.from('reports').insert({ id: newId(), target_type: 'note', target_id: id, target_preview: note.body, reason: '쪽지 신고', detail: reason, reporter_id: me.id });
  if (!isUniqueViolation(result.error)) check(result);
}
