import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rejects, setup } from './helpers/setup';

test('글 수정은 작성자만 가능하고, 비공개 상태와 기존 활동을 유지한다', async () => {
  const t = setup();
  const owner = await t.register('owner@example.com', '작성자');
  const other = await t.register('other@example.com', '다른회원', '김하늘', '01099887766');
  const initial = { category: '일기', title: '처음 제목', content: '처음 내용' };
  const post = await t.call(owner.id, 'post.create', initial);
  await t.call(other.id, 'post.toggleLike', post.id);
  await t.call(other.id, 'comment.add', post.id, '응원해요');
  await t.call(owner.id, 'post.setPrivate', post.id, true);
  await rejects(t.call(other.id, 'post.update', post.id, initial), '자신이 쓴 글만');
  await rejects(t.call(owner.id, 'post.update', post.id, { ...initial, title: ' ' }), '제목');
  const result = await t.call(owner.id, 'post.update', post.id, { category: '단상', title: '새 제목', content: '새 내용' });
  assert.equal(result.id, post.id);
  assert.equal(result.title, '새 제목');
  assert.equal(result.category, '단상');
  assert.equal(result.content, '새 내용');
  assert.equal(result.createdAt, post.createdAt);
  assert.equal(result.isPrivate, true);
  assert.deepEqual(result.likedBy, [other.id]);
  assert.equal(result.commentCount, 1);
});
