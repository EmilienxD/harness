-- Ten access attempts, then one further attempt every thirty minutes.
create table public.grill_access_bucket (
  id boolean primary key default true check (id),
  tokens integer not null default 10 check (tokens >= 0 and tokens <= 10),
  refilled_at timestamptz not null default now()
);

insert into public.grill_access_bucket (id) values (true) on conflict (id) do nothing;

alter table public.grill_access_bucket enable row level security;
revoke all on table public.grill_access_bucket from public, anon, authenticated;
grant select, insert, update, delete on table public.grill_access_bucket to service_role;

create or replace function public.grill_take_access_attempt()
returns integer language plpgsql security invoker set search_path = public as $$
declare
  bucket public.grill_access_bucket%rowtype;
  earned integer;
  available integer;
begin
  insert into public.grill_access_bucket (id) values (true) on conflict (id) do nothing;
  select * into bucket from public.grill_access_bucket where id for update;
  earned := greatest(0, floor(extract(epoch from (now() - bucket.refilled_at)) / 1800)::integer);
  available := least(10, bucket.tokens + earned);
  if available <= 0 then
    return -1;
  end if;
  update public.grill_access_bucket
  set tokens = available - 1,
      -- A full bucket restarts the clock; otherwise only whole earned periods are consumed.
      refilled_at = case
        when bucket.tokens + earned >= 10 then now()
        else bucket.refilled_at + make_interval(secs => earned * 1800)
      end
  where id;
  return available - 1;
end;
$$;
revoke all on function public.grill_take_access_attempt() from public, anon, authenticated;
grant execute on function public.grill_take_access_attempt() to service_role;

create or replace function public.grill_reset_access_attempts()
returns void language sql security invoker set search_path = public as $$
  update public.grill_access_bucket set tokens = 10, refilled_at = now() where id;
$$;
revoke all on function public.grill_reset_access_attempts() from public, anon, authenticated;
grant execute on function public.grill_reset_access_attempts() to service_role;
