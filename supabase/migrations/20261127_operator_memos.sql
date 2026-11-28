begin;
alter table public.reports add column if not exists operator_memo text not null default '';
alter table public.crisis_alerts add column if not exists operator_memo text not null default '';
commit;
