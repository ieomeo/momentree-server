import 'dotenv/config';
import createApp from './src/app';
import { loadEnv } from './src/config/env';
import { createDb } from './src/config/supabase';
import { createMailer } from './src/lib/mailer';
import { ensureSuperAdmin, purgeExpired } from './src/services/seed';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb();
  const mailer = createMailer(env);

  // 총괄 운영자 계정을 만들거나 설정값에 맞춰요.
  const ctx = { db, env, mailer, me: null, now: () => new Date() };
  await ensureSuperAdmin(ctx);

  // 기간이 지난 임시 데이터를 시작할 때, 그리고 하루에 한 번 정리해요.
  const cleanup = () => purgeExpired(ctx).catch((e: unknown) => console.error('[cleanup]', e instanceof Error ? e.message : e));
  await cleanup();
  setInterval(cleanup, 24 * 3600 * 1000).unref();

  const port = Number(process.env.PORT) || 3000;
  createApp({ db, env, mailer }).listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Server failed to start');
  process.exit(1);
});
