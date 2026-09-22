alter table public.grill_sessions
  add column project_name text,
  add column project_path text;

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

  insert into public.grill_sessions(provider, provider_session_id, display_title, project_name, project_path)
  values (
    publication.provider,
    publication.provider_session_id,
    nullif(target_title, ''),
    nullif(publication.original_payload->'project'->>'name', ''),
    nullif(publication.original_payload->'project'->>'path', '')
  )
  on conflict (provider, provider_session_id) do update set
    display_title = coalesce(nullif(excluded.display_title, ''), public.grill_sessions.display_title),
    project_name = coalesce(public.grill_sessions.project_name, nullif(excluded.project_name, '')),
    project_path = coalesce(public.grill_sessions.project_path, nullif(excluded.project_path, ''))
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
