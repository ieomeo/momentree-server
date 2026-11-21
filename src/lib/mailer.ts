import type { Env } from '../config/env';

export interface MailResult {
  configured: boolean; // 메일 서비스가 연결돼 있는지
  ok: boolean; // 실제로 발송에 성공했는지
}

export interface Mailer {
  sendCode(to: string, code: string, validMinutes: number): Promise<MailResult>;
}

// Brevo(무료 300통/일) 거래 메일 API. 보내는 사람 주소는 Brevo에서 미리 인증해야 해요.
export function createMailer(env: Env): Mailer {
  return {
    async sendCode(to, code, validMinutes) {
      if (!env.brevoApiKey || !env.mailSenderEmail) return { configured: false, ok: false };
      try {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': env.brevoApiKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            sender: { name: env.mailSenderName, email: env.mailSenderEmail },
            to: [{ email: to }],
            subject: '[모먼트리] 이메일 인증번호',
            htmlContent:
              `<div style="font-family:sans-serif"><p>모먼트리 가입을 위한 인증번호예요.</p>` +
              `<p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>` +
              `<p>${validMinutes}분 안에 입력해 주세요. 본인이 요청하지 않았다면 이 메일을 무시해도 돼요.</p></div>`,
          }),
        });
        if (!res.ok) console.error('[Brevo]', res.status, await res.text().catch(() => ''));
        return { configured: true, ok: res.ok };
      } catch (error) {
        console.error('[Brevo]', error instanceof Error ? error.message : 'request failed');
        return { configured: true, ok: false };
      }
    },
  };
}
