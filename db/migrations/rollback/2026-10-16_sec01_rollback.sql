-- ROLLBACK SEC-01 — removes the identity helpers and execution-context
-- functions. Roll back SEC-04, SEC-03 and SEC-02 first.
-- KEPT on purpose: public.audit_events (the audit history, still append-only),
-- app_private.deny_change() (its guard), and the additive columns
-- users.active, versions.approved_by / archived_at / archived_by (they hold
-- approval attribution; older code ignores them).
-- Runs in one transaction: on any error nothing is changed.
begin;
drop policy if exists audit_events_admin_read on public.audit_events;
drop function if exists app_private.require_member();
drop function if exists app_private.audit(text, text, uuid, uuid, jsonb);
drop function if exists app_private.set_ctx(text);
drop function if exists app_private.ctx();
drop function if exists public.app_has_role(text[]);
drop function if exists public.app_role();
drop function if exists public.app_tenant_id();
-- default privileges as in the production baseline
alter default privileges for role postgres grant execute on functions to public;
alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated;
alter default privileges for role postgres in schema public grant all on tables to anon;
alter default privileges for role postgres in schema public grant truncate, trigger, references on tables to authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon;
-- current_tenant_id() as in the production baseline (unchanged body)
create or replace function public.current_tenant_id() returns uuid
  language sql stable security definer as $$
  select tenant_id from users where user_id = auth.uid()
$$;
alter function public.current_tenant_id() reset search_path;
grant execute on function public.current_tenant_id() to anon, authenticated, service_role;
commit;
