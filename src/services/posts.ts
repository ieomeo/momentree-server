import { HttpError } from '../lib/errors';
import { countCrisisKeywords } from '../lib/crisis';
import {
  ALL_CATEGORIES, Ctx, DELETED_NICKNAME, LIKES_WINDOW_MS, NOTICE_CATEGORY, Row, UserRow,
  check, earnLeaves, hiddenAuthorIds, isUniqueViolation, iso, newId, pushNotifications,
  assertNotRestricted, requireAdmin, requireUser, selectIn, shorten, str, usersByIds,
} from './common';

// ---------- 화면용 모양으로 바꾸기 ----------
export async function toViews(ctx: Ctx, rows: Row[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id as string);
  const [likes, comments, authors] = await Promise.all([
    selectIn(ctx, 'post_likes', 'post_id,user_id', 'post_id', ids),
    selectIn(ctx, 'comments', 'post_id,hidden', 'post_id', ids),
    usersByIds(ctx, rows.map((r) => r.author_id as string).filter(Boolean)),
  ]);
  return rows.map((r) => {
    const author = r.author_id ? authors.get(r.author_id as string) : undefined;
    return {
      id: r.id as string,
      authorId: (r.author_id as string | null) ?? '',
      nickname: author ? (author.nickname as string) : DELETED_NICKNAME,
      category: r.category as string,
      title: r.title as string,
      content: r.content as string,
      createdAt: r.created_at as string,
      likedBy: likes.filter((l) => l.post_id === r.id).map((l) => l.user_id as string),
      hidden: !!(r.hidden || r.moderation_hidden),
      pinned: r.pinned as boolean,
      isPrivate: r.is_private as boolean,
      commentCount: comments.filter((c) => c.post_id === r.id && !c.hidden).length,
      authorIsAdmin: author?.role === 'admin',
    };
  });
}

type View = Awaited<ReturnType<typeof toViews>>[number];
// 공지(2) > 고정(1) > 일반(0)
const rank = (p: { category: string; pinned?: boolean }): number => (p.category === NOTICE_CATEGORY ? 2 : p.pinned ? 1 : 0);
const time = (p: { createdAt: string }): number => Date.parse(p.createdAt);

// 공개 글 후보 (최근 순)
async function publicRows(ctx: Ctx, category: string | null, limit: number): Promise<Row[]> {
  const me = requireUser(ctx);
  let query = ctx.db.from('posts').select('*').eq('hidden', false).neq('moderation_hidden', true).eq('is_private', false);
  if (category) query = query.eq('category', category);
  const rows = check(await query.order('created_at', { ascending: false }).limit(limit)) as Row[];
  const hidden = await hiddenAuthorIds(ctx, me.id);
  return rows.filter((r) => !hidden.has(r.author_id as string));
}

// ---------- 목록 · 검색 ----------
export async function list(ctx: Ctx, categoryArg: unknown, sortArg: unknown) {
  const category = str(categoryArg, 50) || '전체';
  const sort = sortArg === 'likes' ? 'likes' : 'latest';
  const rows = await publicRows(ctx, category === '전체' ? null : category, 200);
  let views: View[] = await toViews(ctx, rows);
  if (sort === 'likes') {
    // 공감순은 최근 24시간 안에 올린 글만 (공지·고정글은 항상 맨 위에 남아요)
    const cutoff = ctx.now().getTime() - LIKES_WINDOW_MS;
    views = views.filter((p) => rank(p) > 0 || time(p) >= cutoff);
  }
  views.sort(
    (a, b) =>
      rank(b) - rank(a) ||
      (sort === 'likes' ? b.likedBy.length - a.likedBy.length : 0) ||
      time(b) - time(a),
  );
  return views.slice(0, 100);
}

// 제목·본문에 키워드가 모두 들어 있는 글을 최근 순서로
export async function search(ctx: Ctx, queryArg: unknown) {
  const tokens = str(queryArg, 100).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const rows = await publicRows(ctx, null, 500);
  const found = rows
    .filter((r) => {
      const title = (r.title as string).toLowerCase();
      const body = (r.content as string).toLowerCase();
      return tokens.every((t) => title.includes(t) || body.includes(t));
    })
    .sort((a, b) => Date.parse(b.created_at as string) - Date.parse(a.created_at as string))
    .slice(0, 100);
  return toViews(ctx, found);
}

export async function mine(ctx: Ctx) {
  const me = requireUser(ctx);
  const rows = check(
    await ctx.db.from('posts').select('*').eq('author_id', me.id).eq('hidden', false).neq('moderation_hidden', true).order('created_at', { ascending: false }).limit(200),
  ) as Row[];
  return toViews(ctx, rows);
}

export async function subscribedFeed(ctx: Ctx) {
  const me = requireUser(ctx);
  const subs = check(await ctx.db.from('subscriptions').select('author_id').eq('subscriber_id', me.id)) as Row[];
  if (subs.length === 0) return [];
  const rows = (await selectIn(ctx, 'posts', '*', 'author_id', subs.map((s) => s.author_id as string)))
    .filter((r) => !r.hidden && !r.moderation_hidden && !r.is_private)
    .sort((a, b) => Date.parse(b.created_at as string) - Date.parse(a.created_at as string))
    .slice(0, 100);
  return toViews(ctx, rows);
}

// ---------- 한 글 보기 ----------
async function loadPost(ctx: Ctx, id: string): Promise<Row> {
  const row = check(await ctx.db.from('posts').select('*').eq('id', id).maybeSingle()) as Row | null;
  if (!row) throw new HttpError(404, '글을 찾을 수 없어요.');
  return row;
}

// 볼 수 있는 글인지 확인합니다. reviewMode는 운영자의 검토용 예외(게시 중단 글, 위기 알림이 달린 비공개 글).
async function assertCanView(ctx: Ctx, me: UserRow, post: Row, reviewMode = false): Promise<void> {
  const isAuthor = post.author_id === me.id;
  if (post.is_private && !isAuthor) {
    let allowed = false;
    if (reviewMode && me.role === 'admin') {
      const alert = check(await ctx.db.from('crisis_alerts').select('id').eq('post_id', post.id as string).limit(1)) as Row[];
      allowed = alert.length > 0;
    }
    if (!allowed) throw new HttpError(404, '글을 찾을 수 없어요.');
  }
  if ((post.hidden || post.moderation_hidden) && !(reviewMode && me.role === 'admin')) throw new HttpError(404, '글을 찾을 수 없어요.');
  if (!isAuthor && post.author_id && (await hiddenAuthorIds(ctx, me.id)).has(post.author_id as string)) {
    throw new HttpError(404, '글을 찾을 수 없어요.');
  }
}

export async function get(ctx: Ctx, idArg: unknown) {
  const me = requireUser(ctx);
  const post = await loadPost(ctx, str(idArg, 60));
  await assertCanView(ctx, me, post, true);
  return (await toViews(ctx, [post]))[0];
}

function postFields(me: UserRow, inputArg: unknown) {
  const input = (inputArg ?? {}) as Row;
  const category = str(input.category, 50);
  const title = str(input.title, 300).trim();
  const content = str(input.content, 5000).trim();
  if (!ALL_CATEGORIES.includes(category)) throw new HttpError(400, '카테고리를 선택해주세요.');
  if (category === NOTICE_CATEGORY && me.role !== 'admin') throw new HttpError(403, '공지글은 운영자만 쓸 수 있어요.');
  if (!title) throw new HttpError(400, '제목을 입력해주세요.');
  if (title.length > 60) throw new HttpError(400, '제목은 60자 이하로 입력해주세요.');
  if (!content) throw new HttpError(400, '내용을 입력해주세요.');
  if (content.length > 1000) throw new HttpError(400, '내용은 1000자 이하로 입력해주세요.');
  return { category, title, content };
}

export async function update(ctx: Ctx, idArg: unknown, inputArg: unknown) {
  const me = requireUser(ctx);
  assertNotRestricted(ctx, me);
  const id = str(idArg, 60);
  const post = await loadPost(ctx, id);
  if (post.author_id !== me.id) throw new HttpError(403, '자신이 쓴 글만 수정할 수 있어요.');
  if (post.hidden || post.moderation_hidden) throw new HttpError(404, '글을 찾을 수 없어요.');
  const fields = postFields(me, inputArg);
  if ((fields.category === NOTICE_CATEGORY) !== (post.category === NOTICE_CATEGORY)) {
    throw new HttpError(400, '수정할 때는 공지글 유형을 변경할 수 없어요.');
  }
  const updated = check(await ctx.db.from('posts').update(fields)
    .eq('id', id).eq('author_id', me.id).eq('hidden', false).neq('moderation_hidden', true).select('*').maybeSingle()) as Row | null;
  if (!updated) throw new HttpError(404, '글을 찾을 수 없어요.');
  const count = countCrisisKeywords(`${fields.title} ${fields.content}`);
  if (count > 0 && (fields.title !== post.title || fields.content !== post.content)) {
    await flagCrisis(ctx, id, count);
    await notifyCrisis(ctx, me, fields.title);
  }
  return (await toViews(ctx, [updated]))[0];
}

async function flagCrisis(ctx: Ctx, id: string, keywordCount: number) {
    check(
      await ctx.db.from('crisis_alerts').insert({
        id: newId(), post_id: id, keyword_count: keywordCount, status: 'pending', care_sent: false, created_at: iso(ctx),
      }),
    );
}

async function notifyCrisis(ctx: Ctx, me: UserRow, title: string) {
    const admins = check(await ctx.db.from('users').select('id').eq('role', 'admin').neq('id', me.id)) as Row[];
    await pushNotifications(
      ctx,
      admins.map((a) => ({
        userId: a.id as string,
        type: 'crisis' as const,
        text: `위기 알림: ‘${shorten(title)}’ 글에서 위기 키워드가 감지됐어요. 대시보드에서 확인해 주세요.`,
        link: '/admin',
      })),
    );
}

// ---------- 글쓰기 ----------
export async function create(ctx: Ctx, inputArg: unknown) {
  const me = requireUser(ctx);
  assertNotRestricted(ctx, me);
  const { category, title, content } = postFields(me, inputArg);

  const id = newId();
  check(
    await ctx.db.from('posts').insert({
      id, author_id: me.id, category, title, content, hidden: false, is_private: false, pinned: false, created_at: iso(ctx),
    }),
  );

  // 위기 키워드는 서버가 직접 세서 운영자에게 알립니다.
  const keywordCount = countCrisisKeywords(`${title} ${content}`);
  if (keywordCount > 0) {
    await flagCrisis(ctx, id, keywordCount);
  }
  await earnLeaves(ctx, me.id, 3, '글 작성', { type: 'post', id });

  // 알림: 공지글 → 모든 이용자, 일반 글 → 나를 구독한 사람, 위기 키워드 → 운영자
  const link = `/post/${id}`;
  if (category === NOTICE_CATEGORY) {
    const everyone = check(await ctx.db.from('users').select('id').neq('id', me.id)) as Row[];
    await pushNotifications(
      ctx,
      everyone.map((u) => ({ userId: u.id as string, type: 'notice' as const, text: `새 공지글: ${shorten(title)}`, link })),
    );
  } else {
    const subs = check(await ctx.db.from('subscriptions').select('subscriber_id').eq('author_id', me.id)) as Row[];
    const blockers = check(await ctx.db.from('blocks').select('blocker_id').eq('blocked_id', me.id)) as Row[];
    const blocked = new Set(blockers.map((b) => b.blocker_id as string));
    await pushNotifications(
      ctx,
      subs
        .map((s) => s.subscriber_id as string)
        .filter((uid) => !blocked.has(uid))
        .map((uid) => ({
          userId: uid, type: 'new-post' as const, text: `구독 중인 ${me.nickname}님이 새 글을 올렸어요: ${shorten(title)}`, link,
        })),
    );
  }
  if (keywordCount > 0) {
    await notifyCrisis(ctx, me, title);
  }
  return (await toViews(ctx, [await loadPost(ctx, id)]))[0];
}

// ---------- 공감 ----------
export async function toggleLike(ctx: Ctx, idArg: unknown): Promise<void> {
  const me = requireUser(ctx);
  assertNotRestricted(ctx, me);
  const post = await loadPost(ctx, str(idArg, 60));
  await assertCanView(ctx, me, post);
  const existing = check(
    await ctx.db.from('post_likes').select('post_id').eq('post_id', post.id as string).eq('user_id', me.id).maybeSingle(),
  );
  if (existing) {
    check(await ctx.db.from('post_likes').delete().eq('post_id', post.id as string).eq('user_id', me.id));
    return;
  }
  const inserted = await ctx.db.from('post_likes').insert({ post_id: post.id, user_id: me.id });
  if (isUniqueViolation(inserted.error)) return; // 동시에 두 번 눌러도 한 번만
  check(inserted);
  if (post.author_id && post.author_id !== me.id) {
    await earnLeaves(ctx, post.author_id as string, 1, '공감 받음', { type: 'post', id: post.id as string });
    await pushNotifications(ctx, [
      { userId: post.author_id as string, type: 'like', text: `${me.nickname}님이 ‘${shorten(post.title as string)}’ 글에 공감했어요`, link: `/post/${post.id}` },
    ]);
  }
}

// ---------- 내 글 관리 · 운영자 ----------
export async function setPrivate(ctx: Ctx, idArg: unknown, flag: unknown): Promise<void> {
  const me = requireUser(ctx);
  const post = await loadPost(ctx, str(idArg, 60));
  if (post.author_id !== me.id) throw new HttpError(403, '내가 쓴 글만 비공개로 바꿀 수 있어요.');
  check(await ctx.db.from('posts').update({ is_private: flag === true }).eq('id', post.id as string));
}

// 글 삭제: 작성자 본인 또는 운영자. 댓글·공감은 DB가 함께 지워요.
export async function remove(ctx: Ctx, idArg: unknown): Promise<void> {
  const me = requireUser(ctx);
  const post = await loadPost(ctx, str(idArg, 60));
  if (post.author_id !== me.id && me.role !== 'admin') throw new HttpError(403, '삭제할 권한이 없어요.');
  check(await ctx.db.from('posts').delete().eq('id', post.id as string));
  if (post.author_id && post.author_id !== me.id) {
    await pushNotifications(ctx, [
      {
        userId: post.author_id as string,
        type: 'removed',
        text: `운영자가 ‘${shorten(post.title as string)}’ 글을 삭제했어요. 궁금한 점은 이용약관의 이의 제기 절차를 확인해 주세요.`,
      },
    ]);
  }
}

export async function setPinned(ctx: Ctx, idArg: unknown, flag: unknown): Promise<void> {
  requireAdmin(ctx);
  const post = await loadPost(ctx, str(idArg, 60));
  check(await ctx.db.from('posts').update({ pinned: flag === true }).eq('id', post.id as string));
}

// ---------- 댓글 ----------
export async function listComments(ctx: Ctx, postIdArg: unknown) {
  const me = requireUser(ctx);
  const post = await loadPost(ctx, str(postIdArg, 60));
  await assertCanView(ctx, me, post, true);
  const rows = check(
    await ctx.db.from('comments').select('*').eq('post_id', post.id as string).order('created_at', { ascending: true }),
  ) as Row[];
  const hidden = await hiddenAuthorIds(ctx, me.id);
  const visible = rows.filter((c) => !c.hidden && !hidden.has(c.author_id as string));
  const authors = await usersByIds(ctx, visible.map((c) => c.author_id as string));
  return visible.map((c) => ({
    id: c.id as string,
    postId: c.post_id as string,
    authorId: (c.author_id as string | null) ?? '',
    nickname: c.author_id && authors.get(c.author_id as string) ? (authors.get(c.author_id as string)!.nickname as string) : DELETED_NICKNAME,
    content: c.content as string,
    createdAt: c.created_at as string,
  }));
}

export async function addComment(ctx: Ctx, postIdArg: unknown, contentArg: unknown): Promise<void> {
  const me = requireUser(ctx);
  assertNotRestricted(ctx, me);
  const content = str(contentArg, 1000).trim();
  if (!content) throw new HttpError(400, '댓글을 입력해주세요.');
  if (content.length > 300) throw new HttpError(400, '댓글은 300자 이하로 입력해주세요.');
  const post = await loadPost(ctx, str(postIdArg, 60));
  await assertCanView(ctx, me, post);
  const commentId = newId();
  check(await ctx.db.from('comments').insert({ id: commentId, post_id: post.id, author_id: me.id, content, created_at: iso(ctx) }));
  await earnLeaves(ctx, me.id, 1, '댓글 작성', { type: 'comment', id: commentId });
  if (post.author_id && post.author_id !== me.id) {
    await pushNotifications(ctx, [
      {
        userId: post.author_id as string,
        type: 'comment',
        text: `${me.nickname}님이 ‘${shorten(post.title as string)}’ 글에 댓글을 남겼어요: “${shorten(content, 30)}”`,
        link: `/post/${post.id}`,
      },
    ]);
  }
}

