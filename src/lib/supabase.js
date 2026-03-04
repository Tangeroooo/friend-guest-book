import { createClient } from "@supabase/supabase-js";
import { assertSupabaseEnv } from "./env";

let client;

export function getSupabase() {
  if (!client) {
    assertSupabaseEnv();
    client = createClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_ANON_KEY,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
        },
      },
    );
  }

  return client;
}
