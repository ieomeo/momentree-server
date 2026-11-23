-- Run once before deploying the updated server. Idempotent schema additions.
alter table public.comments add column if not exists hidden boolean not null default false;
alter table public.posts add column if not exists moderation_hidden boolean not null default false;
alter table public.leaf_logs add column if not exists source_type text;
alter table public.leaf_logs add column if not exists source_id uuid;
create index if not exists leaf_logs_source_idx on public.leaf_logs(source_type, source_id) where type = 'earn';
alter table public.reports add column if not exists moderation_author uuid;
alter table public.reports add column if not exists moderation_stopped boolean not null default false;
alter table public.reports add column if not exists moderation_until timestamptz;
alter table public.reports add column if not exists moderation_days integer;
alter table public.users add column if not exists legacy_restricted_until timestamptz;
alter table public.users add column if not exists legacy_restriction_reason text;
update public.users set legacy_restricted_until=restricted_until, legacy_restriction_reason=restriction_reason
where restricted_until is not null and legacy_restricted_until is null
  and not exists (select 1 from public.reports r where r.moderation_author=users.id and r.moderation_until is not null);
create table if not exists public.moderation_history (
 id uuid primary key default gen_random_uuid(), report_id uuid not null references public.reports(id) on delete cascade,
 actor_id uuid references public.users(id) on delete set null, action text not null,
 stopped boolean not null, restriction_days integer, leaf_delta integer not null,
 created_at timestamptz not null default now()
);
alter table public.moderation_history enable row level security;
grant select on public.moderation_history to service_role;
create index if not exists moderation_history_report_idx on public.moderation_history(report_id,created_at desc);
create index if not exists reports_moderation_target_idx on public.reports(target_type,target_id) where moderation_stopped;
create index if not exists reports_moderation_author_idx on public.reports(moderation_author) where moderation_until is not null;

create or replace function public.resolve_moderation(p_report uuid, p_actor uuid, p_action text, p_days integer, p_stop boolean)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
 r public.reports%rowtype; u public.users%rowtype;
 uid uuid; was_hidden boolean; now_hidden boolean; stop_it boolean;
 deadline timestamptz; effective_until timestamptz; effective_reason text;
 points integer := 0; delta integer := 0; label_text text; target_found boolean;
begin
 if not exists(select 1 from public.users where id=p_actor and role='admin') then raise exception '운영자만 조치할 수 있어요'; end if;
 if p_action is null or p_action not in ('문제 없음','경고 및 게시 중단','이용 제한') then raise exception '올바르지 않은 조치입니다'; end if;
 select * into r from public.reports where id=p_report for update;
 if not found then raise exception '신고를 찾을 수 없어요'; end if;
 stop_it := p_action='경고 및 게시 중단' or (p_action='이용 제한' and coalesce(p_stop,false));
 if p_action='이용 제한' then
   if p_days is null or p_days not in (0,1,3,7,30,90) then raise exception '올바르지 않은 이용 제한 기간입니다'; end if;
   deadline := case p_days when 0 then '9999-12-31T00:00:00Z'::timestamptz else now()+p_days*interval '24 hours' end;
 else p_days := null;
 end if;
 if r.status='done' and r.action=p_action and r.moderation_stopped=stop_it and r.moderation_days is not distinct from p_days
    and (deadline is null or r.moderation_until > now()) then return; end if;
 if r.target_type='post' then
   select author_id,moderation_hidden into uid,was_hidden from public.posts where id=r.target_id for update;
 else
   select author_id,hidden into uid,was_hidden from public.comments where id=r.target_id for update;
 end if;
 target_found := found;
 if (stop_it or deadline is not null) and not target_found then raise exception '신고 대상이 이미 삭제됐어요'; end if;
 uid := coalesce(uid,r.moderation_author);
 if uid is not null then select * into u from public.users where id=uid for update; end if;
 if deadline is not null and (u.id is null or u.role='admin') then raise exception '운영자 계정 또는 존재하지 않는 계정은 제한할 수 없어요'; end if;
 -- Two reports against the same item or author retain their independent effects.
 update public.reports set status='done', action=p_action, moderation_author=uid,
   moderation_stopped=stop_it, moderation_until=deadline, moderation_days=p_days where id=p_report;
 now_hidden := exists(select 1 from public.reports where target_type=r.target_type and target_id=r.target_id and moderation_stopped);
 if target_found and (was_hidden is distinct from now_hidden) then
   if r.target_type='post' then update public.posts set moderation_hidden=now_hidden where id=r.target_id;
   else update public.comments set hidden=now_hidden where id=r.target_id; end if;
 end if;
 -- Book the exact reliably linked reward once per hide/restore transition.
 if uid is not null and (coalesce(was_hidden,false) <> now_hidden) then
   select coalesce(sum(amount),0)::integer into points from public.leaf_logs
     where user_id=uid and source_type=r.target_type and source_id=r.target_id and type='earn';
   delta := case when now_hidden then -points else points end;
   if delta <> 0 then
     update public.users set leaves=leaves+delta where id=uid;
     insert into public.leaf_logs(id,user_id,type,label,amount) values
       (gen_random_uuid(),uid,case when delta<0 then 'spend' else 'earn' end,
        case when delta<0 then '게시 중단 회수' else '게시 복구 반환' end, abs(delta));
   end if;
 end if;
 if uid is not null then
   select q.until_at,q.reason into effective_until,effective_reason from (
     select legacy_restricted_until as until_at,legacy_restriction_reason as reason from public.users where id=uid
     union all select moderation_until,reason from public.reports where moderation_author=uid and moderation_until is not null
   ) q where q.until_at>now() order by q.until_at desc limit 1;
   update public.users set restricted_until=effective_until,restriction_reason=effective_reason where id=uid;
   label_text := case when p_days=0 then '영구' when p_days=30 then '1달(30일)' when p_days=90 then '3달(90일)' else p_days||'일' end;
   insert into public.notifications(id,user_id,type,text) values (gen_random_uuid(),uid,
     case when p_action='이용 제한' then 'restricted' when stop_it then 'warning' else 'notice' end,
     case when stop_it then '운영자 경고 및 게시 중단. ' else '' end ||
     case when deadline is not null then '이용 제한: '||label_text||'. ' when not stop_it then '이 신고 건의 조치가 해제됐거나 별도 조치를 적용하지 않아요. ' else '' end ||
     case when was_hidden and not now_hidden then '이 조치로 중단됐던 게시가 복구됐어요. ' else '' end ||
     '신고 사유: '||r.reason);
 end if;
 insert into public.moderation_history(report_id,actor_id,action,stopped,restriction_days,leaf_delta)
 values (p_report,p_actor,p_action,stop_it,p_days,delta);
end;
$$;
revoke all on function public.resolve_moderation(uuid,uuid,text,integer,boolean) from public, anon, authenticated;
grant execute on function public.resolve_moderation(uuid,uuid,text,integer,boolean) to service_role;

-- Keep rewards and their source ledger in sync, including during concurrent moderation.
create or replace function public.earn_content_leaves(p_user uuid,p_source_type text,p_source_id uuid,p_amount integer,p_label text,p_now timestamptz)
returns void language plpgsql set search_path=public,pg_temp as $$
declare
 author uuid; blocked boolean; tally integer; gain integer; day_utc date := (p_now at time zone 'UTC')::date;
begin
 if p_source_type='post' then
   select author_id,hidden or moderation_hidden into author,blocked from public.posts where id=p_source_id for update;
 elsif p_source_type='comment' then
   select author_id,hidden into author,blocked from public.comments where id=p_source_id for update;
 else return;
 end if;
 if author is distinct from p_user or blocked is distinct from false or p_amount is null or p_amount not between 1 and 3 then return; end if;
 select case when earned_date=day_utc then earned_today else 0 end into tally from public.users where id=p_user for update;
 if not found then return; end if;
 gain := least(p_amount,20-tally);
 if gain<=0 then return; end if;
 update public.users set leaves=leaves+gain,earned_today=tally+gain,earned_date=day_utc where id=p_user;
 insert into public.leaf_logs(id,user_id,type,label,amount,source_type,source_id,created_at)
 values(gen_random_uuid(),p_user,'earn',p_label,gain,p_source_type,p_source_id,p_now);
end;
$$;
revoke all on function public.earn_content_leaves(uuid,text,uuid,integer,text,timestamptz) from public,anon,authenticated;
grant execute on function public.earn_content_leaves(uuid,text,uuid,integer,text,timestamptz) to service_role;

-- Debit against the live balance; never overwrite a concurrent moderation recovery/withdrawal.
create or replace function public.subscribe_with_leaves(p_user uuid,p_author uuid,p_label text)
returns text language plpgsql set search_path=public,pg_temp as $$
declare balance integer;
begin
 select leaves into balance from public.users where id=p_user for update;
 if not found or balance<10 then return 'insufficient'; end if;
 insert into public.subscriptions(subscriber_id,author_id) values (p_user,p_author) on conflict do nothing;
 if not found then return 'duplicate'; end if;
 update public.users set leaves=leaves-10 where id=p_user;
 insert into public.leaf_logs(id,user_id,type,label,amount) values(gen_random_uuid(),p_user,'spend',p_label,10);
 return 'ok';
end;
$$;
revoke all on function public.subscribe_with_leaves(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.subscribe_with_leaves(uuid,uuid,text) to service_role;
