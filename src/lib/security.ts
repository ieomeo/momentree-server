import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

// ---------- 비밀번호: scrypt + 무작위 salt ----------
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------- 로그인 토큰: HMAC-SHA256으로 서명한 { uid, exp } ----------
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

function b64(data: string | Buffer): string {
  return (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64url');
}

export function signToken(uid: string, secret: string, now = Date.now()): string {
  const body = b64(JSON.stringify({ uid, exp: now + TOKEN_TTL_MS }));
  const sig = b64(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

// 유효하면 사용자 id, 아니면 null
export function verifyToken(token: string, secret: string, now = Date.now()): string | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { uid?: unknown; exp?: unknown };
    if (typeof payload.uid !== 'string' || typeof payload.exp !== 'number' || payload.exp < now) return null;
    return payload.uid;
  } catch {
    return null;
  }
}

// ---------- 이메일 인증번호: 해시로만 저장 ----------
export function hashCode(email: string, code: string, secret: string): string {
  return createHmac('sha256', secret).update(`${email}:${code}`).digest('hex');
}

export function randomCode(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
}
