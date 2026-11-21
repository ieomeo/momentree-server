import 'dotenv/config';
import { createAuthProvidersReader } from '../src/services/auth-providers';

async function main() {
  const [providers, response] = await Promise.all([
    createAuthProvidersReader()(),
    fetch('https://nid.naver.com/.well-known/openid-configuration', { signal: AbortSignal.timeout(5000) }),
  ]);
  if (!response.ok) throw new Error('네이버 OIDC Discovery 조회 실패');
  const doc = await response.json() as { issuer?: string; code_challenge_methods_supported?: string[] };
  const discovery = doc.issuer === 'https://nid.naver.com' && doc.code_challenge_methods_supported?.includes('S256') === true;
  console.log(JSON.stringify({ providers, naverDiscoveryPkce: discovery }, null, 2));
  if (!providers.email.enabled || !providers.naver.enabled || !discovery) process.exitCode = 1;
}
void main().catch(() => { console.error('인증 설정을 확인하지 못했어요.'); process.exitCode = 1; });
