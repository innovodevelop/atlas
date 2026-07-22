// Supabase removed (local-first migration, Phase 4). This module now re-exports
// the local client — SQLite via Tauri for data, Cloudflare for auth — so every
// existing `import { supabase } from "@/integrations/supabase/client"` call site
// keeps working against the local stack with no change.
//
// See src/integrations/local/localClient.ts for the implementation and the
// exact supabase-js surface it covers.
export { localClient as supabase } from "@/integrations/local/localClient";
