begin;
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
 gain := case when p_label = '공감 받음' then p_amount else least(p_amount,20-tally) end;
 if gain<=0 then return; end if;
 if p_label = '공감 받음' then
   update public.users set leaves=leaves+gain where id=p_user;
 else
   update public.users set leaves=leaves+gain,earned_today=tally+gain,earned_date=day_utc where id=p_user;
 end if;
 insert into public.leaf_logs(id,user_id,type,label,amount,source_type,source_id,created_at)
 values(gen_random_uuid(),p_user,'earn',p_label,gain,p_source_type,p_source_id,p_now);
end;
$$;
revoke all on function public.earn_content_leaves(uuid,text,uuid,integer,text,timestamptz) from public,anon,authenticated;
grant execute on function public.earn_content_leaves(uuid,text,uuid,integer,text,timestamptz) to service_role;
-- Recount today's writing rewards only; do not change balances or historical logs.
with bounds as (
 select date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' as start_at
), totals as (
 select l.user_id, least(20,sum(l.amount))::integer as writing_total
 from public.leaf_logs l cross join bounds b
 where l.type='earn' and l.label in ('글 작성','댓글 작성')
 and l.created_at >= b.start_at and l.created_at < b.start_at + interval '24 hours'
 group by l.user_id
)
update public.users u set earned_today=coalesce(t.writing_total,0)
from public.users src left join totals t on t.user_id=src.id
where u.id=src.id and u.earned_date=(now() at time zone 'UTC')::date;
commit;
