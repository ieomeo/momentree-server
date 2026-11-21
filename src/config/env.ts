export interface Env {
  authSecret: string;
  superAdminEmail: string;
  superAdminPassword: string;
  superAdminNickname: string;
  corsOrigins: string[];
  allowDemoCode: boolean;
  brevoApiKey?: string;
  mailSenderEmail?: string;
  mailSenderName: string;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const authSecret = source.AUTH_SECRET?.trim() ?? '';
  if (authSecret.length < 32 || authSecret.includes('replace_with')) {
    throw new Error('AUTH_SECRET을 32자 이상의 임의 문자열로 설정하세요.');
  }
  const superAdminPassword = source.SUPER_ADMIN_PASSWORD?.trim() ?? '';
  if (superAdminPassword.length < 6 || superAdminPassword.includes('replace_with')) {
    throw new Error('SUPER_ADMIN_PASSWORD를 6자 이상으로 설정하세요.');
  }
  return {
    authSecret,
    superAdminEmail: (source.SUPER_ADMIN_EMAIL?.trim() || 'khs9523007@ajou.ac.kr').toLowerCase(),
    superAdminPassword,
    superAdminNickname: source.SUPER_ADMIN_NICKNAME?.trim() || '세계수',
    corsOrigins: (source.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    allowDemoCode: source.ALLOW_DEMO_CODE === 'true',
    brevoApiKey: source.BREVO_API_KEY?.trim() || undefined,
    mailSenderEmail: source.MAIL_SENDER_EMAIL?.trim() || undefined,
    mailSenderName: source.MAIL_SENDER_NAME?.trim() || '모먼트리',
  };
}
