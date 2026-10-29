alter function public.weeks_in_month(date,date,date) set search_path = public;
alter function public.default_checklist() set search_path = public;
-- column-level limits so admins can't change prices, the platform flag, etc.
revoke update on public.profiles, public.companies, public.checks, public.alerts, public.invoices, public.vehicles from authenticated;
grant update (role, active) on public.profiles to authenticated;
grant update (alert_email, billing_email, checklist, min_total_secs) on public.companies to authenticated;
grant update (fixed) on public.checks to authenticated;
grant update (resolved) on public.alerts to authenticated;
grant update (removed_on) on public.vehicles to authenticated;
grant update (status, paid_on) on public.invoices to authenticated;
revoke delete, truncate on all tables in schema public from authenticated, anon;
revoke all on all tables in schema public from anon;
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('kovi-monthly-invoices', '10 2 1 * *', $$select public.generate_invoices()$$);
