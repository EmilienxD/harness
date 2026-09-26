alter table public.grill_sessions
  add column finished_at timestamptz;

-- Every existing session is unfinished, including ones whose old rolling deadline passed.
alter table public.grill_sessions
  alter column expires_at drop not null,
  alter column expires_at drop default;
update public.grill_sessions set expires_at = null;

alter table public.grill_sessions
  add constraint grill_sessions_finished_expiry_check
  check ((finished_at is null) = (expires_at is null));

create or replace function public.grill_touch_session(target_session uuid)
returns void language sql security invoker set search_path = public as $$
  update public.grill_sessions
  set last_activity_at = now()
  where id = target_session;
$$;

create or replace function public.grill_set_session_finished(target_session uuid, is_finished boolean)
returns void language sql security invoker set search_path = public as $$
  update public.grill_sessions
  set finished_at = case when is_finished then now() else null end,
      expires_at = case when is_finished then now() + interval '30 days' else null end
  where id = target_session;
$$;
revoke all on function public.grill_set_session_finished(uuid, boolean) from public, anon, authenticated;
grant execute on function public.grill_set_session_finished(uuid, boolean) to service_role;

-- A new published round means the conversation resumed.
create or replace function public.grill_reopen_session_on_new_round()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  update public.grill_sessions
  set finished_at = null, expires_at = null
  where id = new.session_id and finished_at is not null;
  return new;
end;
$$;
create trigger grill_reopen_session_on_new_round
after insert on public.grill_rounds
for each row execute function public.grill_reopen_session_on_new_round();

drop index public.grill_sessions_expiry_idx;
create index grill_sessions_expiry_idx on public.grill_sessions(expires_at) where finished_at is not null;
