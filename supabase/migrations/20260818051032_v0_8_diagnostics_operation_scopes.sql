-- Conflict-ignore needs to see primary-key conflicts during POST only. Direct
-- GET requests still match no SELECT policy and return an empty result.
drop policy if exists "maina inspect events for conflict" on public.diagnostic_events;
create policy "maina inspect events for conflict"
  on public.diagnostic_events for select to anon
  using ((select current_setting('request.method', true)) = 'POST');

drop policy if exists "maina inspect runs for conflict" on public.diagnostic_runs;
create policy "maina inspect runs for conflict"
  on public.diagnostic_runs for select to anon
  using ((select current_setting('request.method', true)) = 'POST');

drop policy if exists "maina inspect artifacts for conflict" on public.diagnostic_artifacts;
create policy "maina inspect artifacts for conflict"
  on public.diagnostic_artifacts for select to anon
  using ((select current_setting('request.method', true)) = 'POST');

drop policy if exists "maina inspect diagnostic artifact for delete" on storage.objects;
create policy "maina inspect diagnostic artifact for delete"
  on storage.objects for select to anon
  using (
    bucket_id = 'maina-diagnostics'
    and storage.allow_only_operation('object.delete')
  );
