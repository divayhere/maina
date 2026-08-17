/**
 * Remote logging endpoint (Supabase). The anon key is safe to ship — it's
 * public by design and gated by row-level security (insert/select only on the
 * device_logs table). Flip `enabled` to true once url + anonKey are set.
 */
export const REMOTE_LOG = {
  enabled: false,
  url: '', // e.g. https://abcd1234.supabase.co
  anonKey: '', // Supabase anon public key
};
