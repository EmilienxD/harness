do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'grill_sessions', 'grill_publications', 'grill_rounds', 'grill_round_assets',
    'grill_answer_drafts', 'grill_prompt_snapshots', 'grill_aboard_presence', 'grill_deliveries', 'grill_diagram_scenes'
  ] loop
    if not (select relrowsecurity from pg_class where oid = format('public.%I', table_name)::regclass) then
      raise exception 'RLS is disabled for %', table_name;
    end if;
    if has_table_privilege('anon', format('public.%I', table_name), 'select')
      or has_table_privilege('authenticated', format('public.%I', table_name), 'select') then
      raise exception 'Direct client read access is enabled for %', table_name;
    end if;
  end loop;
  if not exists (select 1 from storage.buckets where id = 'grill-assets' and public = false) then
    raise exception 'grill-assets must exist and remain private';
  end if;
  if not exists (
    select 1 from storage.buckets where id = 'grill-assets'
      and file_size_limit = 20971520
      and allowed_mime_types @> array['video/mp4', 'video/webm']::text[]
  ) then
    raise exception 'grill-assets needs the video asset migration';
  end if;
  if not exists (select 1 from information_schema.columns col where col.table_schema = 'public' and col.table_name = 'grill_prompt_snapshots' and column_name = 'diagram_revisions')
    or not exists (select 1 from information_schema.columns col where col.table_schema = 'public' and col.table_name = 'grill_round_assets' and column_name = 'scene_revision')
    or not exists (select 1 from pg_trigger where tgname = 'grill_diagram_baseline' and not tgisinternal) then
    raise exception 'Editable diagrams need the scene and snapshot migration';
  end if;
end $$;

select public.grill_touch_session(gen_random_uuid());
