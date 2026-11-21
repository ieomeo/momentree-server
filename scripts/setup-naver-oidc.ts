import 'dotenv/config';
import { createDb } from '../src/config/supabase';

async function main() {
  const id = process.env.NAVER_CLIENT_ID?.trim();
  const secret = process.env.NAVER_CLIENT_SECRET?.trim();
  if (!id || !secret || /replace_with|your_client/i.test(id + secret)) throw new Error('서버 .env에 실제 NAVER_CLIENT_ID와 NAVER_CLIENT_SECRET을 설정해주세요.');
  const api = createDb().auth.admin.customProviders;
  const list = await api.listProviders();
  if (list.error) throw new Error('Supabase Custom Provider 목록을 읽을 수 없어요.');
  const existing = list.data?.providers.find((p) => p.identifier === 'custom:naver');
  if (existing && (existing.provider_type !== 'oidc' || existing.client_id !== id)) {
    throw new Error('다른 종류 또는 Client ID의 custom:naver가 이미 있어요. 기존 사용자 연결을 먼저 확인해주세요.');
  }
  const params = { name: 'Naver', client_id: id, client_secret: secret, issuer: 'https://nid.naver.com',
    scopes: ['openid'], pkce_enabled: true, email_optional: true, enabled: true };
  const result = existing ? await api.updateProvider('custom:naver', params)
    : await api.createProvider({ ...params, identifier: 'custom:naver', provider_type: 'oidc' });
  if (result.error) throw new Error('custom:naver 설정에 실패했어요. 네이버 자격 증명과 Supabase 설정을 확인해주세요.');
  console.log('custom:naver 설정 완료');
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : '설정 실패'); process.exitCode = 1; });
