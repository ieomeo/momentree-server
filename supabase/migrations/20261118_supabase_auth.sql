-- Preserve existing app IDs and all references. Link profiles only after credential verification.
alter table public.users add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;
