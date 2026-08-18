/** The publishable key is intentionally safe to ship in a client. RLS keeps
 * diagnostics append-only and the app never receives maintainer read access. */
const bundledPublishableKey = 'sb_publishable_U_jttqx8c5mzPui7bfdS9A_wUvO5klc';
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_LOG_KEY ?? bundledPublishableKey;

export const REMOTE_LOG = {
  enabled: process.env.EXPO_PUBLIC_REMOTE_LOG_ENABLED !== 'false' && publishableKey.length > 0,
  url: 'https://voqanxnevtugrfcyvuuf.supabase.co',
  publishableKey,
  bucket: 'maina-diagnostics',
  retentionDays: 7,
};
