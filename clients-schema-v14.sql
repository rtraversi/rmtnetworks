-- clients-schema-v14.sql — Lock the CRM down to server-side access only
-- Run in Supabase SQL Editor after v13, and only once no browser page talks to
-- Supabase directly (config.js removed; pages go through Netlify functions).
--
-- Every Netlify function, the usage scraper and crm-log.ps1 use the secret key
-- (service_role), which bypasses RLS. The anon/authenticated roles get nothing:
-- RLS stays on with no policies, and their table grants are revoked as well.

-- 1. Drop the permissive "anyone with the key" policies
DROP POLICY IF EXISTS "Anon full access" ON client_activities;
DROP POLICY IF EXISTS "Anon full access" ON client_charges;
DROP POLICY IF EXISTS "Anon full access" ON client_logins;
DROP POLICY IF EXISTS "Anon full access" ON client_milestone_items;
DROP POLICY IF EXISTS "Anon full access" ON client_payments;
DROP POLICY IF EXISTS "Anon full access" ON client_subscriptions;
DROP POLICY IF EXISTS "Anon full access" ON client_support_contracts;
DROP POLICY IF EXISTS "Anon full access" ON client_tasks;
DROP POLICY IF EXISTS "Anon full access" ON clients;
DROP POLICY IF EXISTS "Anon full access" ON intake_submissions;
DROP POLICY IF EXISTS "Anon full access" ON intake_tokens;
DROP POLICY IF EXISTS "Allow all"        ON ideas;
DROP POLICY IF EXISTS "Allow all"        ON subscriptions;
DROP POLICY IF EXISTS read_usage_metrics   ON usage_metrics;
DROP POLICY IF EXISTS update_usage_metrics ON usage_metrics;

-- 2. Data API grants: service_role only (see supabase/grants/data_api_grants.sql)
REVOKE ALL ON TABLE
  apps_catalog, client_activities, client_apps, client_charges, client_containers,
  client_logins, client_milestone_items, client_modules, client_payments,
  client_subscriptions, client_support_contracts, client_tasks, clients,
  demo_new_deeds, ideas, intake_submissions, intake_tokens, modules_catalog,
  subscriptions, usage_metrics
FROM anon, authenticated;

-- 3. New tables/functions no longer auto-grant to the public API roles
--    (matches Supabase's 2026-10-30 Data API change; grant explicitly instead)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- 4. Functions flagged by the security advisor
--    get_db_size_mb is SECURITY DEFINER and only fetch-usage.js (service_role) calls it.
REVOKE EXECUTE ON FUNCTION get_db_size_mb() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION get_db_size_mb() TO service_role;
ALTER FUNCTION get_db_size_mb()    SET search_path = '';
ALTER FUNCTION update_updated_at() SET search_path = '';
