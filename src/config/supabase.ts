import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Db = SupabaseClient;

// 서버용 Secret key로 만든 SDK 객체. 이 키는 서버에만 있어야 해요.
export function createDb(source: NodeJS.ProcessEnv = process.env): Db {
  const url = source.SUPABASE_URL?.trim();
  const key = source.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key || url.includes('your-project-ref') || key.includes('replace_with')) {
    throw new Error('SUPABASE_URL과 SUPABASE_SECRET_KEY를 서버 .env 또는 Render 환경변수에 설정하세요.');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
