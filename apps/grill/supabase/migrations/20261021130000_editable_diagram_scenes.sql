create table public.grill_diagram_scenes (
  round_id uuid not null references public.grill_rounds(id) on delete cascade,
  question_id text not null,
  diagram_id text not null,
  source text not null,
  source_sha256 text not null,
  baseline jsonb not null,
  scene jsonb not null,
  image_fallback boolean not null,
  revision text not null,
  updated_at timestamptz not null default now(),
  primary key (round_id, question_id, diagram_id)
);
alter table public.grill_diagram_scenes enable row level security;
revoke all on public.grill_diagram_scenes from public, anon, authenticated;
grant select, insert, update, delete on public.grill_diagram_scenes to service_role;

create function public.grill_preserve_diagram_baseline() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.baseline is distinct from old.baseline or new.source is distinct from old.source
    or new.source_sha256 is distinct from old.source_sha256 or new.image_fallback is distinct from old.image_fallback
    or new.round_id is distinct from old.round_id or new.question_id is distinct from old.question_id or new.diagram_id is distinct from old.diagram_id
  then raise exception 'immutable_diagram_baseline'; end if;
  return new;
end;
$$;
create trigger grill_diagram_baseline before update on public.grill_diagram_scenes
for each row execute function public.grill_preserve_diagram_baseline();

alter table public.grill_round_assets
  add column question_id text,
  add column diagram_id text,
  add column scene_revision text;
create unique index grill_diagram_image_revision on public.grill_round_assets(round_id, question_id, diagram_id, scene_revision)
where scene_revision is not null;
alter table public.grill_prompt_snapshots
  add column images jsonb not null default '[]'::jsonb,
  add column diagram_revisions jsonb not null default '{}'::jsonb;

create function public.grill_save_diagram(target_round uuid, target_question text, target_diagram text,
  target_source text, target_source_sha256 text, target_baseline jsonb, target_scene jsonb,
  target_image_fallback boolean, target_revision text, expected_revision text)
returns setof public.grill_diagram_scenes language plpgsql security invoker set search_path = public as $$
declare old_scene public.grill_diagram_scenes%rowtype; round_status text;
begin
  select status into round_status from public.grill_rounds where id = target_round for update;
  if round_status is distinct from 'active' then raise exception 'stale_round'; end if;
  select * into old_scene from public.grill_diagram_scenes
    where round_id = target_round and question_id = target_question and diagram_id = target_diagram for update;
  if old_scene.revision is distinct from expected_revision then raise exception 'scene_conflict'; end if;
  if old_scene.source is not null and old_scene.source <> target_source then raise exception 'source_conflict'; end if;
  insert into public.grill_diagram_scenes(round_id, question_id, diagram_id, source, source_sha256, baseline, scene, image_fallback, revision)
  values(target_round, target_question, target_diagram, target_source, target_source_sha256, target_baseline, target_scene, target_image_fallback, target_revision)
  on conflict (round_id, question_id, diagram_id) do update set scene = excluded.scene, revision = excluded.revision, updated_at = now();
  return query select * from public.grill_diagram_scenes where round_id = target_round and question_id = target_question and diagram_id = target_diagram;
end;
$$;

create function public.grill_snapshot_diagrams(target_round uuid, target_prompt text, target_reason text, expected_revisions jsonb, target_images jsonb)
returns setof public.grill_prompt_snapshots language plpgsql security invoker set search_path = public as $$
declare current_revisions jsonb; round_status text;
begin
  select status into round_status from public.grill_rounds where id = target_round for update;
  if round_status is distinct from 'active' then raise exception 'stale_round'; end if;
  select coalesce(jsonb_object_agg(question_id || '/' || diagram_id, revision), '{}'::jsonb) into current_revisions
    from public.grill_diagram_scenes where round_id = target_round;
  if current_revisions <> expected_revisions then raise exception 'scene_conflict'; end if;
  return query insert into public.grill_prompt_snapshots(round_id, prompt, reason, images, diagram_revisions)
    values(target_round, target_prompt, target_reason, target_images, current_revisions) returning *;
end;
$$;
revoke all on function public.grill_preserve_diagram_baseline() from public, anon, authenticated;
revoke all on function public.grill_save_diagram(uuid,text,text,text,text,jsonb,jsonb,boolean,text,text) from public, anon, authenticated;
revoke all on function public.grill_snapshot_diagrams(uuid,text,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.grill_save_diagram(uuid,text,text,text,text,jsonb,jsonb,boolean,text,text) to service_role;
grant execute on function public.grill_snapshot_diagrams(uuid,text,text,jsonb,jsonb) to service_role;
