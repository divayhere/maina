-- Maina v0.8 append-only development diagnostics.
-- The phone may insert but never read diagnostic rows. Maintainers use the
-- Supabase management connection, which is not shipped in the APK.

do $$
begin
  if to_regclass('public.device_logs') is not null then
    execute 'drop policy if exists "anon can read logs" on public.device_logs';
  end if;
end
$$;

create table if not exists public.diagnostic_events (
  event_id text primary key,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  elapsed_ms bigint not null check (elapsed_ms >= 0),
  sequence bigint not null check (sequence >= 0),
  install_id text not null,
  app_session_id text not null,
  meeting_id text,
  recording_session_id text,
  segment_index integer check (segment_index is null or segment_index >= 0),
  level text not null check (level in ('debug', 'info', 'warn', 'error')),
  category text not null,
  event_name text not null,
  message text not null,
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  payload jsonb not null default '{}'::jsonb,
  app_version text not null,
  build_number text not null,
  git_sha text not null,
  device text not null,
  platform text not null
);

create index if not exists diagnostic_events_install_time_idx
  on public.diagnostic_events (install_id, occurred_at desc, event_id desc);
create index if not exists diagnostic_events_meeting_time_idx
  on public.diagnostic_events (meeting_id, occurred_at asc, event_id asc)
  where meeting_id is not null;
create index if not exists diagnostic_events_problem_time_idx
  on public.diagnostic_events (occurred_at desc, event_id desc)
  where level in ('warn', 'error');

create table if not exists public.diagnostic_runs (
  run_id text primary key,
  meeting_id text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  received_at timestamptz not null default now(),
  status text not null,
  wall_duration_ms bigint not null check (wall_duration_ms >= 0),
  audio_duration_ms bigint not null check (audio_duration_ms >= 0),
  expected_segments integer not null check (expected_segments >= 0),
  closed_segments integer not null check (closed_segments >= 0),
  uploaded_segments integer not null check (uploaded_segments >= 0),
  transcript_words integer not null check (transcript_words >= 0),
  recognizer_restarts integer not null check (recognizer_restarts >= 0),
  recognizer_downtime_ms bigint not null check (recognizer_downtime_ms >= 0),
  measured_gap_ms bigint not null check (measured_gap_ms >= 0),
  payload jsonb not null default '{}'::jsonb,
  install_id text not null,
  app_session_id text not null,
  app_version text not null,
  build_number text not null,
  git_sha text not null,
  device text not null,
  platform text not null,
  check (ended_at >= started_at),
  check (closed_segments <= expected_segments)
);

create index if not exists diagnostic_runs_install_started_idx
  on public.diagnostic_runs (install_id, started_at desc, run_id desc);
create index if not exists diagnostic_runs_meeting_idx
  on public.diagnostic_runs (meeting_id, started_at desc);

create table if not exists public.diagnostic_artifacts (
  artifact_id text primary key,
  meeting_id text not null,
  segment_index integer check (segment_index is null or segment_index >= 0),
  kind text not null check (kind in ('audio', 'transcript', 'health-snapshot')),
  object_path text not null,
  content_type text not null,
  codec text not null,
  bytes bigint not null check (bytes > 0),
  sha256 text not null check (length(sha256) = 64),
  duration_ms bigint not null check (duration_ms >= 0),
  uploaded_at timestamptz not null,
  expires_at timestamptz not null,
  received_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  install_id text not null,
  app_session_id text not null,
  app_version text not null,
  build_number text not null,
  git_sha text not null,
  device text not null,
  platform text not null,
  check (expires_at > uploaded_at)
);

create index if not exists diagnostic_artifacts_meeting_idx
  on public.diagnostic_artifacts (meeting_id, segment_index, uploaded_at);
create index if not exists diagnostic_artifacts_expiry_idx
  on public.diagnostic_artifacts (expires_at, artifact_id);

alter table public.diagnostic_events enable row level security;
alter table public.diagnostic_runs enable row level security;
alter table public.diagnostic_artifacts enable row level security;

drop policy if exists "maina append diagnostic events" on public.diagnostic_events;
create policy "maina append diagnostic events"
  on public.diagnostic_events for insert to anon with check (true);
drop policy if exists "maina append diagnostic runs" on public.diagnostic_runs;
create policy "maina append diagnostic runs"
  on public.diagnostic_runs for insert to anon with check (true);
drop policy if exists "maina append diagnostic artifacts" on public.diagnostic_artifacts;
create policy "maina append diagnostic artifacts"
  on public.diagnostic_artifacts for insert to anon with check (true);

revoke all on public.diagnostic_events from anon, authenticated;
revoke all on public.diagnostic_runs from anon, authenticated;
revoke all on public.diagnostic_artifacts from anon, authenticated;
grant insert on public.diagnostic_events to anon;
grant insert on public.diagnostic_runs to anon;
grant insert on public.diagnostic_artifacts to anon;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'maina-diagnostics',
  'maina-diagnostics',
  false,
  52428800,
  array['audio/ogg', 'audio/mp4', 'text/plain']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "maina upload diagnostic artifacts" on storage.objects;
create policy "maina upload diagnostic artifacts"
  on storage.objects for insert to anon
  with check (bucket_id = 'maina-diagnostics');

drop policy if exists "maina expire diagnostic artifacts" on storage.objects;
create policy "maina expire diagnostic artifacts"
  on storage.objects for delete to anon
  using (bucket_id = 'maina-diagnostics');
