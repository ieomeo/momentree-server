import { createDb } from '../config/supabase';
import { HttpError } from '../lib/errors';
import { hashCode, hashPassword, randomCode, signToken, verifyPassword, verifyToken } from '../lib/security';
import {
  Ctx, DELETED_NICKNAME, EMAIL_PATTERN, MIN_AGE, NICKNAME_MAX, Row, UserRow, WITHDRAW_BLOCK_DAYS,
  check, isSuperAdmin, isUniqueViolation, iso, newId, nicknameKey, normEmail, requireUser, str, userView,
} from './common';

export const CODE_TTL_MINUTES = 5;
export const CODE_RESEND_SECONDS = 30;
const CODE_MAX_ATTEMPTS = 5;
const VERIFIED_TTL_MS = 30 * 60000;
export const CONSENT_VERSION = '2026-11-09'; // 약관·동의서·처리방침을 바꾸면 이 값도 바꿔요

interface IdentityInput {
  name: string;
  birthDate: string;
  phone: string;
}

// ---------- 공통 검사 (가입 · 운영자 추가에서 함께 사용) ----------
export async function assertEmailAvailable(ctx: Ctx, email: string): Promise<void> {
  const blocked = check(await ctx.db.from('blocked_emails').select('email').eq('email', email).maybeSingle());
  if (blocked) throw new HttpError(403, '사용할 수 없는 이메일이에요.');
  const exists = check(await ctx.db.from('users').select('id').eq('email', email).maybeSingle());
  if (exists) throw new HttpError(409, '이미 가입된 이메일이에요.');
  const withdrawn = check(await ctx.db.from('withdrawn_emails').select('until').eq('email', email).maybeSingle()) as Row | null;
  if (withdrawn && new Date(withdrawn.until as string).getTime() > ctx.now().getTime()) {
    const days = Math.ceil((new Date(withdrawn.until as string).getTime() - ctx.now().getTime()) / 86400000);
    throw new HttpError(403, `탈퇴한 이메일은 ${WITHDRAW_BLOCK_DAYS}일 동안 다시 가입할 수 없어요. (${days}일 남음)`);
  }
}

export async function assertNicknameAvailable(ctx: Ctx, nickname: string, exceptUserId?: string): Promise<void> {
  const key = nicknameKey(nickname);
  if (!key) throw new HttpError(400, '닉네임을 입력해주세요.');
  if (nickname.trim().length > NICKNAME_MAX) throw new HttpError(400, `닉네임은 ${NICKNAME_MAX}자 이하로 입력해주세요.`);
  if (key === nicknameKey(DELETED_NICKNAME)) throw new HttpError(400, '사용할 수 없는 닉네임이에요.');
  const found = check(await ctx.db.from('users').select('id').eq('nickname_key', key).maybeSingle()) as Row | null;
  if (found && found.id !== exceptUserId) throw new HttpError(409, '이미 사용 중인 닉네임이에요.');
}

export function assertPassword(password: string): void {
  if (password.length < 6) throw new HttpError(400, '비밀번호는 6자 이상 입력해주세요.');
  if (password.length > 100) throw new HttpError(400, '비밀번호가 너무 길어요.');
}

// 실명·생년월일·연락처 검증과 정리
export function normalizeIdentity(input: IdentityInput, now: Date = new Date()): IdentityInput {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!/^[가-힣a-zA-Z ]{2,20}$/.test(name)) throw new HttpError(400, '실명을 2~20자의 한글 또는 영문으로 입력해주세요.');

  const birthDate = input.birthDate.trim();
  const date = new Date(`${birthDate}T00:00:00`);
  const roundTrip = Number.isNaN(date.getTime())
    ? ''
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  if (roundTrip !== birthDate || date.getFullYear() < 1900 || date.getTime() > now.getTime()) {
    throw new HttpError(400, '생년월일을 올바르게 입력해주세요.');
  }
  // 만 14세 미만은 법정대리인 동의가 필요해서 가입을 받지 않아요.
  const hadBirthday = now.getTime() >= new Date(now.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const age = now.getFullYear() - date.getFullYear() - (hadBirthday ? 0 : 1);
  if (age < MIN_AGE) throw new HttpError(400, `만 ${MIN_AGE}세 미만은 가입할 수 없어요.`);

  const digits = input.phone.replace(/\D/g, '');
  if (!/^01[016789]\d{7,8}$/.test(digits)) throw new HttpError(400, '연락처(휴대폰 번호)를 올바르게 입력해주세요.');
  const phone =
    digits.length === 11
      ? `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`
      : `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return { name, birthDate, phone };
}

// ---------- 이메일 인증 ----------
export async function requestEmailCode(ctx: Ctx, emailArg: unknown): Promise<{ delivered: boolean; demoCode?: string }> {
  const email = normEmail(str(emailArg, 200));
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, '올바른 이메일 형식이 아니에요.');
  await assertEmailAvailable(ctx, email);

  const previous = check(await ctx.db.from('email_codes').select('sent_at').eq('email', email).maybeSingle()) as Row | null;
  if (previous) {
    const waitMs = CODE_RESEND_SECONDS * 1000 - (ctx.now().getTime() - new Date(previous.sent_at as string).getTime());
    if (waitMs > 0) throw new HttpError(429, `인증번호는 ${Math.ceil(waitMs / 1000)}초 뒤에 다시 받을 수 있어요.`);
  }

  const code = randomCode();
  check(
    await ctx.db.from('email_codes').upsert(
      {
        email,
        code_hash: hashCode(email, code, ctx.env.authSecret),
        sent_at: iso(ctx),
        expires_at: new Date(ctx.now().getTime() + CODE_TTL_MINUTES * 60000).toISOString(),
        attempts: 0,
      },
      { onConflict: 'email' },
    ),
  );

  const result = await ctx.mailer.sendCode(email, code, CODE_TTL_MINUTES);
  if (!result.configured) {
    if (ctx.env.allowDemoCode) return { delivered: false, demoCode: code }; // 개발용: 화면에 번호 표시
    check(await ctx.db.from('email_codes').delete().eq('email', email));
    throw new HttpError(503, '메일 서비스가 아직 설정되지 않았어요. 관리자에게 문의해주세요.');
  }
  if (!result.ok) {
    check(await ctx.db.from('email_codes').delete().eq('email', email));
    throw new HttpError(502, '인증 메일을 보내지 못했어요. 이메일 주소를 확인하고 잠시 뒤 다시 시도해주세요.');
  }
  return { delivered: true };
}

export async function verifyEmailCode(ctx: Ctx, emailArg: unknown, codeArg: unknown): Promise<void> {
  const email = normEmail(str(emailArg, 200));
  const code = str(codeArg, 20).trim();
  const entry = check(await ctx.db.from('email_codes').select('*').eq('email', email).maybeSingle()) as Row | null;
  if (!entry) throw new HttpError(400, '먼저 인증번호를 받아주세요.');
  if (new Date(entry.expires_at as string).getTime() < ctx.now().getTime()) {
    check(await ctx.db.from('email_codes').delete().eq('email', email));
    throw new HttpError(400, '인증번호가 만료됐어요. 다시 받아주세요.');
  }
  if ((entry.attempts as number) >= CODE_MAX_ATTEMPTS) {
    check(await ctx.db.from('email_codes').delete().eq('email', email));
    throw new HttpError(429, '입력 횟수를 넘었어요. 인증번호를 다시 받아주세요.');
  }
  if (entry.code_hash !== hashCode(email, code, ctx.env.authSecret)) {
    const attempts = (entry.attempts as number) + 1;
    check(await ctx.db.from('email_codes').update({ attempts }).eq('email', email));
    throw new HttpError(400, `인증번호가 맞지 않아요. (${CODE_MAX_ATTEMPTS - attempts}번 남음)`);
  }
  check(await ctx.db.from('email_codes').delete().eq('email', email));
  check(
    await ctx.db.from('email_verified').upsert(
      { email, until: new Date(ctx.now().getTime() + VERIFIED_TTL_MS).toISOString() },
      { onConflict: 'email' },
    ),
  );
}

export async function verifySignupEmailCode(ctx: Ctx, emailArg: unknown, codeArg: unknown) {
  await verifyEmailCode(ctx, emailArg, codeArg);
  return { proof: signToken(normEmail(str(emailArg, 200)), `signup-email:${ctx.env.authSecret}`, ctx.now().getTime()) };
}

// ---------- 가입 · 로그인 ----------
async function createProfile(ctx: Ctx, inputArg: unknown, supabaseId?: string | (() => Promise<string>)) {
  const input = (inputArg ?? {}) as Row;
  const email = normEmail(str(input.email, 200));
  const nickname = str(input.nickname, 100).trim();
  const password = str(input.password, 200);
  const idInput = (input.identity ?? {}) as Row;
  const consents = (input.consents ?? {}) as Row;

  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, '올바른 이메일 형식이 아니에요.');
  // 화면에서만 막으면 우회할 수 있으니 서버에서도 세 가지 동의를 확인해요.
  if (consents.terms !== true || consents.consent !== true || consents.privacy !== true) {
    throw new HttpError(400, '이용약관, 개인정보 수집·이용, 위급 시 신원정보 활용·제공에 모두 동의해야 가입할 수 있어요.');
  }
  await assertEmailAvailable(ctx, email);

  const verified = check(await ctx.db.from('email_verified').select('until').eq('email', email).maybeSingle()) as Row | null;
  if (!verified || new Date(verified.until as string).getTime() < ctx.now().getTime()) {
    throw new HttpError(403, '이메일 인증을 먼저 완료해주세요.');
  }
  await assertNicknameAvailable(ctx, nickname);
  if (typeof supabaseId !== 'string') assertPassword(password);
  const identity = normalizeIdentity(
    { name: str(idInput.name, 100), birthDate: str(idInput.birthDate, 20), phone: str(idInput.phone, 30) },
    ctx.now(),
  );

  const id = typeof supabaseId === 'function' ? await supabaseId() : supabaseId ?? newId();
  const created = await ctx.db.from('users').insert({
    id, email, password_hash: supabaseId ? "supabase" : await hashPassword(password), nickname, nickname_key: nicknameKey(nickname),
    ...(supabaseId ? { auth_user_id: id } : {}),
    role: 'user', leaves: 0, earned_today: 0, earned_date: null, created_at: iso(ctx),
  });
  if (isUniqueViolation(created.error)) throw new HttpError(409, '이미 사용 중인 이메일 또는 닉네임이에요.');
  check(created);

  const saved = await ctx.db.from('identities').insert({
    user_id: id, name: identity.name, birth_date: identity.birthDate, phone: identity.phone,
    consented_at: iso(ctx), consent_version: CONSENT_VERSION, created_at: iso(ctx), // 동의 일시·버전 기록
  });
  if (saved.error) {
    await ctx.db.from('users').delete().eq('id', id); // 개인정보 저장에 실패하면 가입도 취소
    check(saved);
  }
  check(await ctx.db.from('email_verified').delete().eq('email', email));

  const user = check(await ctx.db.from('users').select('*').eq('id', id).single()) as UserRow;
  return user;
}

// Legacy service kept for regression tests and migration; not exposed as an RPC.
export async function signup(ctx: Ctx, input: unknown) {
  const user = await createProfile(ctx, input);
  return { token: signToken(user.id, ctx.env.authSecret, ctx.now().getTime()), user: await userView(ctx, user) };
}

export async function provisionSignup(ctx: Ctx, inputArg: unknown) {
  const input = (inputArg ?? {}) as Row;
  const email = normEmail(str(input.email, 200));
  const password = typeof input.password === 'string' ? input.password : '';
  if (password.length > 200) throw new HttpError(400, '비밀번호는 200자까지 입력할 수 있어요.');
  if (!email || verifyToken(str(input.emailProof, 2000), `signup-email:${ctx.env.authSecret}`, ctx.now().getTime()) !== email) {
    throw new HttpError(403, '가입할 이메일의 인증번호를 먼저 확인해주세요.');
  }

  let createdId: string | undefined;
  try {
    await createProfile(ctx, input, async () => {
      const { data, error } = await ctx.db.auth.admin.createUser({ email, password, email_confirm: true });
      if (error?.code === 'email_exists' || error?.code === 'user_already_exists') {
        throw new HttpError(409, 'Supabase에 이미 등록된 이메일이에요. 기존 확인 메일을 받은 경우 그 링크로 확인한 뒤, 처음 가입할 때 입력한 비밀번호로 다시 가입을 시도해주세요.');
      }
      if (error?.code === 'weak_password') throw new HttpError(400, 'Supabase 비밀번호 요건을 충족하는 비밀번호를 입력해주세요.');
      if (error || !data.user) throw new HttpError(502, '계정을 생성하지 못했어요. 잠시 뒤 다시 시도해주세요.');
      createdId = data.user.id;
      return createdId;
    });
  } catch (error) {
    // Only clean up the Auth user created by this request, and only if no profile was saved.
    if (createdId) {
      const row = await ctx.db.from('users').select('id').eq('auth_user_id', createdId).maybeSingle();
      if (!row.error && !row.data) await ctx.db.auth.admin.deleteUser(createdId);
    }
    throw error;
  }
  return { created: true };
}

export async function completeSupabaseSignup(ctx: Ctx, inputArg: unknown) {
  const principal = ctx.authUser;
  if (!principal?.email || !principal.email_confirmed_at || !principal.identities?.some((identity) => identity.provider === 'email')) {
    throw new HttpError(401, '이메일 계정으로 로그인하고 이메일 인증을 완료해주세요.');
  }
  if (ctx.me) throw new HttpError(409, '이미 가입된 계정이에요.');
  const input = (inputArg ?? {}) as Row;
  if (verifyToken(str(input.emailProof, 2000), `signup-email:${ctx.env.authSecret}`, ctx.now().getTime()) !== normEmail(principal.email)) {
    throw new HttpError(403, '이 브라우저에서 이메일 인증을 다시 완료해주세요.');
  }
  await createProfile(ctx, { ...input, email: principal.email }, principal.id);
}

export async function login(ctx: Ctx, emailArg: unknown, passwordArg: unknown) {
  const email = normEmail(str(emailArg, 200));
  const password = str(passwordArg, 200);
  const blocked = check(await ctx.db.from('blocked_emails').select('email').eq('email', email).maybeSingle());
  if (blocked) throw new HttpError(403, '이용이 제한된 이메일이에요.');
  const user = check(await ctx.db.from('users').select('*').eq('email', email).maybeSingle()) as UserRow | null;
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, '이메일 또는 비밀번호를 확인해주세요.');
  }
  return { token: signToken(user.id, ctx.env.authSecret, ctx.now().getTime()), user: await userView(ctx, user) };
}

export async function me(ctx: Ctx) {
  return ctx.me ? userView(ctx, ctx.me) : null;
}

// ---------- 내 정보 ----------
export async function updateAvatar(ctx: Ctx, avatarArg: unknown) {
  const user = requireUser(ctx);
  let avatar: string | null = null;
  if (avatarArg !== null) {
    avatar = str(avatarArg, 400000);
    if (!avatar.startsWith('data:image/') || avatar.length >= 400000) throw new HttpError(400, '올바른 사진이 아니에요.');
  }
  check(await ctx.db.from('users').update({ avatar }).eq('id', user.id));
  return userView(ctx, { ...user, avatar });
}

export async function changeNickname(ctx: Ctx, nicknameArg: unknown) {
  const user = requireUser(ctx);
  if (isSuperAdmin(ctx, user)) throw new HttpError(403, `총괄 운영자의 닉네임은 “${user.nickname}”로 고정이에요.`);
  const nickname = str(nicknameArg, 100).trim();
  if (nickname === user.nickname) throw new HttpError(400, '현재 닉네임과 같아요.');
  await assertNicknameAvailable(ctx, nickname, user.id);
  const updated = await ctx.db.from('users').update({ nickname, nickname_key: nicknameKey(nickname) }).eq('id', user.id);
  if (isUniqueViolation(updated.error)) throw new HttpError(409, '이미 사용 중인 닉네임이에요.');
  check(updated);
  return userView(ctx, { ...user, nickname });
}

// 탈퇴: 계정 삭제(관련 데이터는 DB가 함께 정리) + 같은 이메일 30일 재가입 제한
export async function withdraw(ctx: Ctx, passwordArg: unknown): Promise<void> {
  const user = requireUser(ctx);
  if (user.role === 'admin') throw new HttpError(403, '운영자 계정은 탈퇴할 수 없어요.');
  const password = str(passwordArg, 200);
  if (user.auth_user_id) {
    const verifier = createDb(); // isolated client: do not replace the server's service-role session
    const { data, error } = await verifier.auth.signInWithPassword({ email: ctx.authUser?.email ?? user.email, password });
    if (error || data.user?.id !== user.auth_user_id) throw new HttpError(401, '비밀번호가 맞지 않아요.');
    await verifier.auth.signOut({ scope: 'local' });
  } else if (!(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, '비밀번호가 맞지 않아요.');
  }
  const until = new Date(ctx.now().getTime() + WITHDRAW_BLOCK_DAYS * 86400000).toISOString();
  check(await ctx.db.from('withdrawn_emails').upsert({ email: normEmail(user.email), until }, { onConflict: 'email' }));
  check(await ctx.db.from('users').delete().eq('id', user.id));
  if (user.auth_user_id) {
    const { error } = await ctx.db.auth.admin.deleteUser(user.auth_user_id);
    if (error) console.error('[Auth] withdrawn identity cleanup failed:', error.code);
  }
}
