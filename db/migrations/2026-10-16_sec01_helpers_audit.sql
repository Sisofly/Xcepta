-- SEC-01 — security foundations (ADDITIVE; safe with the currently deployed app)
-- ---------------------------------------------------------------------------
-- Requires: P-022 (2026-10-10_p022_versioned_model_outputs.sql).
-- Adds:
--   • users.active, versions.approved_by / archived_at / archived_by (nullable or defaulted)
--   • schema app_private (NOT exposed through the Supabase REST API): internal
--     helpers — execution context, audit writer, membership check
--   • public.app_tenant_id(), app_role(), app_has_role() — caller identity, read
--     server-side from auth.uid() (never from client input)
--   • public.audit_events — append-only audit trail, no foreign keys (nothing
--     can cascade into it)
-- Every SECURITY DEFINER function: owner postgres, search_path = '' (all names
-- schema-qualified), EXECUTE revoked from PUBLIC/anon and granted explicitly.
-- Supabase's default privileges grant EXECUTE on new public functions to anon
-- and authenticated; this file revokes that for every function it creates.
-- Idempotent. Rollback: db/migrations/rollback/2026-10-16_sec01_rollback.sql
-- ---------------------------------------------------------------------------

alter table public.users    add column if not exists active boolean not null default true;
alter table public.versions add column if not exists approved_by uuid,
                            add column if not exists archived_at timestamptz,
                            add column if not exists archived_by uuid;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated, service_role;
alter default privileges in schema app_private revoke execute on functions from public;

-- ── Execution context ──────────────────────────────────────────────────────
-- A transaction-local marker set ONLY inside the lifecycle / admin functions
-- below. The protection triggers (SEC-02, SEC-04) allow privileged changes
-- only when it is set. Clients cannot set it: the REST API runs no arbitrary
-- SQL and app_private is not exposed.
create or replace function app_private.set_ctx(p_ctx text) returns void
  language sql volatile set search_path = '' as $$ select pg_catalog.set_config('xcepta.ctx', p_ctx, true) $$;
create or replace function app_private.ctx() returns text
  language sql stable set search_path = '' as $$ select coalesce(pg_catalog.current_setting('xcepta.ctx', true), '') $$;

-- ── Caller identity (server-side) ─────────────────────────────────────────
-- Inactive members have no tenant and no role.
create or replace function public.app_tenant_id() returns uuid
  language sql stable security definer set search_path = '' as $$
  select u.tenant_id from public.users u where u.user_id = auth.uid() and u.active $$;
create or replace function public.app_role() returns text
  language sql stable security definer set search_path = '' as $$
  select u.role from public.users u where u.user_id = auth.uid() and u.active $$;
create or replace function public.app_has_role(p_roles text[]) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(public.app_role() = any (p_roles), false) $$;
-- Existing helper, hardened (search_path) with unchanged behaviour.
create or replace function public.current_tenant_id() returns uuid
  language sql stable security definer set search_path = '' as $$
  select u.tenant_id from public.users u where u.user_id = auth.uid() $$;

-- ── Audit trail (append-only) ─────────────────────────────────────────────
create table if not exists public.audit_events (
  event_id  uuid primary key default gen_random_uuid(),
  at        timestamptz not null default now(),
  actor     uuid,                       -- auth.uid() of the caller (null for operator/service role)
  db_role   text not null,              -- requesting role (authenticated / service_role)
  tenant_id uuid,
  action    text not null,
  entity    text not null,
  entity_id uuid,
  details   jsonb not null default '{}'::jsonb
);
alter table public.audit_events enable row level security;
revoke all on public.audit_events from public, anon, authenticated, service_role;
grant select on public.audit_events to authenticated, service_role;
drop policy if exists audit_events_admin_read on public.audit_events;
create policy audit_events_admin_read on public.audit_events for select to authenticated
  using (tenant_id = public.app_tenant_id() and public.app_has_role(array['admin']));

create or replace function app_private.audit(p_action text, p_entity text, p_entity_id uuid, p_tenant uuid, p_details jsonb)
  returns void language sql volatile security definer set search_path = '' as $$
  insert into public.audit_events (actor, db_role, tenant_id, action, entity, entity_id, details)
  values (auth.uid(), coalesce(auth.role(), 'unknown'), p_tenant, p_action, p_entity, p_entity_id, coalesce(p_details, '{}'::jsonb)) $$;

-- Append-only: no UPDATE / DELETE / TRUNCATE by anyone, including the service
-- role and the lifecycle functions (they only INSERT).
create or replace function app_private.deny_change() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'audit_events' then
    raise exception using errcode = '42501', message = 'AUDIT_APPEND_ONLY: audit records cannot be changed or deleted';
  end if;
  raise exception using errcode = '42501', message = 'RECORD_PROTECTED: ' || tg_table_name || ' cannot be truncated';
end $$;
drop trigger if exists audit_events_append_only on public.audit_events;
create trigger audit_events_append_only before update or delete on public.audit_events
  for each row execute function app_private.deny_change();
drop trigger if exists audit_events_no_truncate on public.audit_events;
create trigger audit_events_no_truncate before truncate on public.audit_events
  for each statement execute function app_private.deny_change();

-- ── Membership check used by every lifecycle / admin function ──────────────
create or replace function app_private.require_member() returns void
  language plpgsql stable set search_path = '' as $$
begin
  if auth.uid() is null or public.app_tenant_id() is null then
    raise exception using errcode = '42501', message = 'NOT_AUTHENTICATED: no active XCEPTA membership';
  end if;
end $$;

-- ── Ownership and grants ──────────────────────────────────────────────────
alter function app_private.set_ctx(text) owner to postgres;
alter function app_private.ctx() owner to postgres;
alter function app_private.audit(text, text, uuid, uuid, jsonb) owner to postgres;
alter function app_private.deny_change() owner to postgres;
alter function app_private.require_member() owner to postgres;
alter function public.app_tenant_id() owner to postgres;
alter function public.app_role() owner to postgres;
alter function public.app_has_role(text[]) owner to postgres;
alter function public.current_tenant_id() owner to postgres;

revoke all on function app_private.set_ctx(text), app_private.ctx(), app_private.audit(text, text, uuid, uuid, jsonb),
  app_private.deny_change(), app_private.require_member() from public, anon, authenticated, service_role;
revoke all on function public.app_tenant_id(), public.app_role(), public.app_has_role(text[]), public.current_tenant_id()
  from public, anon;
grant execute on function public.app_tenant_id(), public.app_role(), public.app_has_role(text[]), public.current_tenant_id()
  to authenticated, service_role;
