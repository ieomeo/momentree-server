import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL, SUPER, rejects, setup } from './helpers/setup';

test('총괄 운영자: 서버 시작 시 만들어지고, 잘못된 값은 항상 설정값으로 맞춘다', async () => {
  const t = setup();
  const adminId = await t.seed();
  const row = t.db.tables.users[0];
  assert.equal(row.role, 'admin');
  assert.equal(row.nickname, '세계수');
  assert.ok(!JSON.stringify(row).includes(SUPER.password)); // 비밀번호 원문 저장 안 함
  const login = await t.call(null, 'auth.login', SUPER.email, SUPER.password);
  assert.equal(login.user.isSuperAdmin, true);

  // 누군가 값을 바꿔 놓아도 다음 시작 때 복구
  row.nickname = '엉뚱'; row.nickname_key = '엉뚱'; row.role = 'user';
  await t.seed();
  assert.equal(row.nickname, '세계수');
  assert.equal(row.role, 'admin');
  assert.equal(t.db.tables.users.length, 1);
  assert.ok(adminId);
});

test('총괄 운영자 닉네임을 쓰던 다른 계정은 이름이 바뀐다', async () => {
  const t = setup();
  const u = await t.register('a@a.com', '세계수');
  await t.seed();
  const names = (t.db.tables.users as { nickname: string }[]).map((x) => x.nickname);
  assert.ok(names.includes('세계수'));
  assert.ok(names.some((n) => n.startsWith('세계수_')));
  assert.ok(u.id);
});

test('이메일 인증: 번호는 응답에 담기지 않고 해시로만 저장된다', async () => {
  const t = setup();
  const res = await t.call(null, 'auth.requestEmailCode', 'a@a.com');
  assert.deepEqual(res, { delivered: true });
  const code = t.sent[0].code;
  assert.ok(!JSON.stringify(t.db.tables.email_codes).includes(code));
  await rejects(t.call(null, 'auth.signup', { consents: ALL, email: 'a@a.com', password: '123456', nickname: '에이', identity: { name: '홍길동', birthDate: '2000-05-17', phone: '01012345678' } }), '이메일 인증');
});

test('인증번호: 재전송 대기 / 틀림 횟수 / 만료', async () => {
  const t = setup();
  await t.call(null, 'auth.requestEmailCode', 'a@a.com');
  await rejects(t.call(null, 'auth.requestEmailCode', 'a@a.com'), '초 뒤에');
  t.tick(31000);
  await t.call(null, 'auth.requestEmailCode', 'a@a.com');
  const code = t.sent[1].code;
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await rejects(t.call(null, 'auth.verifyEmailCode', 'a@a.com', wrong));
  await rejects(t.call(null, 'auth.verifyEmailCode', 'a@a.com', code), '횟수'); // 5번 틀리면 맞는 번호도 거부

  t.tick(31000);
  await t.call(null, 'auth.requestEmailCode', 'a@a.com');
  t.tick(6 * 60000);
  await rejects(t.call(null, 'auth.verifyEmailCode', 'a@a.com', t.sent[2].code), '만료');
});

test('개발용 인증번호: 메일 서비스가 없고 허용했을 때만 응답에 담긴다', async () => {
  const dev = setup({ allowDemoCode: true }, 'off');
  const res = await dev.call(null, 'auth.requestEmailCode', 'a@a.com');
  assert.equal(res.delivered, false);
  assert.match(res.demoCode, /^\d{6}$/);

  const prod = setup({ allowDemoCode: false }, 'off');
  await rejects(prod.call(null, 'auth.requestEmailCode', 'a@a.com'), '메일 서비스');
  assert.equal(prod.db.tables.email_codes.length, 0);

  const failing = setup({}, 'fail');
  await rejects(failing.call(null, 'auth.requestEmailCode', 'a@a.com'), '보내지 못했어요');
  assert.equal(failing.db.tables.email_codes.length, 0);
});

test('가입: 인증한 이메일만, 중복 닉네임·이메일 거부, 개인정보 검증', async () => {
  const t = setup();
  await t.call(null, 'auth.requestEmailCode', 'a@a.com');
  await t.call(null, 'auth.verifyEmailCode', 'a@a.com', t.sent[0].code);
  const base = { email: 'a@a.com', password: '123456', nickname: '에이' };
  const id = { name: '홍길동', birthDate: '2000-05-17', phone: '01012345678' };
  await rejects(t.call(null, 'auth.signup', { consents: ALL, ...base, email: 'other@a.com', identity: id }), '인증');
  await rejects(t.call(null, 'auth.signup', { consents: ALL, ...base, identity: { ...id, name: '1' } }), '실명');
  await rejects(t.call(null, 'auth.signup', { consents: ALL, ...base, identity: { ...id, birthDate: '2000-02-30' } }), '생년월일');
  await rejects(t.call(null, 'auth.signup', { consents: ALL, ...base, identity: { ...id, birthDate: '2999-01-01' } }), '생년월일');
  await rejects(t.call(null, 'auth.signup', { consents: ALL, ...base, identity: { ...id, phone: '12345' } }), '연락처');
  await rejects(t.call(null, 'auth.signup', { consents: ALL, ...base, password: '123', identity: id }), '6자');
  assert.equal(t.db.tables.users?.length ?? 0, 0); // 실패한 가입은 흔적을 남기지 않음
  const ok = await t.call(null, 'auth.signup', { consents: ALL, ...base, identity: id });
  assert.equal(ok.user.nickname, '에이');
  assert.equal(t.db.tables.identities[0].phone, '010-1234-5678');
  assert.ok(!JSON.stringify(ok.user).includes('홍길동'));
  assert.ok(!JSON.stringify(ok.user).includes('password'));

  await rejects(t.call(null, 'auth.requestEmailCode', 'A@a.com'), '이미 가입'); // 대소문자 무시
  await t.call(null, 'auth.requestEmailCode', 'b@b.com');
  await t.call(null, 'auth.verifyEmailCode', 'b@b.com', t.sent[1].code);
  await rejects(t.call(null, 'auth.signup', { consents: ALL, email: 'b@b.com', password: '123456', nickname: ' 에 이 ', identity: id }), '닉네임');
  await rejects(t.call(null, 'auth.signup', { consents: ALL, email: 'b@b.com', password: '123456', nickname: '탈퇴한 사용자', identity: id }), '사용할 수 없는');
});

test('로그인 · 내 정보 · 로그인 필요', async () => {
  const t = setup();
  const u = await t.register('a@a.com', '에이');
  await rejects(t.call(null, 'auth.login', 'a@a.com', 'wrong-pass'), '확인');
  const res = await t.call(null, 'auth.login', 'A@a.com', '123456');
  assert.ok(res.token);
  assert.equal((await t.call(u.id, 'auth.me')).email, 'a@a.com');
  assert.equal(await t.call(null, 'auth.me'), null);
  for (const name of ['post.list', 'post.mine', 'notification.list', 'leaf.logs', 'comment.add', 'admin.reports', 'auth.updateAvatar']) {
    await rejects(t.call(null, name, 'x'), '로그인');
  }
});

test('닉네임 변경 · 프로필 사진', async () => {
  const t = setup();
  const a = await t.register('a@a.com', '에이');
  await t.register('b@b.com', '비');
  const post = await t.call(a.id, 'post.create', { category: '시', title: '제목', content: '내용' });
  await rejects(t.call(a.id, 'auth.changeNickname', '비'), '이미');
  await rejects(t.call(a.id, 'auth.changeNickname', '에이'), '같아요');
  const me = await t.call(a.id, 'auth.changeNickname', '새이름');
  assert.equal(me.nickname, '새이름');
  assert.equal((await t.call(a.id, 'post.get', post.id)).nickname, '새이름');

  await rejects(t.call(a.id, 'auth.updateAvatar', 'http://evil.com/x.png'), '사진');
  await t.call(a.id, 'auth.updateAvatar', 'data:image/jpeg;base64,AAAA');
  assert.equal((await t.call(a.id, 'auth.me')).avatar, 'data:image/jpeg;base64,AAAA');
  await t.call(a.id, 'auth.updateAvatar', null);
  assert.equal((await t.call(a.id, 'auth.me')).avatar, undefined);

  const adminId = await t.seed();
  await rejects(t.call(adminId, 'auth.changeNickname', '다른이름'), '고정');
});

test('탈퇴: 30일 재가입 제한 · 글은 "탈퇴한 사용자" · 개인정보 삭제', async () => {
  const t = setup();
  const a = await t.register('a@a.com', '에이');
  const b = await t.register('b@b.com', '비');
  const post = await t.call(a.id, 'post.create', { category: '시', title: '남는 글', content: '내용' });
  await t.call(b.id, 'comment.add', post.id, '댓글');
  await rejects(t.call(a.id, 'auth.withdraw', 'wrong'), '비밀번호');
  await t.call(a.id, 'auth.withdraw', '123456');

  assert.equal(t.db.tables.users.some((u: Record<string, unknown>) => u.email === 'a@a.com'), false);
  assert.equal(t.db.tables.identities.length, 1); // 탈퇴한 사람의 개인정보는 함께 삭제
  const view = await t.call(b.id, 'post.get', post.id);
  assert.equal(view.nickname, '탈퇴한 사용자');
  await rejects(t.call(null, 'auth.requestEmailCode', 'a@a.com'), '30일');
  t.tick(31 * 86400000);
  await t.call(null, 'auth.requestEmailCode', 'a@a.com'); // 30일이 지나면 다시 가능
  const sub = await t.call(b.id, 'auth.me');
  assert.ok(sub);
});

test('가입: 세 가지 동의가 모두 없으면 서버가 거부하고, 동의 일시가 기록된다', async () => {
  const t = setup();
  await t.call(null, 'auth.requestEmailCode', 'a@a.com');
  await t.call(null, 'auth.verifyEmailCode', 'a@a.com', t.sent[0].code);
  const input = { email: 'a@a.com', password: '123456', nickname: '에이', identity: { name: '홍길동', birthDate: '2000-05-17', phone: '01012345678' } };
  await rejects(t.call(null, 'auth.signup', input), '동의');
  await rejects(t.call(null, 'auth.signup', { ...input, consents: { terms: true, consent: true } }), '동의');
  await rejects(t.call(null, 'auth.signup', { ...input, consents: { terms: true, consent: true, privacy: 'yes' } }), '동의');
  assert.equal(t.db.tables.users?.length ?? 0, 0);
  await t.call(null, 'auth.signup', { ...input, consents: ALL });
  assert.ok(t.db.tables.identities[0].consented_at);
  assert.ok(t.db.tables.identities[0].consent_version);
});

test('가입: 만 14세 미만은 거부, 만 14세가 되는 날부터 가능', async () => {
  const t = setup(); // 시계: 2026-11-06
  await t.call(null, 'auth.requestEmailCode', 'kid@a.com');
  await t.call(null, 'auth.verifyEmailCode', 'kid@a.com', t.sent[0].code);
  const base = { email: 'kid@a.com', password: '123456', nickname: '아이', consents: ALL };
  const phone = '01012345678';
  await rejects(t.call(null, 'auth.signup', { ...base, identity: { name: '아이', birthDate: '2012-11-07', phone } }), '14세 미만');
  await rejects(t.call(null, 'auth.signup', { ...base, identity: { name: '아이', birthDate: '2020-01-01', phone } }), '14세 미만');
  assert.equal(t.db.tables.users?.length ?? 0, 0);
  const ok = await t.call(null, 'auth.signup', { ...base, identity: { name: '아이', birthDate: '2012-11-06', phone } });
  assert.ok(ok.user.id);
});
