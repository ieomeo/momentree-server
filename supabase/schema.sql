-- 모먼트리 데이터베이스 구조.
-- Supabase SQL Editor에서 이 파일 전체를 한 번 실행하세요. (다시 실행해도 안전해요)
-- 브라우저(anon/authenticated)는 DB에 직접 접근할 수 없고, 서버(service_role)만 접근해요.

create table if not exists public.users (
  id uuid primary key,
  email text not null unique,                 -- 항상 소문자로 저장
  password_hash text not null,                -- scrypt 해시 (원문 비밀번호는 저장하지 않아요)
  nickname text not null,
  nickname_key text not null unique,          -- 공백 제거 + 소문자: 닉네임 중복 방지
  role text not null default 'user' check (role in ('user', 'admin')),
  leaves integer not null default 0,
  earned_today integer not null default 0,
  earned_date date,
  avatar text,                                -- 프로필 사진(data URL)
  restricted_until timestamptz,               -- 이용 제한이 끝나는 시각 (비어 있으면 제한 없음)
  restriction_reason text,                    -- 이용 제한 사유
  created_at timestamptz not null default now()
);

-- 실명·생년월일·연락처: 서버가 정한 권한 규칙으로만 읽을 수 있어요.
create table if not exists public.identities (
  user_id uuid primary key references public.users(id) on delete cascade,
  name text not null,
  birth_date date not null,
  phone text not null,
  consented_at timestamptz not null default now(),   -- 동의 일시 (가입 시 기록)
  consent_version text not null default '',          -- 동의한 약관·동의서 버전
  created_at timestamptz not null default now()
);

-- 이미 예전 구조로 만든 DB에서 이 파일을 다시 실행해도 새 열이 추가돼요.
alter table public.users add column if not exists restricted_until timestamptz;
alter table public.users add column if not exists restriction_reason text;
alter table public.identities add column if not exists consented_at timestamptz not null default now();
alter table public.identities add column if not exists consent_version text not null default '';

-- 누가 누구의 개인정보를 언제 열람했는지 기록
create table if not exists public.identity_logs (
  id uuid primary key,
  admin_id uuid,
  admin_nickname text not null,
  target_nickname text not null,
  reason text not null check (reason in ('crisis-alert', 'super-admin')),
  at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  subscriber_id uuid not null references public.users(id) on delete cascade,
  author_id uuid not null references public.users(id) on delete cascade,
  primary key (subscriber_id, author_id)
);

create table if not exists public.blocks (
  blocker_id uuid not null references public.users(id) on delete cascade,
  blocked_id uuid not null references public.users(id) on delete cascade,
  primary key (blocker_id, blocked_id)
);

create table if not exists public.posts (
  id uuid primary key,
  author_id uuid references public.users(id) on delete set null,  -- 탈퇴하면 null → "탈퇴한 사용자"
  category text not null,
  title text not null,
  content text not null,
  hidden boolean not null default false,       -- 운영자가 게시 중단
  is_private boolean not null default false,   -- 작성자가 비공개로 전환
  pinned boolean not null default false,       -- 운영자가 고정
  created_at timestamptz not null default now()
);
create index if not exists posts_created_at_idx on public.posts (created_at desc);
create index if not exists posts_author_idx on public.posts (author_id);

create table if not exists public.post_likes (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  primary key (post_id, user_id)
);

create table if not exists public.comments (
  id uuid primary key,
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id uuid references public.users(id) on delete set null,
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists comments_post_idx on public.comments (post_id);

create table if not exists public.reports (
  id uuid primary key,
  target_type text not null check (target_type in ('post', 'comment')),
  target_id uuid not null,
  target_preview text not null,
  reason text not null,
  detail text,
  reporter_id uuid references public.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'reviewing', 'done')),
  action text,
  created_at timestamptz not null default now()
);

create table if not exists public.crisis_alerts (
  id uuid primary key,
  post_id uuid references public.posts(id) on delete set null,
  keyword_count integer not null default 0,
  status text not null default 'pending' check (status in ('pending', 'reviewing', 'done')),
  care_sent boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.leaf_logs (
  id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null check (type in ('earn', 'spend')),
  label text not null,
  amount integer not null,
  created_at timestamptz not null default now()
);
create index if not exists leaf_logs_user_idx on public.leaf_logs (user_id, created_at desc);

create table if not exists public.notifications (
  id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null,
  text text not null,
  link text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- 오늘의 쉼표: 나만 볼 수 있는 하루 한마디
create table if not exists public.daily_notes (
  user_id uuid not null references public.users(id) on delete cascade,
  note_date date not null,
  text text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, note_date)
);

create table if not exists public.withdrawn_emails (   -- 탈퇴 후 재가입 제한
  email text primary key,
  until timestamptz not null
);

create table if not exists public.blocked_emails (     -- 운영자가 접근을 차단한 이메일
  email text primary key,
  at timestamptz not null default now()
);

create table if not exists public.email_codes (        -- 이메일 인증번호(해시로만 저장)
  email text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  sent_at timestamptz not null,
  attempts integer not null default 0
);

create table if not exists public.email_verified (     -- 인증을 마친 이메일(가입 직전까지 유효)
  email text primary key,
  until timestamptz not null
);

-- 모든 테이블: 행 수준 보안 켜기 + 브라우저 역할 권한 회수 + 서버 역할에만 권한 부여
do $$
declare t text;
begin
  foreach t in array array[
    'users', 'identities', 'identity_logs', 'subscriptions', 'blocks', 'posts', 'post_likes',
    'comments', 'reports', 'crisis_alerts', 'leaf_logs', 'notifications', 'daily_notes',
    'withdrawn_emails', 'blocked_emails', 'email_codes', 'email_verified'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end
$$;

grant usage on schema public to service_role;
-- Preserve existing app IDs and all references. Link profiles only after credential verification.
alter table public.users add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;
