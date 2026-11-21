import assert from 'node:assert/strict';
import { test } from 'node:test';
import { purgeExpired } from '../src/services/seed';
import { rejects, setup } from './helpers/setup';

const risky = { category: '일기', title: '힘든 날', content: '유서를 쓰고 싶다' };

test('개인정보 열람 권한: 일반 사용자 · 일반 운영자 · 총괄 운영자', async () => {
  const t = setup();
  const superId = await t.seed();
  const a = await t.register('a@a.com', '에이', '홍길동', '010-1234-5678');
  const b = await t.register('b@b.com', '비', '김비', '01099998888');
  await t.call(superId, 'admin.createAdmin', { email: 'op@op.com', password: '123456', nickname: '운영2' });
  const op = (await t.call(superId, 'admin.listAdmins'))[0];

  // 일반 사용자
  for (const [name, arg] of [['admin.listMembers'], ['admin.viewIdentity', b.id], ['admin.identityLogs'], ['admin.identityForAlert', 'x']] as const) {
    await rejects(t.call(a.id, name, arg));
  }
  // 일반 운영자: 회원 목록·임의 열람 불가
  await rejects(t.call(op.id, 'admin.listMembers'), '총괄');
  await rejects(t.call(op.id, 'admin.viewIdentity', b.id), '총괄');
  await rejects(t.call(op.id, 'admin.identityLogs'), '총괄');
  await rejects(t.call(op.id, 'admin.identityForAlert', 'no-such-alert'), '찾을 수 없어요');

  // 위기 알림이 있을 때만 일반 운영자가 작성자 정보를 볼 수 있음
  await t.call(a.id, 'post.create', risky);
  const alert = (await t.call(op.id, 'admin.alerts'))[0];
  const view = await t.call(op.id, 'admin.identityForAlert', alert.id);
  assert.equal(view.nickname, '에이');
  assert.deepEqual(view.identity, { name: '홍길동', birthDate: '2000-05-17', phone: '010-1234-5678' });
  assert.equal(view.email, 'a@a.com');
  // 위기 알림 글이 비공개여도 운영자는 검토할 수 있음 (위기 알림이 달린 글에 한해)
  const posts = await t.call(a.id, 'post.mine');
  await t.call(a.id, 'post.setPrivate', posts[0].id, true);
  assert.equal((await t.call(op.id, 'post.get', posts[0].id)).id, posts[0].id);

  await t.call(op.id, 'admin.setAlertStatus', alert.id, 'done');
  await rejects(t.call(op.id, 'admin.identityForAlert', alert.id), '처리가 끝난');

  // 총괄 운영자: 모든 계정
  const members = await t.call(superId, 'admin.listMembers');
  assert.equal(members.length, 4);
  assert.ok(!JSON.stringify(members).includes('홍길동')); // 목록에는 개인정보가 없음
  const viewB = await t.call(superId, 'admin.viewIdentity', b.id);
  assert.equal(viewB.identity.phone, '010-9999-8888');
  const logs = await t.call(superId, 'admin.identityLogs');
  assert.ok(logs.some((l: { reason: string; adminNickname: string }) => l.reason === 'crisis-alert' && l.adminNickname === '운영2'));
  assert.ok(logs.some((l: { reason: string; targetNickname: string }) => l.reason === 'super-admin' && l.targetNickname === '비'));
});

test('개인정보는 어떤 화면용 응답에도 섞이지 않는다', async () => {
  const t = setup();
  const superId = await t.seed();
  const a = await t.register('a@a.com', '에이', '홍길동', '010-1234-5678');
  const p = await t.call(a.id, 'post.create', { category: '시', title: '제목', content: '내용' });
  const everything = JSON.stringify([
    await t.call(a.id, 'auth.me'), await t.call(a.id, 'post.list', '전체', 'latest'), await t.call(a.id, 'post.get', p.id),
    await t.call(superId, 'auth.me'), await t.call(superId, 'post.list', '전체', 'latest'),
    await t.call(a.id, 'notification.list'), await t.call(superId, 'admin.reports'), await t.call(superId, 'admin.alerts'),
  ]);
  for (const secret of ['홍길동', '1234-5678', '2000-05-17', 'password', 'scrypt']) {
    assert.ok(!everything.includes(secret), `${secret}가 응답에 섞여 있어요`);
  }
});

test('운영자 계정 관리: 추가 · 삭제 시 이메일 접근 차단 · 총괄 운영자만', async () => {
  const t = setup();
  const superId = await t.seed();
  const a = await t.register('a@a.com', '에이');
  await rejects(t.call(a.id, 'admin.createAdmin', { email: 'x@x.com', password: '123456', nickname: '엑스' }), '운영자');
  await t.call(superId, 'admin.createAdmin', { email: 'op@op.com', password: '123456', nickname: '운영2' });
  await rejects(t.call(superId, 'admin.createAdmin', { email: 'op2@op.com', password: '123456', nickname: '운영2' }), '닉네임');
  await rejects(t.call(superId, 'admin.createAdmin', { email: 'op@op.com', password: '123456', nickname: '운영3' }), '이미');

  const op = (await t.call(superId, 'admin.listAdmins'))[0];
  await t.call(op.id, 'post.create', { category: '공지글', title: '공지', content: '내용' });
  await t.call(op.id, 'post.setPinned', (await t.call(op.id, 'post.mine'))[0].id, true);
  await rejects(t.call(op.id, 'admin.removeAdmin', superId), '총괄'); // 일반 운영자는 삭제 권한 없음
  await rejects(t.call(superId, 'admin.removeAdmin', superId), '총괄 운영자 계정은');

  await t.call(superId, 'admin.removeAdmin', op.id);
  await rejects(t.call(null, 'auth.login', 'op@op.com', '123456'), '제한');
  await rejects(t.call(null, 'auth.requestEmailCode', 'op@op.com'), '사용할 수 없는');
  const left = await t.call(a.id, 'post.list', '전체', 'latest');
  assert.equal(left[0].nickname, '탈퇴한 사용자'); // 글은 남지만 작성자는 표시되지 않음
  assert.equal(left[0].pinned, false);
  assert.equal((await t.call(superId, 'admin.blockedEmails'))[0].email, 'op@op.com');
  await t.call(superId, 'admin.unblockEmail', 'op@op.com');
  assert.equal((await t.call(superId, 'admin.blockedEmails')).length, 0);
});

test('기간이 지난 임시 데이터와 1년 지난 열람 기록은 정리된다', async () => {
  const t = setup();
  const superId = await t.seed();
  const a = await t.register('a@a.com', '에이');
  await t.call(a.id, 'auth.withdraw', '123456'); // 30일 재가입 제한 기록이 생김
  const b = await t.register('b@b.com', '비');
  await t.call(superId, 'admin.viewIdentity', b.id); // 열람 기록이 생김
  await t.call(null, 'auth.requestEmailCode', 'c@c.com'); // 인증번호가 생김
  assert.equal(t.db.tables.withdrawn_emails.length, 1);

  await purgeExpired(t.ctxFor(null));
  assert.equal(t.db.tables.withdrawn_emails.length, 1); // 아직 기간 안

  t.tick(31 * 86400000);
  await purgeExpired(t.ctxFor(null));
  assert.equal(t.db.tables.withdrawn_emails.length, 0);
  assert.equal(t.db.tables.email_codes.length, 0);
  assert.equal(t.db.tables.identity_logs.length, 1); // 열람 기록은 1년 보관

  t.tick(366 * 86400000);
  await purgeExpired(t.ctxFor(null));
  assert.equal(t.db.tables.identity_logs.length, 0);
});

test('1년이 지난 처리 완료 신고·위기 알림만 정리된다', async () => {
  const t = setup();
  const superId = await t.seed();
  const a = await t.register('a@a.com', '에이');
  const p = await t.call(a.id, 'post.create', { category: '일기', title: '글', content: '유서' });
  await t.call(a.id, 'report.create', { targetType: 'post', targetId: p.id, reason: '기타' });
  const report = (await t.call(superId, 'admin.reports'))[0];
  const alert = (await t.call(superId, 'admin.alerts'))[0];
  await t.call(superId, 'admin.resolveReport', report.id, '문제 없음');
  t.tick(366 * 86400000);
  await purgeExpired(t.ctxFor(null));
  assert.equal(t.db.tables.reports.length, 0); // 처리 완료 + 1년 경과
  assert.equal(t.db.tables.crisis_alerts.length, 1); // 아직 처리 중인 위기 알림은 남음
  assert.ok(alert.id);
});
