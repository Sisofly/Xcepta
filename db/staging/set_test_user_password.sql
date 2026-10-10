-- set_test_user_password.sql - STAGING ONLY (run via: npm run staging:set-test-password)
-- Sets a new password for ONE synthetic staging test user by replacing the
-- bcrypt hash in auth.users (the format Supabase Auth verifies). The user's id,
-- email, confirmation status and tenant link (public.users) are unchanged.
-- Only accounts on the reserved .test domain can be changed.
-- psql variable :'email'; the new password is read from the process-only
-- environment variable XCEPTA_NEW_TEST_PASSWORD (never a command-line argument).
\getenv new_password XCEPTA_NEW_TEST_PASSWORD
\if :{?new_password}
\else
  do $$ begin raise exception 'XCEPTA_NEW_TEST_PASSWORD is not set. Nothing was changed.'; end $$;
\endif
begin;
do $$ begin
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    raise exception 'pgcrypto is not installed on this database';
  end if;
end $$;

update auth.users
   set encrypted_password = extensions.crypt(:'new_password', extensions.gen_salt('bf', 10)),
       updated_at = now()
 where lower(email) = lower(:'email')
   and email ilike '%.test';

select case when count(*) = 1 then 'password updated for ' || min(email)
            else 'ERROR: no single .test staging user with email ' || :'email' end as result
  from auth.users
 where lower(email) = lower(:'email') and email ilike '%.test' and updated_at > now() - interval '1 minute';
commit;
