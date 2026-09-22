create extension if not exists pgcrypto;

create table public.grill_sessions (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('claude', 'chatgpt')),
  provider_session_id text not null,
  display_title text,
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  unique (provider, provider_session_id)
);

create table public.grill_publications (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('claude', 'chatgpt')),
  provider_session_id text not null,
  idempotency_key text not null,
  content_fingerprint text not null,
  schema_version integer not null check (schema_version = 1),
  original_payload jsonb not null,
  asset_manifest jsonb not null default '[]'::jsonb,
  status text not null default 'prepared' check (status in ('prepared', 'uploading', 'committed', 'failed', 'expired')),
  committed_round_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_session_id, idempotency_key)
);

create table public.grill_rounds (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.grill_sessions(id) on delete cascade,
  number integer not null check (number > 0),
  schema_version integer not null check (schema_version = 1),
  payload jsonb not null,
  status text not null check (status in ('active', 'superseded')),
  committed_publication_id uuid not null unique references public.grill_publications(id),
  additional_context text not null default '',
  additional_context_updated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (session_id, number)
);

alter table public.grill_publications
  add constraint grill_publications_round_fk foreign key (committed_round_id) references public.grill_rounds(id);

create unique index grill_rounds_one_active_per_session on public.grill_rounds(session_id) where status = 'active';

create table public.grill_round_assets (
  id uuid primary key,
  round_id uuid not null references public.grill_rounds(id) on delete cascade,
  original_reference text not null,
  object_path text not null unique,
  media_type text not null,
  byte_size bigint not null check (byte_size > 0),
  sha256 text not null,
  created_at timestamptz not null default now()
);

create table public.grill_answer_drafts (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.grill_rounds(id) on delete cascade,
  question_id text not null,
  selected_option text,
  note text,
  state text not null check (state in ('draft', 'queued')),
  updated_at timestamptz not null default now(),
  queued_at timestamptz,
  unique (round_id, question_id)
);

create table public.grill_prompt_snapshots (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.grill_rounds(id) on delete cascade,
  prompt text not null,
  reason text not null check (reason in ('copy', 'aboard')),
  created_at timestamptz not null default now()
);

create table public.grill_aboard_presence (
  instance_id text not null,
  provider text not null check (provider in ('claude', 'chatgpt')),
  provider_session_id text not null,
  terminal_state text not null check (terminal_state in ('running', 'awaiting-user')),
  last_heartbeat_at timestamptz not null default now(),
  primary key (instance_id, provider, provider_session_id)
);

create table public.grill_deliveries (
  id uuid primary key default gen_random_uuid(),
  prompt_snapshot_id uuid not null references public.grill_prompt_snapshots(id) on delete cascade,
  provider text not null check (provider in ('claude', 'chatgpt')),
  provider_session_id text not null,
  target_instance_id text,
  status text not null default 'pending' check (status in ('pending', 'claimed', 'submitted-to-terminal', 'failed', 'expired')),
  failure_message text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 seconds')
);

create index grill_sessions_activity_idx on public.grill_sessions(last_activity_at desc);
create index grill_sessions_expiry_idx on public.grill_sessions(expires_at);
create index grill_rounds_session_idx on public.grill_rounds(session_id, number desc);
create index grill_publications_round_idx on public.grill_publications(committed_round_id) where committed_round_id is not null;
create index grill_assets_round_idx on public.grill_round_assets(round_id);
create index grill_answers_round_idx on public.grill_answer_drafts(round_id);
create index grill_snapshots_round_idx on public.grill_prompt_snapshots(round_id, created_at desc);
create index grill_publications_expiry_idx on public.grill_publications(status, created_at);
create index grill_presence_session_idx on public.grill_aboard_presence(provider, provider_session_id, last_heartbeat_at desc);
create index grill_presence_expiry_idx on public.grill_aboard_presence(last_heartbeat_at);
create index grill_deliveries_claim_idx on public.grill_deliveries(status, expires_at, provider, provider_session_id);
create index grill_deliveries_snapshot_idx on public.grill_deliveries(prompt_snapshot_id);
create index grill_deliveries_pending_session_idx on public.grill_deliveries(provider, provider_session_id, created_at) where status = 'pending';

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'grill_sessions', 'grill_publications', 'grill_rounds', 'grill_round_assets',
    'grill_answer_drafts', 'grill_prompt_snapshots', 'grill_aboard_presence', 'grill_deliveries'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
  end loop;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'grill-assets', 'grill-assets', false, 6291456,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.grill_touch_session(target_session uuid)
returns void language sql security invoker set search_path = public as $$
  update public.grill_sessions
  set last_activity_at = now(), expires_at = now() + interval '30 days'
  where id = target_session;
$$;
revoke all on function public.grill_touch_session(uuid) from public, anon, authenticated;
grant execute on function public.grill_touch_session(uuid) to service_role;

create or replace function public.grill_commit_publication(
  target_publication uuid,
  target_title text,
  rewritten_payload jsonb,
  assets jsonb
) returns table(round_id uuid, round_number integer, session_id uuid)
language plpgsql security invoker set search_path = public as $$
declare
  publication public.grill_publications%rowtype;
  grill_session public.grill_sessions%rowtype;
  next_number integer;
  new_round uuid;
  asset jsonb;
begin
  select * into publication from public.grill_publications where id = target_publication for update;
  if not found then raise exception 'publication_not_found'; end if;
  if publication.status = 'committed' then
    return query select round.id, round.number, round.session_id from public.grill_rounds round where round.id = publication.committed_round_id;
    return;
  end if;
  if publication.status not in ('prepared', 'uploading') then raise exception 'publication_not_committable'; end if;

  insert into public.grill_sessions(provider, provider_session_id, display_title)
  values (publication.provider, publication.provider_session_id, nullif(target_title, ''))
  on conflict (provider, provider_session_id) do update
    set display_title = coalesce(nullif(excluded.display_title, ''), public.grill_sessions.display_title)
  returning * into grill_session;
  select session_row.* into grill_session
  from public.grill_sessions session_row
  where session_row.id = grill_session.id
  for update;

  select coalesce(max(round.number), 0) + 1 into next_number
  from public.grill_rounds round where round.session_id = grill_session.id;
  update public.grill_rounds set status = 'superseded'
  where public.grill_rounds.session_id = grill_session.id and status = 'active';
  insert into public.grill_rounds(session_id, number, schema_version, payload, status, committed_publication_id)
  values (grill_session.id, next_number, publication.schema_version, rewritten_payload, 'active', publication.id)
  returning id into new_round;

  for asset in select * from jsonb_array_elements(assets) loop
    insert into public.grill_round_assets(id, round_id, original_reference, object_path, media_type, byte_size, sha256)
    values ((asset->>'id')::uuid, new_round, asset->>'original_reference', asset->>'object_path', asset->>'media_type', (asset->>'byte_size')::bigint, asset->>'sha256');
  end loop;

  update public.grill_publications set status = 'committed', committed_round_id = new_round, updated_at = now() where id = publication.id;
  perform public.grill_touch_session(grill_session.id);
  return query select new_round, next_number, grill_session.id;
end;
$$;
revoke all on function public.grill_commit_publication(uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.grill_commit_publication(uuid, text, jsonb, jsonb) to service_role;

create or replace function public.grill_claim_deliveries(target_instance text, target_sessions jsonb)
returns table(delivery_id uuid, provider text, session_id text, prompt text)
language plpgsql security invoker set search_path = public as $$
begin
  return query
  with eligible as (
    select delivery.id
    from public.grill_deliveries delivery
    join jsonb_to_recordset(target_sessions) as target(provider text, session_id text, state text)
      on target.provider = delivery.provider
      and target.session_id = delivery.provider_session_id
      and target.state = 'awaiting-user'
    where delivery.status = 'pending' and delivery.expires_at > now()
    order by delivery.created_at
    for update of delivery skip locked
  ), claimed as (
    update public.grill_deliveries delivery
    set status = 'claimed', target_instance_id = target_instance, claimed_at = now()
    from eligible
    where delivery.id = eligible.id
    returning delivery.*
  )
  select claimed.id, claimed.provider, claimed.provider_session_id, snapshot.prompt
  from claimed join public.grill_prompt_snapshots snapshot on snapshot.id = claimed.prompt_snapshot_id;
end;
$$;
revoke all on function public.grill_claim_deliveries(text, jsonb) from public, anon, authenticated;
grant execute on function public.grill_claim_deliveries(text, jsonb) to service_role;

revoke execute on all functions in schema public from public, anon, authenticated;
