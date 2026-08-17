/**
 * Remote logging endpoint (Supabase). The anon key is safe to ship — it's
 * public by design. Remote logging is deliberately disabled until Supabase
 * removes anonymous SELECT access from device_logs. Shipping diagnostics to a
 * publicly readable table is a privacy failure, even when transcript text is
 * not included.
 */
const key = process.env.EXPO_PUBLIC_SUPABASE_LOG_KEY ?? '';

export const REMOTE_LOG = {
  enabled: process.env.EXPO_PUBLIC_REMOTE_LOG_ENABLED === 'true' && key.length > 0,
  url: 'https://voqanxnevtugrfcyvuuf.supabase.co',
  anonKey: key,
};
