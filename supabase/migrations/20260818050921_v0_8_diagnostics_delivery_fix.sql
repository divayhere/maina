-- PostgREST evaluates SELECT privilege for ON CONFLICT even though the client
-- requests no rows. RLS still has no SELECT policy, so anonymous reads expose
-- nothing while idempotent inserts can use conflict-ignore safely.
grant select on public.diagnostic_events to anon;
grant select on public.diagnostic_runs to anon;
grant select on public.diagnostic_artifacts to anon;

-- Supabase Storage's delete flow internally reads object metadata first.
-- Scope that SELECT to the delete operation only, preventing object reads/listing.
drop policy if exists "maina inspect diagnostic artifact for delete" on storage.objects;
create policy "maina inspect diagnostic artifact for delete"
  on storage.objects for select to anon
  using (
    bucket_id = 'maina-diagnostics'
    and storage.allow_only_operation('delete')
  );
