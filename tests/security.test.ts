import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashCode, hashPassword, randomCode, signToken, verifyPassword, verifyToken } from '../src/lib/security';
import { countCrisisKeywords } from '../src/lib/crisis';

const secret = 's'.repeat(40);

test('비밀번호는 해시로 저장되고 원문과 다르다', async () => {
  const hash = await hashPassword('123456');
  assert.ok(!hash.includes('123456'));
  assert.equal(await verifyPassword('123456', hash), true);
  assert.equal(await verifyPassword('654321', hash), false);
  assert.notEqual(hash, await hashPassword('123456')); // salt가 달라 매번 다름
});

test('토큰: 정상 / 변조 / 만료 / 다른 비밀키', () => {
  const now = Date.now();
  const token = signToken('user-1', secret, now);
  assert.equal(verifyToken(token, secret, now), 'user-1');
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 'admin', exp: now + 1e9 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${sig}`, secret, now), null);
  assert.equal(verifyToken(`${body}.abc`, secret, now), null);
  assert.equal(verifyToken(token, secret, now + 8 * 24 * 3600 * 1000), null);
  assert.equal(verifyToken(token, 'o'.repeat(40), now), null);
  assert.equal(verifyToken('garbage', secret, now), null);
});

test('인증번호는 6자리 숫자이고 해시는 이메일에 묶인다', () => {
  assert.match(randomCode(), /^\d{6}$/);
  assert.notEqual(hashCode('a@a.com', '123456', secret), hashCode('b@b.com', '123456', secret));
});

test('위기 키워드를 센다', () => {
  assert.equal(countCrisisKeywords('유서를 쓰고 자해했다'), 2);
  assert.equal(countCrisisKeywords('평범한 하루'), 0);
});
