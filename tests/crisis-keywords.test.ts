import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countCrisisKeywords } from '../src/lib/crisis';

test('위기 표현은 공백·대소문자·제로폭 문자를 정규화해 감지한다', () => {
  assert.equal(countCrisisKeywords('그냥 죽고싶어'), 1);
  assert.equal(countCrisisKeywords('살고 싶지 않아. I WANT TO DIE.'), 2);
  assert.equal(countCrisisKeywords('자\u200B해 생각이 들어'), 1);
  assert.equal(countCrisisKeywords('오늘은 조금 슬펐지만 친구와 산책했다.'), 0);
});
