-- seed_staging_users.sql - STAGING ONLY (run via: npm run staging:seed).
-- Links an existing staging Auth user (created in Authentication -> Users) to a
-- new synthetic tenant. Idempotent: an already-linked user is left unchanged and
-- no extra tenant is created. psql variables: :'email', :'tenant_name'.
begin;
with auth_user as (
  select id, email from auth.users where lower(email) = lower(:'email')
), new_tenant as (
  insert into public.tenants (name)
  select :'tenant_name'
  where exists (select 1 from auth_user)
    and not exists (select 1 from public.users u join auth_user a on a.id = u.user_id)
  returning tenant_id
)
insert into public.users (user_id, tenant_id, email, name, role)
select a.id, t.tenant_id, a.email, :'tenant_name' || ' user', 'admin'
from auth_user a cross join new_tenant t
on conflict (user_id) do nothing;

-- Report (fails loudly if the email has no staging auth user)
select case when exists (select 1 from auth.users where lower(email) = lower(:'email'))
            then 'linked: ' || :'email'
            else (select 'ERROR: no staging auth user with email ' || :'email' || ' - create it in Authentication -> Users first')
       end as result;
commit;
