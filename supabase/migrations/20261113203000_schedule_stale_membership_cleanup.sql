create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $schedule$
begin
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'inactive_account_cleanup_cron_secret'
      and decrypted_secret <> ''
  ) then
    raise exception 'Set the same INACTIVE_ACCOUNT_CLEANUP_CRON_SECRET for the Edge Function and inactive_account_cleanup_cron_secret in Supabase Vault before applying this migration.';
  end if;

  if exists (
    select 1
    from cron.job
    where jobname = 'delete-stale-never-activated-accounts'
  ) then
    perform cron.unschedule('delete-stale-never-activated-accounts');
  end if;

  perform cron.schedule(
    'delete-stale-never-activated-accounts',
    '30 2 * * *',
    $job$
      select net.http_post(
        url := 'https://lcleywliqmyveoqnllgu.supabase.co/functions/v1/clear-all-data',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'inactive_account_cleanup_cron_secret'
            limit 1
          )
        ),
        body := jsonb_build_object(
          'action', 'deleteStaleNeverActivatedAccounts'
        )
      );
    $job$
  );
end;
$schedule$;
