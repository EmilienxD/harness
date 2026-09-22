-- The board no longer offers a free-text context field; the prompt is compiled
-- from queued answers alone.
alter table public.grill_rounds drop column if exists additional_context;
alter table public.grill_rounds drop column if exists additional_context_updated_at;
