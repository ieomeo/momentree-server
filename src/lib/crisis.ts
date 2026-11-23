// 글의 제목·본문에서 검토가 필요한 표현을 찾습니다. 진단이나 자동 제재의 근거가 아닙니다.
export const CRISIS_GROUPS = {
  직접언급: ['자살', '자해', '유서', 'suicide', 'suicidal', 'self-harm', 'self harm'],
  죽음소망: ['죽고 싶', '죽어 버리고 싶', '죽어버리고 싶', '죽었으면 좋겠', '죽으면 편하겠',
    '그냥 죽고 싶', '죽는 게 낫', '죽는게 낫', '차라리 죽', '내가 죽었으면',
    '살고 싶지 않', '살기 싫어', '살기 싫다', '살기 싫습니다', '살고 싶은 마음이 없',
    '살아 있고 싶지 않', '살아있고 싶지 않', '살아 있기 싫', '살아있기 싫', '살 의지가 없',
    'i want to die', 'i wish i were dead', 'i wish i was dead', 'i don’t want to live', "i don't want to live", 'i want to end my life'],
  종료소망: ['내 삶을 끝내고 싶', '삶을 끝내고 싶', '인생을 끝내고 싶', '생을 끝내고 싶',
    '내 인생을 끝낼', '목숨을 끊', '생을 마감하고 싶', '생을 마감할', '극단적 선택을 하고 싶',
    '극단적인 선택을 하고 싶', '극단적 선택을 하려', '극단적인 선택을 하려', '죽기로 결심', '죽을 결심',
    '죽을 생각이', '죽을 생각을', '내 삶을 끝낼 생각'],
  간접신호: ['영원히 사라지고 싶', '세상에서 사라지고 싶', '이 세상에서 없어지고 싶', '이 세상에 있고 싶지 않',
    '다시는 눈뜨고 싶지 않', '다시는 깨고 싶지 않', '잠들어서 깨지 않았으면', '잠들고 다시 안 깼으면',
    '내가 없어지는 게 낫', '내가 없어지는게 낫', '내가 죽는 게 낫', '나 없이 사는 게 낫'],
  자기손상: ['나를 해치고 싶', '스스로를 해치고 싶', '나 자신을 해치고 싶', '내 몸을 해치고 싶',
    '스스로에게 상처를 내고 싶', '나 자신에게 상처를 내고 싶', '자기 몸에 상처를 내고 싶',
    'i want to hurt myself', 'i want to harm myself'],
} as const;

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s\u200B-\u200D\uFEFF]+/gu, '');
const terms = [...new Set(Object.values(CRISIS_GROUPS).flat().map(normalize))].sort((a, b) => b.length - a.length);
const signals = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu');

export function countCrisisKeywords(text: string): number {
  // 긴 표현부터 찾아 겹치는 짧은 표현을 중복 집계하지 않아요.
  return [...normalize(text).matchAll(signals)].length;
}
