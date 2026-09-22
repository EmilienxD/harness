-- Delivery is now confirmed by the provider's own prompt-submit hook, so presence
-- only says that Aboard holds the exact session's terminal.
create or replace function public.grill_claim_deliveries(target_instance text, target_sessions jsonb)
returns table(delivery_id uuid, provider text, session_id text, prompt text)
language plpgsql security invoker set search_path = public as $$
begin
  return query
  with eligible as (
    select delivery.id
    from public.grill_deliveries delivery
    join jsonb_to_recordset(target_sessions) as target(provider text, session_id text)
      on target.provider = delivery.provider
      and target.session_id = delivery.provider_session_id
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

alter table public.grill_aboard_presence drop column terminal_state;
