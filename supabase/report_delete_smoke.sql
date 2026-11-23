-- Staging only. Requires 20261120_report_delete.sql; fixture is rolled back.
begin;
do $$
declare owner_id uuid := gen_random_uuid(); admin_id uuid := gen_random_uuid();
  deleted_id uuid := gen_random_uuid(); kept_id uuid := gen_random_uuid();
  report_id uuid := gen_random_uuid(); unchanged_until timestamptz := now()+interval '1 day';
begin
  insert into public.users(id,email,password_hash,nickname,nickname_key,role,restricted_until) values
    (owner_id,owner_id||'@example.invalid','fixture',owner_id::text,owner_id::text,'user',unchanged_until),
    (admin_id,admin_id||'@example.invalid','fixture',admin_id::text,admin_id::text,'admin',null);
  insert into public.posts(id,author_id,category,title,content) values
    (deleted_id,owner_id,'일기','delete','fixture'),(kept_id,owner_id,'일기','keep','fixture');
  insert into public.reports(id,target_type,target_id,target_preview,reason) values(report_id,'post',deleted_id,'fixture','기타');
  perform public.earn_content_leaves(owner_id,'post',deleted_id,3,'글 작성',now());
  perform public.earn_content_leaves(owner_id,'post',kept_id,3,'글 작성',now());
  perform public.warn_and_delete_report_target(report_id,admin_id);
  perform public.warn_and_delete_report_target(report_id,admin_id);
  if exists(select 1 from public.posts where id=deleted_id) or not exists(select 1 from public.posts where id=kept_id) then raise exception 'wrong posts removed'; end if;
  if (select count(*)<>1 from public.notifications where user_id=owner_id and type='warning') then raise exception 'warning count'; end if;
  if (select leaves<>3 or restricted_until is distinct from unchanged_until from public.users where id=owner_id) then raise exception 'wrong balance or account restriction'; end if;
  if not exists(select 1 from public.reports where id=report_id and status='done' and moderation_deleted) then raise exception 'report not closed'; end if;
end $$;
rollback;
