import 'dotenv/config';
import { createDb } from '../src/config/supabase';

async function main(): Promise<void> {
  const { error } = await createDb().from('users').select('id').limit(1);
  if (error) throw new Error(`DB 연결 확인 실패: ${error.code ?? ''} ${error.message}`);
  console.log('[Supabase] users 테이블 연결 확인 성공');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'DB 연결 확인 실패');
  process.exitCode = 1;
});
