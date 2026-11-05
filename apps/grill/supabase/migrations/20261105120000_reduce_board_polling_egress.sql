-- Poll a constant-size revision instead of transferring every session's question HTML.
create table public.grill_board_clock (
  singleton boolean primary key default true check (singleton),
  revision bigint not null default 0
);
insert into public.grill_board_clock(singleton) values (true);
alter table public.grill_board_clock enable row level security;
revoke all on public.grill_board_clock from public, anon, authenticated;
grant select, update on public.grill_board_clock to service_role;

create function public.grill_advance_board_clock()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  update public.grill_board_clock set revision = revision + 1 where singleton;
  return null;
end;
$$;
revoke all on function public.grill_advance_board_clock() from public, anon, authenticated;
grant execute on function public.grill_advance_board_clock() to service_role;

-- Row triggers do not advance the clock for the relay's frequent zero-row expiry updates.
-- Presence heartbeats are deliberately excluded: only a change in online identities matters.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'grill_sessions', 'grill_rounds', 'grill_answer_drafts', 'grill_round_assets',
    'grill_prompt_snapshots', 'grill_deliveries', 'grill_diagram_scenes'
  ] loop
    execute format(
      'create trigger grill_board_changed after insert or update or delete on public.%I
       for each row execute function public.grill_advance_board_clock()', table_name);
  end loop;
end $$;

create function public.grill_board_changes()
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'content', (select revision::text from public.grill_board_clock where singleton),
    'presence', md5(coalesce((
      select string_agg(jsonb_build_array(provider, provider_session_id, workspace_name, workspace_path)::text,
                        ',' order by provider, provider_session_id)
      from (
        select distinct on (provider, provider_session_id)
          provider, provider_session_id, workspace_name, workspace_path
        from public.grill_aboard_presence
        where last_heartbeat_at >= now() - interval '15 seconds'
        order by provider, provider_session_id, last_heartbeat_at desc, instance_id
      ) online
    ), ''))
  );
$$;
revoke all on function public.grill_board_changes() from public, anon, authenticated;
grant execute on function public.grill_board_changes() to service_role;

-- Compute counts inside Postgres. Neither HTML nor answer notes cross PostgREST for the rail.
create view public.grill_session_summaries with (security_invoker = true) as
select s.id, s.provider, s.provider_session_id, s.display_title, s.project_name, s.project_path,
       s.last_activity_at, s.finished_at, s.expires_at,
       r.id as active_round_id, r.number as active_round_number,
       coalesce(jsonb_array_length(r.payload->'questions'), 0) as question_count,
       (select count(*)::integer from public.grill_answer_drafts a
        where a.round_id = r.id and a.state = 'queued'
          and exists (select 1 from jsonb_array_elements(r.payload->'questions') q
                      where q->>'id' = a.question_id)) as answered_count
from public.grill_sessions s
left join public.grill_rounds r on r.session_id = s.id and r.status = 'active';
revoke all on public.grill_session_summaries from public, anon, authenticated;
grant select on public.grill_session_summaries to service_role;

-- Autosave validation needs identities and option letters, never explanation HTML.
create view public.grill_round_answer_options with (security_invoker = true) as
select r.id, r.status, r.session_id, jsonb_build_object('questions', (
  select jsonb_agg(jsonb_build_object('id', q->>'id', 'options', (
    select jsonb_agg(jsonb_build_object('letter', o->>'letter'))
    from jsonb_array_elements(q->'options') o
  ))) from jsonb_array_elements(r.payload->'questions') q
)) as payload
from public.grill_rounds r;
revoke all on public.grill_round_answer_options from public, anon, authenticated;
grant select on public.grill_round_answer_options to service_role;

-- A relay heartbeat used to make four HTTP database calls even with nothing to deliver.
-- Keep presence, expiry, claims and acknowledgements in one transaction and one tiny response.
create function public.grill_sync(target_input jsonb, target_native_pi boolean)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  instance text := target_input->>'instance_id';
  sessions jsonb := target_input->'sessions';
  acknowledgement jsonb;
  delivery public.grill_deliveries%rowtype;
  result jsonb;
begin
  update public.grill_deliveries set status = 'expired', completed_at = now()
  where status in ('pending', 'claimed') and expires_at <= now();

  insert into public.grill_aboard_presence(
    instance_id, provider, provider_session_id, workspace_name, workspace_path, last_heartbeat_at
  )
  select instance, target.provider, target.session_id,
         target_input->'workspace'->>'name', target_input->'workspace'->>'path', now()
  from jsonb_to_recordset(sessions) as target(provider text, session_id text)
  on conflict (instance_id, provider, provider_session_id) do update
    set workspace_name = excluded.workspace_name, workspace_path = excluded.workspace_path,
        last_heartbeat_at = excluded.last_heartbeat_at;
  delete from public.grill_aboard_presence
  where instance_id = instance and last_heartbeat_at < now();

  for acknowledgement in select * from jsonb_array_elements(target_input->'acknowledgements') loop
    select * into delivery from public.grill_deliveries
    where id = (acknowledgement->>'delivery_id')::uuid and target_instance_id = instance
    for update;
    if found and (delivery.status = 'claimed' or
        (target_native_pi and delivery.provider = 'pi' and delivery.status = 'expired'
         and acknowledgement->>'status' = 'submitted-to-terminal')) then
      update public.grill_deliveries
      set status = acknowledgement->>'status', completed_at = now(),
          failure_message = case when acknowledgement->>'status' = 'failed'
            then coalesce(acknowledgement->>'failure_message', 'Terminal submission failed') else null end
      where id = delivery.id;
      update public.grill_sessions set last_activity_at = now()
      where provider = delivery.provider and provider_session_id = delivery.provider_session_id;
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'delivery_id', claimed.delivery_id, 'provider', claimed.provider,
    'session_id', claimed.session_id, 'prompt', claimed.prompt, 'round_id', claimed.round_id,
    'snapshot_id', snapshot.id, 'expires_at', d.expires_at,
    'images', snapshot.images, 'diagram_revisions', snapshot.diagram_revisions
  )), '[]'::jsonb) into result
  from public.grill_claim_deliveries(instance, sessions, target_native_pi) claimed
  join public.grill_deliveries d on d.id = claimed.delivery_id
  join public.grill_prompt_snapshots snapshot on snapshot.id = d.prompt_snapshot_id;
  return jsonb_build_object('deliveries', result);
end;
$$;
revoke all on function public.grill_sync(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.grill_sync(jsonb, boolean) to service_role;
