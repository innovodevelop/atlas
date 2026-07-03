/**
 * One-off data migration: Lovable Cloud Supabase -> your own Supabase project.
 *
 * Run with Bun:
 *   OLD_SUPABASE_URL=https://gyfllxzecctdnmxqgazo.supabase.co \
 *   OLD_ANON_KEY=<old anon key> \
 *   OLD_EMAIL=<your login email> \
 *   OLD_PASSWORD=<your login password> \
 *   NEW_SUPABASE_URL=https://<new-ref>.supabase.co \
 *   NEW_SERVICE_ROLE_KEY=<new service role key> \
 *   bun run scripts/migrate-data.ts
 *
 * Signs in as your user on the old project (RLS grants access to your rows),
 * exports each table, and inserts into the new project with the service key.
 *
 * atlas_research_topics / atlas_research_queue are intentionally NOT migrated:
 * they are full of runaway auto-generated research garbage. memory_vectors is
 * also skipped — the legacy embeddings were fake (hash-based); re-run the
 * generate-embeddings function on the new project instead.
 */
import { createClient } from "@supabase/supabase-js";

const OLD_URL = process.env.OLD_SUPABASE_URL!;
const OLD_ANON = process.env.OLD_ANON_KEY!;
const OLD_EMAIL = process.env.OLD_EMAIL!;
const OLD_PASSWORD = process.env.OLD_PASSWORD!;
const NEW_URL = process.env.NEW_SUPABASE_URL!;
const NEW_SERVICE = process.env.NEW_SERVICE_ROLE_KEY!;

for (const [name, v] of Object.entries({ OLD_URL, OLD_ANON, OLD_EMAIL, OLD_PASSWORD, NEW_URL, NEW_SERVICE })) {
  if (!v) {
    console.error(`Missing env var for ${name} — see header comment for usage.`);
    process.exit(1);
  }
}

// Ordered so foreign-key targets (conversations before messages, etc.) land first.
const TABLES = [
  "profiles",
  "conversations",
  "messages",
  "ai_memory",
  "user_life_events",
  "ai_insights",
  "atlas_knowledge_entries",
  "user_notes",
  "user_tasks",
  "user_events",
  "user_watchlist",
  "user_weather_settings",
  "data_sources",
  "memory_policies",
  "agents",
  "model_configs",
  "schedules",
  "workspace_settings",
  "research_citations",
];

const PAGE_SIZE = 500;

async function main() {
  const oldClient = createClient(OLD_URL, OLD_ANON);
  const newClient = createClient(NEW_URL, NEW_SERVICE, {
    auth: { persistSession: false },
  });

  const { data: auth, error: authError } = await oldClient.auth.signInWithPassword({
    email: OLD_EMAIL,
    password: OLD_PASSWORD,
  });
  if (authError || !auth.user) {
    console.error("Old-project sign-in failed:", authError?.message);
    process.exit(1);
  }
  console.log(`Signed in as ${auth.user.email} (${auth.user.id})`);
  console.log(
    "NOTE: create the same user on the NEW project first (same email/password via the app's signup),",
  );
  console.log(
    "then pass its id if it differs — rows keep their user_id, so ids must match.",
  );

  // Verify the user exists on the new project with the SAME id; otherwise all
  // RLS-scoped rows would be orphaned.
  const { data: newUsers } = await newClient.auth.admin.listUsers();
  const match = newUsers?.users.find((u) => u.id === auth.user!.id);
  if (!match) {
    console.error(
      `\nUser id ${auth.user.id} not found on the new project.\n` +
        `Create it with a matching id first:\n` +
        `  supabase auth admin (or SQL: INSERT INTO auth.users ...) — easiest is\n` +
        `  the createUser admin API with the same UUID:\n`,
    );
    const { data: created, error: createError } = await newClient.auth.admin.createUser({
      id: auth.user.id,
      email: OLD_EMAIL,
      password: OLD_PASSWORD,
      email_confirm: true,
    } as never);
    if (createError) {
      console.error("Auto-create failed:", createError.message);
      process.exit(1);
    }
    console.log(`Created user on new project with matching id: ${created.user?.id}`);
  }

  for (const table of TABLES) {
    let from = 0;
    let migrated = 0;
    for (;;) {
      const { data: rows, error } = await oldClient
        .from(table)
        .select("*")
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        console.warn(`  ${table}: read error (${error.message}) — skipping table`);
        break;
      }
      if (!rows || rows.length === 0) break;

      const { error: insertError } = await newClient
        .from(table)
        .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
      if (insertError) {
        console.warn(`  ${table}: insert error (${insertError.message}) — skipping rest`);
        break;
      }
      migrated += rows.length;
      if (rows.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    console.log(`${table}: ${migrated} rows migrated`);
  }

  console.log("\nDone. Post-migration steps:");
  console.log("  1. Invoke generate-embeddings on the new project to rebuild memory_vectors.");
  console.log("  2. Verify counts in the new project's dashboard.");
}

main();
