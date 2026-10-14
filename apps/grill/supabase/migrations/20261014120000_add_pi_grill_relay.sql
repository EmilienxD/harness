-- Add Pi without changing existing provider identities or Aboard's terminal contract.
alter table public.grill_sessions drop constraint grill_sessions_provider_check;
alter table public.grill_sessions add constraint grill_sessions_provider_check check (provider in ('claude', 'chatgpt', 'pi'));
alter table public.grill_publications drop constraint grill_publications_provider_check;
alter table public.grill_publications add constraint grill_publications_provider_check check (provider in ('claude', 'chatgpt', 'pi'));
alter table public.grill_aboard_presence drop constraint grill_aboard_presence_provider_check;
alter table public.grill_aboard_presence add constraint grill_aboard_presence_provider_check check (provider in ('claude', 'chatgpt', 'pi'));
alter table public.grill_deliveries drop constraint grill_deliveries_provider_check;
alter table public.grill_deliveries add constraint grill_deliveries_provider_check check (provider in ('claude', 'chatgpt', 'pi'));

drop function public.grill_claim_deliveries(text, jsonb);
create function public.grill_claim_deliveries(target_instance text, target_sessions jsonb)
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
      and (delivery.status = 'pending' or (delivery.provider = 'pi' and delivery.status = 'claimed' and delivery.target_instance_id = target_instance))
      and (delivery.provider <> 'pi' or (target.accepting = true and target.active_round_id = round.id and round.status = 'active'))
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
revoke all on function public.grill_claim_deliveries(text, jsonb) from public, anon, authenticated;
grant execute on function public.grill_claim_deliveries(text, jsonb) to service_role;

create unique index grill_pi_delivery_snapshot_unique on public.grill_deliveries(prompt_snapshot_id) where provider = 'pi';
