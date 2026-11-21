// 명확한 위기 키워드만 감지합니다. (서버가 직접 세므로 클라이언트가 조작할 수 없어요)
const CRISIS_KEYWORDS = ['자살', '자해', '유서', '죽고 싶', '죽고싶'];

export function countCrisisKeywords(text: string): number {
  return CRISIS_KEYWORDS.reduce((sum, keyword) => sum + text.split(keyword).length - 1, 0);
}
