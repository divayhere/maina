/**
 * Remote logging endpoint (Supabase). The anon key is safe to ship — it's
 * public by design and gated by row-level security (insert/select only on the
 * device_logs table).
 */
export const REMOTE_LOG = {
  enabled: true,
  url: 'https://voqanxnevtugrfcyvuuf.supabase.co',
  anonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvcWFueG5ldnR1Z3JmY3l2dXVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5Njk2NjEsImV4cCI6MjEwMjU0NTY2MX0._8tqcYvxdcn5DcGLRUmPb5jBRzM1taLJ_zrK58LAJ0A',
};
