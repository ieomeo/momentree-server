begin;
create or replace function public.send_direct_note(p_sender uuid,p_recipient uuid,p_body text,p_unlimited boolean)
returns text language plpgsql set search_path=public,pg_temp as $$
declare s public.users%rowtype; note_id uuid;
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
 insert into public.direct_notes(sender_id,recipient_id,body) values(p_sender,p_recipient,p_body) returning id into note_id;
 insert into public.notifications(id,user_id,type,text,link)
 values(gen_random_uuid(),p_recipient,'notice',s.nickname||'님에게 새 쪽지가 왔어요.','/me?tab=inbox&note='||note_id::text);
 return 'sent';
end; $$;
revoke all on function public.send_direct_note(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.send_direct_note(uuid,uuid,text,boolean) to service_role;
commit;
