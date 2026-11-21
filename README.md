# 모먼트리 API 서버 (Express + Supabase)

모먼트리의 글·댓글·알림·개인정보를 **Supabase PostgreSQL**에 영구 저장하는 서버예요.
브라우저는 DB에 직접 접근하지 못하고, 이 서버만 서버용 Secret key로 DB에 접근해요.

```
React(Vercel) ──HTTPS──▶ Express(Render) ──Secret key──▶ Supabase PostgreSQL
                          ↑ 로그인·운영자 권한·개인정보 접근 규칙을 여기서 지켜요
```

## 한눈에 보는 순서

1. Supabase 프로젝트 만들기 → `supabase/schema.sql` 실행
2. Brevo 가입 → 보내는 이메일 인증 → API 키 만들기 (인증 메일용, 무료)
3. 내 컴퓨터에서 서버 켜 보기 (`.env` 작성 → 테스트 → `npm run dev`)
4. GitHub에 올리기 → Render에 배포
5. Vercel(클라이언트)에 서버 주소 넣고 다시 배포 → 서버 CORS에 Vercel 주소 추가

---

## 1. Supabase

1. [supabase.com](https://supabase.com) → **New project** (이름 `momentree`, DB 비밀번호는 보관만 하세요).
2. **SQL Editor → New query**에 `supabase/schema.sql` 전체를 붙여넣고 **Run**. 오류가 없어야 해요. (다시 실행해도 안전해요)
3. **Table Editor**에 `users`, `posts`, `identities` 등 17개 테이블이 보이면 성공이에요.
   - 이전 버전의 `schema.sql`을 이미 실행했다면 **새 파일을 한 번 더 실행**하세요. 새로 생긴 열(이용 제한, 동의 기록)만 추가되고 기존 데이터는 그대로예요.
4. **Integrations → Data API**에서 `public` 스키마가 노출되어 있는지 확인해요.
5. **Settings → API Keys**에서
   - **Project URL** (`https://xxxx.supabase.co`, 끝에 `/rest/v1`은 붙이지 않아요)
   - **Secret key** (`sb_secret_...`) 를 복사해 둬요. Secret key는 **서버에만** 넣고, 클라이언트(`VITE_*`)·GitHub·채팅에는 절대 올리지 않아요.

> 모든 테이블은 행 수준 보안(RLS)이 켜져 있고 `anon`/`authenticated` 권한을 회수했어요. 브라우저에서 DB를 직접 읽을 수 없고, 서버 키로만 접근돼요.

## 2. 인증 메일 보내기 (Brevo 무료 플랜)

1. [brevo.com](https://www.brevo.com) 가입.
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender**에서 보내는 사람 이메일(예: `khs9523007@ajou.ac.kr`)을 등록하고, 그 메일함에 온 인증 링크를 눌러 승인해요.
3. **SMTP & API → API Keys → Generate a new API key**로 키를 만들어요.
4. 서버 환경변수에 `BREVO_API_KEY`, `MAIL_SENDER_EMAIL`을 넣어요.

무료 플랜은 하루 300통까지 보낼 수 있어요(2026년 기준 제3자 자료 확인, brevo.com 요금 페이지에서 한 번 더 확인하세요). 학교·Gmail 주소에서 보내는 메일은 스팸함으로 갈 수 있어요. 인증 메일이 안 보이면 스팸함을 확인하세요.

메일 서비스를 아직 연결하지 않았다면, **로컬 개발 중에만** `.env`에 `ALLOW_DEMO_CODE=true`를 두면 인증번호가 가입 화면에 표시돼요. 배포 환경에서는 반드시 `false`(또는 생략)로 두세요. 화면에 번호가 보이면 인증의 의미가 없어요.

## 3. 내 컴퓨터에서 실행

```bash
cd momentree-server
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

`.env`를 열어 값을 채워요.

| 이름 | 넣을 값 |
|---|---|
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | 1단계에서 복사한 값 |
| `AUTH_SECRET` | 32자 이상 임의 문자열. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 로 만들어요 |
| `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` / `SUPER_ADMIN_NICKNAME` | 총괄 운영자 계정. **비밀번호는 코드가 아니라 여기에만** 적어요 |
| `CORS_ORIGINS` | 클라이언트 주소. 로컬은 `http://localhost:5173,http://momentree.localhost:5173` |
| `BREVO_API_KEY` / `MAIL_SENDER_EMAIL` | 2단계 값 (개발 중에는 비워도 돼요) |
| `ALLOW_DEMO_CODE` | 개발 중에만 `true` |

```bash
npm install --include=dev
npm test                    # 로직 검사 29개 (DB 없이 가짜 DB로 실행)
npm run db:check            # 실제 Supabase 연결 확인
npm run dev                 # http://localhost:3000
```

다른 터미널에서 확인해요.

```bash
curl -i http://localhost:3000/health
```

서버가 켜질 때 총괄 운영자 계정이 자동으로 만들어지고(`.env` 값으로), 이미 있으면 이메일·비밀번호·닉네임·권한이 `.env` 값에 맞춰져요. Supabase **Table Editor → users**에서 확인할 수 있어요.

클라이언트(`momentree` 폴더)는 `.env.local`에 `VITE_API_BASE_URL=http://localhost:3000`을 넣고 `npm run dev`로 켜요.

## 4. GitHub → Render 배포

```bash
git init
git branch -M main
git remote add origin https://github.com/내아이디/momentree-server.git
git add .
git commit -m "Momentree API server"
git push -u origin main
```
(`.env`는 `.gitignore`로 제외돼요. `git status`에 `.env`가 보이면 멈추세요.)

Render → **New → Web Service** → 저장소 선택

| 항목 | 값 |
|---|---|
| Runtime | Node |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

**Environment Variables**: `NODE_ENV=production`, `NODE_VERSION=24.22.1`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AUTH_SECRET`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`, `SUPER_ADMIN_NICKNAME`, `CORS_ORIGINS`(Vercel 주소), `BREVO_API_KEY`, `MAIL_SENDER_EMAIL`, `MAIL_SENDER_NAME`. `PORT`는 넣지 않아요. `ALLOW_DEMO_CODE`는 넣지 않거나 `false`.

배포가 끝나면 `https://서비스이름.onrender.com/health` 가 `{"status":"ok"}`인지 확인해요. 무료 서비스는 한동안 쓰지 않으면 잠들어서 첫 요청이 1분 가까이 걸릴 수 있어요.

## 5. Vercel(클라이언트) 연결

1. Vercel 프로젝트 **Settings → Environment Variables**에 `VITE_API_BASE_URL` = Render 주소(끝에 `/api` 없이)를 넣고 **Redeploy**.
2. Render의 `CORS_ORIGINS`에 Vercel 주소(예: `https://momentree.vercel.app`)를 쉼표로 추가하고 다시 배포.

## 확인 체크리스트

- [ ] 가입 → 인증번호 메일 수신 → 인증 → 가입 완료 (새로고침해도 로그인 유지)
- [ ] 다른 브라우저/기기에서 같은 글이 보임 (DB 공유)
- [ ] 서버 재시작·재배포 후에도 글이 남아 있음
- [ ] 총괄 운영자 로그인 → 운영자 화면 → 맨 아래 "회원 개인정보"에서 열람
- [ ] 일반 운영자는 위기 알림의 작성자 정보만 열람, 열람 기록이 남음

## 문제가 생기면

| 증상 | 확인 |
|---|---|
| 서버가 바로 종료됨 | 터미널 메시지의 환경변수 안내 (`AUTH_SECRET` 32자 이상, `SUPER_ADMIN_PASSWORD` 6자 이상) |
| `DB 요청에 실패했어요` (503) | 서버 로그의 `[Supabase]` 줄: `PGRST205`=테이블 없음(스키마 실행 확인), `42501`=권한(Secret key인지, schema.sql 끝부분 실행 확인) |
| 브라우저에서 CORS 오류 | 서버 `CORS_ORIGINS`에 클라이언트 주소가 정확히(끝에 `/` 없이) 들어 있는지 |
| `서버에 연결할 수 없어요` | Render가 잠든 상태일 수 있어요. 1분 뒤 다시. 주소·`VITE_API_BASE_URL` 확인 |
| 인증 메일이 안 옴 | 스팸함, Brevo의 보내는 사람 승인 여부, Render 로그의 `[Brevo]` 줄 |
| 인증번호가 화면에 보임 | 메일 서비스 미연결 + `ALLOW_DEMO_CODE=true` 상태 (개발 모드) |

## 이용 제한과 정리 작업

- 신고 처리에서 **이용 제한**을 고르면 기간(1·3·7·30일·영구)을 정해요. 제한 중인 이용자는 글쓰기·댓글·공감·구독·신고를 할 수 없고(읽기·내 글 관리·알림·탈퇴는 가능), 화면 위에 안내가 떠요. 기간이 지나면 자동으로 풀리고, 운영자는 처리된 신고에서 **제한 해제**를 누를 수 있어요. 운영자 계정은 제한할 수 없어요.
- 가입은 **만 14세 이상**만 가능해요. 서버가 생년월일로 확인해요.
- 가입 때 세 가지 동의(약관·개인정보 수집·이용·위급 시 신원정보)를 서버가 확인하고, 동의 일시와 문서 버전(`CONSENT_VERSION`, `src/services/auth.ts`)을 `identities` 테이블에 기록해요. 약관이나 방침을 바꾸면 이 값도 바꾸세요.
- 서버는 시작할 때와 하루에 한 번 기간이 지난 데이터를 지워요: 재가입 제한(30일)이 끝난 탈퇴 이메일, 만료된 인증번호, 1년 지난 개인정보 열람 기록, 접수 후 1년 지난 처리 완료 신고·위기 알림. 개인정보 처리방침에 적은 보관 기간과 같아요. 기간을 바꾸려면 `src/services/seed.ts`의 `purgeExpired`와 방침 문구를 함께 고치세요.

## 알아둘 점 (보안)

- 개인정보(실명·생년월일·연락처)는 `identities` 테이블에만 있고, 서버가 정한 규칙(일반 운영자: 처리 중인 위기 알림의 작성자만 / 총괄 운영자: 모든 회원)으로만 읽혀요. 읽을 때마다 `identity_logs`에 기록이 남아요. 다만 **DB 비밀번호·Secret key를 가진 사람은 DB를 직접 볼 수 있으니** 키 관리가 중요해요.
- 비밀번호는 scrypt 해시로 저장돼요. 로그인 토큰은 서버가 서명하고 7일 뒤 만료돼요(클라이언트 LocalStorage에 보관).
- 로그인·가입·인증번호 요청은 IP당 10분에 30번으로 제한돼요(서버 메모리 기준이라 서버가 재시작되면 초기화돼요).
- 약관·동의서·개인정보 처리방침은 **초안**이에요(앱 안에서 `전문 보기`로 볼 수 있어요). **실제 이용자의 실명·연락처를 받기 전에** 법률 전문가의 검토를 받고, 처리방침의 국외 보관(Supabase·Render·Vercel·Brevo) 설명이 실제 설정(지역 등)과 맞는지 확인하세요.
- 예전 코드에 들어 있던 총괄 운영자 비밀번호는 공개 저장소에 남아 있을 수 있어요. 배포용으로는 **새 비밀번호**를 `SUPER_ADMIN_PASSWORD`에 쓰세요.

## Supabase Auth 전환 및 네이버 OIDC

이 버전에서는 React의 Supabase Auth SDK가 이메일 가입·비밀번호 로그인·갱신·로그아웃과 네이버 PKCE 세션을 담당합니다. Express는 각 Bearer 토큰을 `auth.getUser(jwt)`로 검증한 뒤 기존 `public.users.auth_user_id`로 모먼트리 계정을 읽습니다. `/api/auth/me`에서도 이 경로를 사용합니다. 권한은 기존 모먼트리 DB의 `role`과 이용 제한으로 결정됩니다. 앱 화면과 기존 API들은 기존 프로필 형식을 유지합니다.

1. DB를 백업한 뒤 **기존 DB**에는 `supabase/migrations/20261118_supabase_auth.sql`을 실행합니다. **신규 DB**는 `supabase/schema.sql`에 포함되어 있습니다. 기존 앱 UUID, 글, 권한은 바뀌지 않습니다. 새 사용자는 앱 UUID로 Auth UUID를 사용합니다.
2. Supabase Auth에서 Email, 신규 가입, **Enable Manual Linking**을 켭니다. 모먼트리의 기존 이메일 코드 인증(Brevo 또는 개발 모드)과 약관·신원정보 가입 절차는 그대로입니다. 신규 모먼트리 가입에는 Supabase 확인 링크를 발송하지 않습니다. 서버가 인증 증명과 기한을 확인하고 Admin SDK로 이메일 확인된 계정을 생성합니다. Confirm email 설정은 바꾸지 않아도 됩니다. 이전 버전의 미완료 계정은 기존 링크를 확인하고 기존 비밀번호 및 새 인증번호로 회원가입을 다시 진행하세요. 기존 계정의 비밀번호나 인증 상태를 서버가 덮어쓰지 않습니다. 운영에서는 개발용 코드 노출을 비활성화하세요.
3. Supabase Site URL을 프런트엔드 origin(예: `http://127.0.0.1:5173`), Redirect URLs를 `http://127.0.0.1:5173/auth/callback`으로 설정합니다. Express `CORS_ORIGINS` 및 Vite 주소도 이 origin과 맞춥니다. 배포에서는 HTTPS 주소로 등록하고 `/auth/callback`까지 SPA fallback이 동작해야 합니다.
4. 네이버의 서비스 URL에 프런트엔드 origin을, **네이버 Callback URL에는 Supabase** `https://<project-ref>.supabase.co/auth/v1/callback`을 등록합니다. 네이버 테스트 계정을 등록하고, 이 연동에는 이름·이메일 등의 추가 정보 제공을 요청하지 않습니다.
5. 서버 `.env`에 네이버 `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`을 넣고 `npm run auth:setup-naver` → `npm run auth:check`를 실행합니다. Google 설정은 필요하지 않습니다. `/api/auth/providers`에는 이메일과 네이버의 활성화 여부만 노출합니다. 이전 직접 OAuth 설정(`NAVER_REDIRECT_URI`, 네이버 콜백 `/login`)은 더 이상 사용하지 않습니다.
6. 프런트엔드 `.env.local`에 `VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`를 설정하고 프런트엔드·서버를 재시작합니다. 서버 Secret key나 네이버 Client Secret을 프런트엔드에 넣지 않습니다.

**기존 사용자 이전:** 이메일과 기존 비밀번호로 처음 로그인할 때 서버가 기존 비밀번호 해시를 확인한 다음에만 Supabase Auth 자격을 생성하고 기존 앱 사용자에 연결합니다. 같은 이메일로 미연결 Supabase 계정이 선점된 경우 자동 연결하지 않습니다. 이때 관리자가 기존 Auth 계정 상태를 확인해야 합니다. 종전 직접 OAuth로 저장했던 `naver_accounts` 매핑은 Supabase identity로 자동 이전하지 않습니다. 이미 적용했다면 이전 테이블은 삭제하지 않으며 사용자는 이메일 로그인 후 네이버를 다시 연결해야 합니다.

**테스트 순서:** 이메일 가입/로그인 → `/api/auth/me` 200 → 새로고침 및 보호 화면 → 상단 **네이버 연결** → 로그아웃 → 로그인 화면의 **네이버 로그인** → 같은 앱 사용자 ID/역할 확인. 네이버만으로 신규 앱 계정을 생성하지 않으며 기존 필수 가입 절차를 건너뛰지 않습니다. 로그인 실패/취소, 토큰 없는 `/api/auth/me` 401, 일반 회원의 관리자 API 거부도 확인하세요. Supabase 로그인 세션이 있어도 앱 프로필이 없으면 보호 API는 접근할 수 없습니다.
