-- ROLLBACK SEC-03 — removes the lifecycle / admin / operator functions. Roll
-- back SEC-04 first, and the application to a release that does not call
-- them. Audit records already written are kept. No data is changed.
-- Runs in one transaction: on any error nothing is changed.
begin;
drop function if exists public.approve_version(uuid, jsonb, text);
drop function if exists public.archive_version(uuid, text);
drop function if exists public.delete_draft_version(uuid);
drop function if exists public.delete_scenario(uuid);
drop function if exists public.delete_project(uuid);
drop function if exists public.admin_set_member_role(uuid, text);
drop function if exists public.admin_set_member_active(uuid, boolean);
drop function if exists public.admin_rename_tenant(text);
drop function if exists public.operator_create_tenant(text, text, text);
drop function if exists public.operator_add_member(uuid, uuid, text, text, text);
drop function if exists public.operator_move_member(uuid, uuid, text);
drop function if exists public.operator_purge_project(uuid, text, text);
drop function if exists public.operator_set_member_role(uuid, text, text);
drop function if exists app_private.assert_draft_only(uuid, uuid, uuid);
drop function if exists app_private.require_admin_target(uuid);
drop function if exists app_private.require_operator();
commit;
