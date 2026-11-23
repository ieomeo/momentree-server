import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rejects, setup } from './helpers/setup';

const post = (title: string, content = '내용', category = '시') => ({ category, title, content });

test('글쓰기: 검증 · 일반 사용자는 공지글 불가 · 나뭇잎 적립 상한', async () => {
  const t = setup();
  const a = await t.register('a@a.com', '에이');
  await rejects(t.call(a.id, 'post.create', post('', '내용')), '제목');
  await rejects(t.call(a.id, 'post.create', post('x'.repeat(61))), '60자');
  await rejects(t.call(a.id, 'post.create', post('제목', 'y'.repeat(1001))), '1000자');
  await rejects(t.call(a.id, 'post.create', post('제목', '내용', '없는카테고리')), '카테고리');
  await rejects(t.call(a.id, 'post.create', post('공지', '내용', '공지글')), '운영자');

  for (let i = 0; i < 9; i++) await t.call(a.id, 'post.create', post(`글${i}`));
  const me = await t.call(a.id, 'auth.me');
  assert.equal(me.leaves, 20); // 하루 상한 20개 (글 하나에 3개 → 7번째까지만 전부 적립)
  assert.equal((await t.call(a.id, 'leaf.logs')).length >= 7, true);
});

test('위기 키워드는 서버가 직접 세고, 클라이언트가 숨길 수 없다', async () => {
  const t = setup();
  const adminId = await t.seed();
  const a = await t.register('a@a.com', '에이');
  // 클라이언트가 두 번째 인자로 0을 보내도 소용없음
  await t.call(a.id, 'post.create', post('힘든 날', '유서를 쓰고 싶다'), 0);
  const alerts = await t.call(adminId, 'admin.alerts');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].keywordCount, 1);
  assert.ok((await t.call(adminId, 'notification.list')).some((n: { type: string }) => n.type === 'crisis'));
});

test('목록: 공지 > 고정 > 일반, 공감순은 24시간 제한, 검색은 최근 순', async () => {
  const t = setup();
  const adminId = await t.seed();
  const a = await t.register('a@a.com', '에이');
  const b = await t.register('b@b.com', '비');

  const old = await t.call(a.id, 'post.create', post('오래된 인기글', '비 오는 날'));
  await t.call(b.id, 'post.toggleLike', old.id);
  t.tick(25 * 3600000); // 25시간 뒤
  const fresh = await t.call(a.id, 'post.create', post('새 글', '비가 그쳤다'));
  t.tick(1000);
  const newest = await t.call(b.id, 'post.create', post('최신 글', '맑음 비'));
  const notice = await t.call(adminId, 'post.create', post('점검 안내', '내일 점검', '공지글'));

  const latest = await t.call(a.id, 'post.list', '전체', 'latest');
  assert.equal(latest[0].id, notice.id); // 공지가 맨 위
  assert.deepEqual(latest.slice(1).map((p: { id: string }) => p.id), [newest.id, fresh.id, old.id]);

  const likes = await t.call(a.id, 'post.list', '전체', 'likes');
  assert.equal(likes.some((p: { id: string }) => p.id === old.id), false); // 24시간 지난 글은 공감순에서 빠짐
  await t.call(a.id, 'post.toggleLike', newest.id);
  const likes2 = await t.call(a.id, 'post.list', '전체', 'likes');
  assert.deepEqual(likes2.map((p: { id: string }) => p.id), [notice.id, newest.id, fresh.id]);

  // 고정은 운영자만
  await rejects(t.call(a.id, 'post.setPinned', old.id, true), '운영자');
  await t.call(adminId, 'post.setPinned', old.id, true);
  const pinned = await t.call(a.id, 'post.list', '전체', 'latest');
  assert.deepEqual(pinned.slice(0, 2).map((p: { id: string }) => p.id), [notice.id, old.id]);
  assert.equal((await t.call(a.id, 'post.list', '전체', 'likes'))[1].id, old.id); // 고정글은 공감순에도 남음
  await t.call(adminId, 'post.setPinned', old.id, false);

  const found = await t.call(a.id, 'post.search', '비');
  assert.deepEqual(found.map((p: { id: string }) => p.id), [newest.id, fresh.id, old.id]); // 최근 순
  assert.equal((await t.call(a.id, 'post.search', '비 맑음')).length, 1);
  assert.equal((await t.call(a.id, 'post.search', '없는단어')).length, 0);
  assert.equal((await t.call(a.id, 'post.list', '공지글', 'latest')).length, 1);
});

test('비공개 · 삭제 · 게시 중단 · 차단', async () => {
  const t = setup();
  const adminId = await t.seed();
  const a = await t.register('a@a.com', '에이');
  const b = await t.register('b@b.com', '비');
  const p = await t.call(a.id, 'post.create', post('내 글'));

  await rejects(t.call(b.id, 'post.setPrivate', p.id, true), '내가 쓴');
  await t.call(a.id, 'post.setPrivate', p.id, true);
  assert.equal((await t.call(b.id, 'post.list', '전체', 'latest')).length, 0);
  assert.equal((await t.call(b.id, 'post.search', '내 글')).length, 0);
  await rejects(t.call(b.id, 'post.get', p.id), '찾을 수 없어요');
  await rejects(t.call(adminId, 'post.get', p.id), '찾을 수 없어요'); // 위기 알림이 없으면 운영자도 못 봄
  assert.equal((await t.call(a.id, 'post.mine')).length, 1);
  await t.call(a.id, 'post.setPrivate', p.id, false);
  assert.equal((await t.call(b.id, 'post.list', '전체', 'latest')).length, 1);

  // 차단하면 서로의 글이 보이지 않음
  await t.call(b.id, 'social.block', a.id);
  assert.equal((await t.call(b.id, 'post.list', '전체', 'latest')).length, 0);
  assert.equal((await t.call(a.id, 'post.get', p.id)).id, p.id);
  await t.call(a.id, 'post.create', post('두번째'));
  assert.equal((await t.call(b.id, 'post.list', '전체', 'latest')).length, 0);
  assert.equal((await t.call(b.id, 'social.blockedUsers'))[0].nickname, '에이');
  await t.call(b.id, 'social.unblock', a.id);
  assert.equal((await t.call(b.id, 'post.list', '전체', 'latest')).length, 2);

  // 삭제: 작성자 또는 운영자만
  await rejects(t.call(b.id, 'post.remove', p.id), '권한');
  await t.call(adminId, 'post.remove', p.id);
  assert.ok((await t.call(a.id, 'notification.list')).some((n: { type: string }) => n.type === 'removed'));
  await rejects(t.call(a.id, 'post.get', p.id), '찾을 수 없어요');
});

test('알림: 공감 · 댓글 · 구독 · 구독자의 새 글 · 공지 · 중복 방지', async () => {
  const t = setup();
  const adminId = await t.seed();
  const a = await t.register('a@a.com', '에이');
  const b = await t.register('b@b.com', '비');
  for (let i = 0; i < 4; i++) await t.call(b.id, 'post.create', post(`비의 글 ${i}`)); // 나뭇잎 12개

  await rejects(t.call(b.id, 'social.subscribe', b.id), '자신');
  await t.call(b.id, 'social.subscribe', a.id);
  assert.equal((await t.call(b.id, 'auth.me')).leaves, 2); // 10개 사용
  await rejects(t.call(b.id, 'social.subscribe', a.id), '이미');
  assert.ok((await t.call(a.id, 'notification.list')).some((n: { type: string }) => n.type === 'subscribe'));

  const p = await t.call(a.id, 'post.create', post('노을 일기'));
  assert.ok((await t.call(b.id, 'notification.list')).some((n: { type: string }) => n.type === 'new-post'));
  assert.deepEqual((await t.call(b.id, 'auth.me')).subscribed, [a.id]);

  await t.call(b.id, 'post.toggleLike', p.id);
  await t.call(b.id, 'comment.add', p.id, '좋은 글이에요');
  const na = await t.call(a.id, 'notification.list');
  assert.ok(na.some((n: { type: string }) => n.type === 'like'));
  assert.ok(na.some((n: { type: string }) => n.type === 'comment'));
  assert.ok(na.every((n: { read: boolean }) => !n.read));

  const before = (await t.call(a.id, 'notification.list')).length;
  await t.call(b.id, 'post.toggleLike', p.id); await t.call(b.id, 'post.toggleLike', p.id);
  assert.ok((await t.call(a.id, 'notification.list')).length - before <= 1);

  await t.call(adminId, 'post.create', post('점검 안내', '내일', '공지글'));
  assert.ok((await t.call(a.id, 'notification.list')).some((n: { type: string }) => n.type === 'notice'));

  await t.call(a.id, 'notification.markAllRead');
  assert.ok((await t.call(a.id, 'notification.list')).every((n: { read: boolean }) => n.read));
  await t.call(a.id, 'notification.clear');
  assert.equal((await t.call(a.id, 'notification.list')).length, 0);
  assert.ok((await t.call(b.id, 'notification.list')).length > 0); // 남의 알림은 그대로
});

test('오늘의 쉼표: 나만 볼 수 있고, 비우면 지워진다', async () => {
  const t = setup();
  const a = await t.register('a@a.com', '에이');
  const b = await t.register('b@b.com', '비');
  assert.equal(await t.call(a.id, 'note.today', '2026-11-06'), '');
  await t.call(a.id, 'note.save', '오늘도 수고했어', '2026-11-06');
  assert.equal(await t.call(a.id, 'note.today', '2026-11-06'), '오늘도 수고했어');
  assert.equal(await t.call(b.id, 'note.today', '2026-11-06'), '');
  assert.equal(await t.call(a.id, 'note.today', '2026-11-07'), '');
  await rejects(t.call(a.id, 'note.save', '가'.repeat(301), '2026-11-06'), '300자');
  await rejects(t.call(a.id, 'note.today', 'not-a-date'), '날짜');
  await t.call(a.id, 'note.save', '', '2026-11-06');
  assert.equal(await t.call(a.id, 'note.today', '2026-11-06'), '');
});

test('신고 처리 · 경고 · 게시 중단 · 도움 안내', async () => {
  const t = setup();
  const adminId = await t.seed();
  const a = await t.register('a@a.com', '에이');
  const b = await t.register('b@b.com', '비');
  const p = await t.call(a.id, 'post.create', post('신고될 글', '유서를 쓰고 싶다'));
  const c = await t.call(a.id, 'comment.add', p.id, '댓글') ?? null;
  assert.equal(c, null);
  const comment = (await t.call(b.id, 'comment.list', p.id))[0];

  await rejects(t.call(b.id, 'report.create', { targetType: 'post', targetId: p.id, reason: '이상한 사유' }), '사유');
  await t.call(b.id, 'report.create', { targetType: 'post', targetId: p.id, reason: '기타', targetPreview: '조작된 미리보기' });
  await t.call(b.id, 'report.create', { targetType: 'comment', targetId: comment.id, reason: '욕설·악성 표현' });
  await rejects(t.call(b.id, 'admin.reports'), '운영자');
  const reports = await t.call(adminId, 'admin.reports');
  assert.equal(reports.length, 2);
  assert.ok(reports.some((r: { targetPreview: string }) => r.targetPreview === '신고될 글')); // 미리보기는 서버가 정함

  const postReport = reports.find((r: { targetType: string }) => r.targetType === 'post');
  const commentReport = reports.find((r: { targetType: string }) => r.targetType === 'comment');
  await t.call(adminId, 'admin.resolveReport', commentReport.id, '경고 및 게시 중단');
  assert.equal((await t.call(b.id, 'comment.list', p.id)).length, 0);
  await t.call(adminId, 'admin.resolveReport', commentReport.id, '문제 없음');
  assert.equal((await t.call(b.id, 'comment.list', p.id)).length, 1);
  const before = (await t.call(a.id, 'auth.me')).leaves;
  await t.call(adminId, 'admin.resolveReport', postReport.id, '이용 제한', 90, true);
  assert.equal((await t.call(b.id, 'post.list', '전체', 'latest')).length, 0);
  assert.equal((await t.call(a.id, 'auth.me')).leaves, before - 3);
  await t.call(adminId, 'admin.resolveReport', postReport.id, '이용 제한', 90, true);
  assert.equal((await t.call(a.id, 'auth.me')).leaves, before - 3);
  await t.call(adminId, 'admin.resolveReport', postReport.id, '문제 없음');
  assert.equal((await t.call(a.id, 'auth.me')).leaves, before);
  assert.equal((await t.call(b.id, 'post.list', '전체', 'latest')).length, 1);
  assert.equal((await t.call(adminId, 'admin.reportHistory', postReport.id)).length, 2);
  assert.ok((await t.call(a.id, 'notification.list')).some((n: { type: string }) => n.type === 'restricted'));

  const alert = (await t.call(adminId, 'admin.alerts'))[0];
  await t.call(adminId, 'admin.sendCareNotice', alert.id);
  await rejects(t.call(adminId, 'admin.sendCareNotice', alert.id), '이미');
  assert.ok((await t.call(a.id, 'notification.list')).some((n: { type: string }) => n.type === 'care'));
});

test('이용 제한: 기간 동안 글쓰기·댓글·공감·구독·신고가 막히고, 읽기·알림은 가능하며, 기간이 지나면 풀린다', async () => {
  const t = setup();
  const adminId = await t.seed();
  const a = await t.register('a@a.com', '에이');
  const b = await t.register('b@b.com', '비');
  const p = await t.call(a.id, 'post.create', post('신고될 글'));
  await t.call(b.id, 'report.create', { targetType: 'post', targetId: p.id, reason: '욕설·악성 표현' });
  const report = (await t.call(adminId, 'admin.reports'))[0];

  await rejects(t.call(adminId, 'admin.resolveReport', report.id, '이용 제한'), '기간');
  await rejects(t.call(adminId, 'admin.resolveReport', report.id, '이용 제한', 5), '기간');
  assert.equal((await t.call(adminId, 'admin.reports'))[0].status, 'pending'); // 실패하면 아무것도 바뀌지 않음
  await rejects(t.call(b.id, 'admin.resolveReport', report.id, '이용 제한', 7), '운영자');

  await t.call(adminId, 'admin.resolveReport', report.id, '이용 제한', 7);
  const me = await t.call(a.id, 'auth.me');
  assert.ok(me.restrictedUntil);
  assert.equal(me.restrictionReason, '욕설·악성 표현');
  const note = (await t.call(a.id, 'notification.list')).find((n: { type: string }) => n.type === 'restricted');
  assert.ok(note.text.includes('7일'));

  await rejects(t.call(a.id, 'post.create', post('새 글')), '이용이 제한');
  await rejects(t.call(a.id, 'comment.add', p.id, '댓글'), '이용이 제한');
  await rejects(t.call(a.id, 'post.toggleLike', p.id), '이용이 제한');
  await rejects(t.call(a.id, 'social.subscribe', b.id), '이용이 제한');
  await rejects(t.call(a.id, 'report.create', { targetType: 'post', targetId: p.id, reason: '기타' }), '이용이 제한');
  assert.equal((await t.call(a.id, 'post.list', '전체', 'latest')).length, 1); // 읽기는 가능
  await t.call(a.id, 'note.save', '나만의 쉼표', '2026-11-06'); // 나만 보는 쉼표도 가능
  await t.call(a.id, 'notification.markAllRead');
  await t.call(a.id, 'post.setPrivate', p.id, true); // 내 글 관리도 가능

  t.tick(8 * 86400000); // 8일 뒤
  assert.equal((await t.call(a.id, 'auth.me')).restrictedUntil, undefined);
  await t.call(a.id, 'post.create', post('제한이 풀린 뒤의 글'));
});

test('이용 제한: 영구 제한 · 해제 · 운영자는 제한할 수 없다', async () => {
  const t = setup();
  const adminId = await t.seed();
  const a = await t.register('a@a.com', '에이');
  const b = await t.register('b@b.com', '비');
  const p = await t.call(a.id, 'post.create', post('글'));
  await t.call(b.id, 'report.create', { targetType: 'post', targetId: p.id, reason: '스팸·광고' });
  const report = (await t.call(adminId, 'admin.reports'))[0];

  await t.call(adminId, 'admin.resolveReport', report.id, '이용 제한', 0);
  t.tick(3650 * 86400000); // 10년 뒤에도 제한
  await rejects(t.call(a.id, 'post.create', post('또 글')), '계속');
  assert.ok((await t.call(a.id, 'auth.me')).restrictedUntil);

  await rejects(t.call(b.id, 'admin.liftRestriction', report.id), '운영자');
  await t.call(adminId, 'admin.liftRestriction', report.id);
  assert.equal((await t.call(a.id, 'auth.me')).restrictedUntil, undefined);
  await t.call(a.id, 'post.create', post('해제 후'));
  assert.ok((await t.call(a.id, 'notification.list')).some((n: { text: string }) => n.text.includes('해제')));

  // 운영자가 쓴 글은 신고돼도 이용 제한할 수 없음
  const adminPost = await t.call(adminId, 'post.create', post('운영자 글'));
  await t.call(b.id, 'report.create', { targetType: 'post', targetId: adminPost.id, reason: '기타' });
  const second = (await t.call(adminId, 'admin.reports')).find((r: { targetId: string }) => r.targetId === adminPost.id);
  await rejects(t.call(adminId, 'admin.resolveReport', second.id, '이용 제한', 1), '운영자 계정');
});
