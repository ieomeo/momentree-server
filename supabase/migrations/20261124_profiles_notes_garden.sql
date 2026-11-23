begin;
alter table public.users add column if not exists bio text not null default '';
create table if not exists public.direct_notes (
 id uuid primary key default gen_random_uuid(), sender_id uuid not null references public.users(id) on delete cascade,
 recipient_id uuid not null references public.users(id) on delete cascade,
 body text not null check (char_length(body) between 1 and 1000), hidden boolean not null default false,
 created_at timestamptz not null default now(), check (sender_id <> recipient_id)
);
alter table public.direct_notes enable row level security;
revoke all on public.direct_notes from public, anon, authenticated;
grant select, insert, update, delete on public.direct_notes to service_role;
create index if not exists direct_notes_inbox_idx on public.direct_notes(recipient_id, created_at desc,id desc);
alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check check (target_type in ('post','comment','note'));
create unique index if not exists one_note_report on public.reports(target_id,reporter_id) where target_type='note';
create or replace function public.send_direct_note(p_sender uuid,p_recipient uuid,p_body text,p_unlimited boolean)
returns text language plpgsql set search_path=public,pg_temp as $$
declare s public.users%rowtype;
begin
 if p_sender=p_recipient then return 'unavailable'; end if;
 perform id from public.users where id in (p_sender,p_recipient) order by id for update;
 select * into s from public.users where id=p_sender;
 if s.id is null or s.restricted_until>now() or not exists(select 1 from public.users where id=p_recipient)
 or exists(select 1 from public.blocks where (blocker_id=p_sender and blocked_id=p_recipient) or (blocker_id=p_recipient and blocked_id=p_sender)) then return 'unavailable'; end if;
 if not (p_unlimited is true and s.role='admin') then
   if s.leaves<30 then return 'insufficient'; end if;
   update public.users set leaves=leaves-30 where id=p_sender;
   insert into public.leaf_logs(id,user_id,type,label,amount) values(gen_random_uuid(),p_sender,'spend','쪽지 발송',30);
 end if;
 insert into public.direct_notes(sender_id,recipient_id,body) values(p_sender,p_recipient,p_body);
 return 'sent';
end; $$;
revoke all on function public.send_direct_note(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.send_direct_note(uuid,uuid,text,boolean) to service_role;
create or replace function public.garden_total(p_user uuid) returns bigint language sql stable set search_path=public,pg_temp as $$
 select coalesce(sum(amount),0) from public.leaf_logs where user_id=p_user and type='earn' and label is distinct from '게시 복구 반환';
$$;
revoke all on function public.garden_total(uuid) from public,anon,authenticated;
grant execute on function public.garden_total(uuid) to service_role;
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
 elsif r.target_type='note' then
   select sender_id,hidden into uid,was_hidden from public.direct_notes where id=r.target_id for update;
 else
   select author_id,hidden into uid,was_hidden from public.comments where id=r.target_id for update;
 end if;
 target_found := found;
 if not target_found and p_action='경고 및 게시 중단' then
   -- Closing another report is not a second sanction. Leave any existing restriction untouched.
   if not (r.status='done' and r.action=p_action and r.moderation_deleted) then
     update public.reports set status='done',action=p_action,moderation_deleted=true,
       moderation_stopped=false where id=p_report;
     insert into public.moderation_history(report_id,actor_id,action,stopped,restriction_days,leaf_delta)
     values(p_report,p_actor,'대상 없음 · 처리 완료',false,null,0);
   end if;
   return;
 end if;

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
   elsif r.target_type='note' then update public.direct_notes set hidden=now_hidden where id=r.target_id;
   else update public.comments set hidden=now_hidden where id=r.target_id; end if;
 end if;
 -- Book the exact reliably linked reward once per hide/restore transition.
 if r.target_type <> 'note' and target_found and uid is not null and (coalesce(was_hidden,false) <> now_hidden) then
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
   if not (p_action='경고 및 게시 중단' and coalesce(was_hidden,false)) then
   insert into public.notifications(id,user_id,type,text) values (gen_random_uuid(),uid,
     case when p_action='이용 제한' then 'restricted' when stop_it then 'warning' else 'notice' end,
     case when stop_it then '운영자 경고 및 게시 중단. ' else '' end ||
     case when deadline is not null then '이용 제한: '||label_text||'. ' when not stop_it then '이 신고 건의 조치가 해제됐거나 별도 조치를 적용하지 않아요. ' else '' end ||
     case when was_hidden and not now_hidden then '이 조치로 중단됐던 게시가 복구됐어요. ' else '' end ||
     '신고 사유: '||r.reason);
   end if;
 end if;
 insert into public.moderation_history(report_id,actor_id,action,stopped,restriction_days,leaf_delta)
 values (p_report,p_actor,p_action,stop_it,p_days,delta);
end;
$$;
revoke all on function public.resolve_moderation(uuid,uuid,text,integer,boolean) from public, anon, authenticated;
grant execute on function public.resolve_moderation(uuid,uuid,text,integer,boolean) to service_role;

-- Old server builds may still call the former deletion RPC. Keep the signature,
-- but never physically delete a post or comment through it again.
create or replace function public.warn_and_delete_report_target(p_report uuid,p_actor uuid)
returns void language plpgsql set search_path=public,pg_temp as $$
begin
  perform public.resolve_moderation(p_report,p_actor,'경고 및 게시 중단',null,true);
end;
$$;
revoke all on function public.warn_and_delete_report_target(uuid,uuid) from public,anon,authenticated;
grant execute on function public.warn_and_delete_report_target(uuid,uuid) to service_role;
commit;
