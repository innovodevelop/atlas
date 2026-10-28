// Settings → Memory & Privacy → "Remember things I share" (Beta F9, row 95).
//
// The webview writes one row per user into atlas_memory_settings through the
// local CRUD shim; the brain reads it here on every chat turn (voice turns
// too — the gateway delegates to /chat-with-memory) and hands it to the
// orchestrator as `rememberShared`. Off, the orchestrator stops saving facts
// and conversation summaries on its own and stores only what the user
// explicitly asks it to remember (see the gates in orchestrator.ts).
//
// No row, or a database that predates the table (a brain run standalone
// against an old atlas.db), means the default: on. A read error must never
// turn remembering off behind the user's back, nor on against their choice —
// but of the two, "on" is what the user had before this switch existed.
import type { Database } from "bun:sqlite";

export function readRememberShared(db: Database, userId: string): boolean {
  try {
    const row = db
      .query(`SELECT remember_shared FROM atlas_memory_settings WHERE user_id = ?`)
      .get(userId) as { remember_shared?: number | boolean } | null;
    if (!row || row.remember_shared == null) return true;
    return Number(row.remember_shared) !== 0;
  } catch {
    return true;
  }
}
