import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// Bypasses RLS entirely via the service-role key -- for server-only code
// that needs to read/write data across users (push fan-out, the reminder
// cron). Never import this into a "use client" file: the key would leak
// into the browser bundle.
export function createServiceClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
