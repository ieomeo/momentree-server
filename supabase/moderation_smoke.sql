-- Staging only; run after the moderation migration. All fixture rows roll back.
begin;
do $$
declare owner_id uuid := gen_random_uuid(); mod_id uuid := gen_random_uuid();
  item_id uuid := gen_random_uuid(); first_id uuid := gen_random_uuid(); second_id uuid := gen_random_uuid();
begin
  insert into public.users(id,email,password_hash,nickname,nickname_key,role) values
    (owner_id,owner_id||'@example.invalid','fixture',owner_id::text,owner_id::text,'user'),
    (mod_id,mod_id||'@example.invalid','fixture',mod_id::text,mod_id::text,'admin');
  insert into public.posts(id,author_id,category,title,content) values(item_id,owner_id,'일기','fixture','fixture');
  insert into public.reports(id,target_type,target_id,target_preview,reason) values
    (first_id,'post',item_id,'fixture','기타'),(second_id,'post',item_id,'fixture','기타');
  perform public.earn_content_leaves(owner_id,'post',item_id,3,'글 작성',now());
  perform public.earn_content_leaves(owner_id,'post',item_id,1,'공감 받음',now());
  perform public.resolve_moderation(first_id,mod_id,'이용 제한',90,true);
  perform public.resolve_moderation(first_id,mod_id,'이용 제한',90,true);
  if (select leaves<>0 or restricted_until is null from public.users where id=owner_id) then raise exception 'initial moderation failed'; end if;
  if (select count(*)<>1 from public.moderation_history where report_id=first_id) then raise exception 'duplicate decision'; end if;
  perform public.resolve_moderation(second_id,mod_id,'경고 및 게시 중단',null,true);
  perform public.resolve_moderation(first_id,mod_id,'문제 없음',null,false);
  if (select not moderation_hidden from public.posts where id=item_id) then raise exception 'independent moderation lost'; end if;
  perform public.resolve_moderation(second_id,mod_id,'문제 없음',null,false);
  if (select leaves<>4 or restricted_until is not null from public.users where id=owner_id) then raise exception 'restore failed'; end if;
  if (select moderation_hidden from public.posts where id=item_id) then raise exception 'post restore failed'; end if;
end $$;
rollback;
