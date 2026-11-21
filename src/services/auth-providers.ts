import { HttpError } from '../lib/errors';

async function read() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) throw new Error('Missing Supabase configuration');
  const responses = await Promise.all(['/auth/v1/settings', '/auth/v1/admin/custom-providers'].map((path) =>
    fetch(`${url}${path}`, { headers: { apikey: key }, redirect: 'error', signal: AbortSignal.timeout(5000) }),
  ));
  if (responses.some((r) => !r.ok)) throw new Error('Auth settings unavailable');
  const settings = await responses[0].json() as { external?: { email?: boolean } };
  const custom = await responses[1].json() as { providers?: {
    identifier: string; enabled: boolean; provider_type: string; issuer: string;
    pkce_enabled: boolean; email_optional: boolean; scopes?: string[];
  }[] };
  if (typeof settings.external?.email !== 'boolean' || !Array.isArray(custom.providers)) throw new Error('Invalid Auth settings');
  const naver = custom.providers.find((p) => p.identifier === 'custom:naver');
  return {
    email: { provider: 'email', enabled: settings.external.email },
    naver: { provider: 'custom:naver', enabled: naver?.enabled === true && naver.provider_type === 'oidc'
      && naver.issuer === 'https://nid.naver.com' && naver.pkce_enabled === true
      && naver.email_optional === true && naver.scopes?.includes('openid') === true },
  };
}

export function createAuthProvidersReader() {
  let cache: { value: Awaited<ReturnType<typeof read>>; until: number } | undefined;
  let pending: ReturnType<typeof read> | undefined;
  return async () => {
    if (cache && Date.now() < cache.until) return cache.value;
    pending ??= read().then((value) => {
      cache = { value, until: Date.now() + 60_000 };
      return value;
    }).catch(() => { throw new HttpError(503, '로그인 서비스 상태를 확인하지 못했어요.'); })
      .finally(() => { pending = undefined; });
    return pending;
  };
}
