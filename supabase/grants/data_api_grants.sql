-- data_api_grants.sql — Data API grants for the RMT CRM project (enowrzljapjkaxpsvdhr)
--
-- Since 2026-10-30 Supabase no longer auto-grants Data API access to new tables,
-- and v14 removed the old blanket grants. When the schema is rebuilt from the
-- clients-schema-v*.sql files (new project, branch, db reset), run this file LAST.
--
-- Access model: only the secret key (service_role) used by the Netlify functions,
-- the usage scraper and crm-log.ps1 touches CRM tables. anon/authenticated get no
-- table grants. The site_* tables for builtsmartbyrob.com carry their own grants
-- in that repo (supabase/site_reviews.sql).

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  apps_catalog, backup_runs, backup_sites, client_activities, client_apps, client_charges, client_containers,
  client_logins, client_milestone_items, client_modules, client_payments,
  client_subscriptions, client_support_contracts, client_tasks, clients,
  demo_new_deeds, ideas, intake_submissions, intake_tokens, modules_catalog,
  subscriptions, usage_metrics
TO service_role;

GRANT EXECUTE ON FUNCTION get_db_size_mb() TO service_role;
