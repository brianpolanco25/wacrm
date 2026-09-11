import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Lazy, shared service-role client for platform-operator work:
// `platform_admins` lookups and `impersonation_log` writes. Neither table
// has a client-side write policy (migration 055), so the audit trail can
// only be written from here.
//
// Same shape as the automations / flows / ai admin clients.
let _adminClient: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}
