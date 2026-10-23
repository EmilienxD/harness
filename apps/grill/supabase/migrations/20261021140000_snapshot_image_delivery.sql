drop function public.grill_snapshot_diagrams(uuid,text,text,jsonb,jsonb);
create or replace function public.grill_snapshot_diagrams(target_round uuid, target_prompt text, target_reason text, expected_revisions jsonb, target_images jsonb, target_snapshot uuid default gen_random_uuid())
returns setof public.grill_prompt_snapshots language plpgsql security invoker set search_path = public as $$
declare current_revisions jsonb; round_status text;
begin
  select status into round_status from public.grill_rounds where id = target_round for update;
  if round_status is null then raise exception 'stale_round'; end if;
  select coalesce(jsonb_object_agg(question_id || '/' || diagram_id, revision), '{}'::jsonb) into current_revisions
    from public.grill_diagram_scenes where round_id = target_round;
  if current_revisions <> expected_revisions then raise exception 'scene_conflict'; end if;
  if exists(select 1 from public.grill_prompt_snapshots where id = target_snapshot) then
    return query select * from public.grill_prompt_snapshots where id = target_snapshot and round_id = target_round and prompt = target_prompt;
    return;
  end if;
  return query insert into public.grill_prompt_snapshots(id, round_id, prompt, reason, images, diagram_revisions)
    values(target_snapshot, target_round, target_prompt, target_reason, target_images, current_revisions) returning *;
end;
$$;

-- Native Pi validates its active round and can recover its own claim after a
-- reconnect. Aboard owns asynchronous terminal submission for every provider;
-- it advertises exact sessions and must receive each pending delivery only once.
drop function public.grill_claim_deliveries(text, jsonb);
create function public.grill_claim_deliveries(target_instance text, target_sessions jsonb, target_native_pi boolean)
returns table(delivery_id uuid, provider text, session_id text, prompt text, round_id uuid)
language plpgsql security invoker set search_path = public as $$
begin
  return query
  with eligible as (
    select delivery.id
    from public.grill_deliveries delivery
    join public.grill_prompt_snapshots snapshot on snapshot.id = delivery.prompt_snapshot_id
    join public.grill_rounds round on round.id = snapshot.round_id
    join jsonb_to_recordset(target_sessions) as target(provider text, session_id text, active_round_id uuid, accepting boolean)
      on target.provider = delivery.provider and target.session_id = delivery.provider_session_id
    where delivery.expires_at > now()
      and (delivery.status = 'pending' or (target_native_pi and delivery.provider = 'pi' and delivery.status = 'claimed' and delivery.target_instance_id = target_instance))
      and (not target_native_pi or (delivery.provider = 'pi' and target.accepting = true and target.active_round_id = round.id and round.status = 'active'))
    order by delivery.created_at
    for update of delivery skip locked
  ), claimed as (
    update public.grill_deliveries delivery
    set status = 'claimed', target_instance_id = target_instance, claimed_at = coalesce(claimed_at, now())
    from eligible where delivery.id = eligible.id
    returning delivery.*
  )
  select claimed.id, claimed.provider, claimed.provider_session_id, snapshot.prompt, snapshot.round_id
  from claimed join public.grill_prompt_snapshots snapshot on snapshot.id = claimed.prompt_snapshot_id;
end;
$$;
revoke all on function public.grill_claim_deliveries(text,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.grill_claim_deliveries(text,jsonb,boolean) to service_role;

revoke all on function public.grill_snapshot_diagrams(uuid,text,text,jsonb,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.grill_snapshot_diagrams(uuid,text,text,jsonb,jsonb,uuid) to service_role;

-- Gestures have separate delivery IDs; a snapshot can be intentionally retried or resent on Pi.
drop index public.grill_pi_delivery_snapshot_unique;
-- Older Claude/Codex clients could have queued duplicates. Preserve the oldest claimed
-- delivery (or oldest pending one), retire other attempts visibly, and install the guard
-- under one lock so concurrent old clients cannot race index creation.
do $$
begin
  lock table public.grill_deliveries in share row exclusive mode;
  with ranked as (
    select id, row_number() over (partition by prompt_snapshot_id order by (status = 'claimed') desc, created_at, id) as position
    from public.grill_deliveries where status in ('pending', 'claimed')
  )
  update public.grill_deliveries set status = 'expired', completed_at = now(),
    failure_message = 'Duplicate active delivery retired during image delivery upgrade. Review and resend if needed.'
  where id in (select id from ranked where position > 1);
  create unique index grill_delivery_active_snapshot_unique on public.grill_deliveries(prompt_snapshot_id) where status in ('pending', 'claimed');
end;
$$;
