-- SEC-02 — identity lockdown (B1). Safe with the currently deployed app: the
-- application never writes public.users or public.tenants.
-- ---------------------------------------------------------------------------
-- Requires SEC-01. Closes: self-assignment of tenant_id / role (INSERT or
-- UPDATE of one's own users row), tenant creation / modification by users,
-- and anonymous table access.
--   • Grants: users / tenants are read-only for authenticated, except the
--     users.name column (own row, by the existing tenant_isolation policy).
--     anon loses every table privilege (it needs none; sign-in uses Auth).
--   • Triggers (defence in depth — also apply to the service role, the SQL
--     editor and FK cascades): identity fields change only inside the
--     admin / operator functions (execution context 'admin', SEC-03).
--   • Same-tenant read of colleague profiles (names, roles) for "approved by".
-- Idempotent. Rollback: db/migrations/rollback/2026-10-16_sec02_rollback.sql
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate on public.users, public.tenants from public, anon, authenticated;
grant update (name) on public.users to authenticated;
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

create or replace function app_private.users_guard() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if app_private.ctx() = 'admin' then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    raise exception using errcode = '42501', message = 'IDENTITY_PROTECTED: memberships are created only by the platform operator';
  elsif tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'IDENTITY_PROTECTED: memberships are deactivated, not deleted';
  end if;
  if new.user_id is distinct from old.user_id or new.tenant_id is distinct from old.tenant_id
     or new.role is distinct from old.role or new.email is distinct from old.email
     or new.active is distinct from old.active or new.created_at is distinct from old.created_at then
    raise exception using errcode = '42501', message = 'IDENTITY_PROTECTED: tenant, role, e-mail and status change only through admin functions';
  end if;
  return new;
end $$;
drop trigger if exists users_guard on public.users;
create trigger users_guard before insert or update or delete on public.users
  for each row execute function app_private.users_guard();

create or replace function app_private.tenants_guard() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if app_private.ctx() = 'admin' then return coalesce(new, old); end if;
  raise exception using errcode = '42501', message = 'IDENTITY_PROTECTED: tenants change only through admin / operator functions';
end $$;
drop trigger if exists tenants_guard on public.tenants;
create trigger tenants_guard before insert or update or delete on public.tenants
  for each row execute function app_private.tenants_guard();

drop trigger if exists users_no_truncate on public.users;
create trigger users_no_truncate before truncate on public.users for each statement execute function app_private.deny_change();
drop trigger if exists tenants_no_truncate on public.tenants;
create trigger tenants_no_truncate before truncate on public.tenants for each statement execute function app_private.deny_change();

-- Colleague profiles (same tenant). Uses the SECURITY DEFINER helper, so the
-- policy does not query public.users under RLS (no policy recursion).
drop policy if exists users_same_tenant_read on public.users;
create policy users_same_tenant_read on public.users for select to authenticated
  using (tenant_id = public.app_tenant_id());

alter function app_private.users_guard() owner to postgres;
alter function app_private.tenants_guard() owner to postgres;
revoke all on function app_private.users_guard(), app_private.tenants_guard() from public, anon, authenticated, service_role;
