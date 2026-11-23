begin;
lock table public.posts in share row exclusive mode;

-- Keep this marker after post deletion. Do not add a foreign key to posts.
alter table public.users add column if not exists first_post_id uuid;
alter table public.posts add column if not exists is_first_post boolean not null default false;

-- Backfill from surviving posts and attributable writing logs for deleted posts.
with candidates as (
  select author_id as user_id, id, created_at from public.posts where author_id is not null
  union all
  select l.user_id, l.source_id, l.created_at
  from public.leaf_logs l
  where l.type = 'earn' and l.label = '글 작성' and l.source_type = 'post'
    and l.source_id is not null
    and not exists (select 1 from public.posts p where p.id = l.source_id)
), firsts as (
  select distinct on (user_id) user_id, id from candidates order by user_id, created_at, id
)
update public.users u set first_post_id = f.id from firsts f
where u.id = f.user_id and u.first_post_id is null;

update public.posts p set is_first_post = true from public.users u
where u.id = p.author_id and u.first_post_id = p.id and not p.is_first_post;

create unique index if not exists posts_one_first_per_author_idx
on public.posts (author_id) where is_first_post and author_id is not null;
create index if not exists posts_first_feed_idx
on public.posts (created_at desc) where is_first_post;

create or replace function public.mark_first_post()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.is_first_post := false;
  if new.author_id is not null then
    -- Concurrent inserts serialize on the same user row; only one can claim it.
    update public.users set first_post_id = new.id
    where id = new.author_id and first_post_id is null;
    new.is_first_post := found;
  end if;
  return new;
end;
$$;
drop trigger if exists posts_mark_first on public.posts;
create trigger posts_mark_first before insert on public.posts
for each row execute function public.mark_first_post();
commit;
