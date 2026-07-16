# Portfolio (brokerage) linking — setup & how it works

Atlas links your brokerage through **SnapTrade** and does all portfolio work
**locally on your Mac** — nothing touches Supabase. The full holdings + years
of transaction history live in an on-device **DuckDB** database and are
analyzed with fast columnar queries, so it stays snappy even with a large
dataset.

## Security model
- You sign into your brokerage inside **SnapTrade's own connection portal**
  (opened in your system browser). **Atlas never sees your brokerage password.**
- Access is **read-only** (holdings, balances, transactions).
- SnapTrade credentials + your per-user secret are stored in the **macOS
  Keychain** (service `atlas-snaptrade`) — never in git, the database, or the
  JS layer.

## One-time setup
The test credentials are already provisioned in your Keychain. To (re)set them
or use production credentials:

```bash
security add-generic-password -a client_id    -s atlas-snaptrade -w "<SNAPTRADE_CLIENT_ID>"   -U
security add-generic-password -a consumer_key  -s atlas-snaptrade -w "<SNAPTRADE_CONSUMER_KEY>" -U
```

The current client id (`INNOVO-STUDIO-TEST-CCQXA`) is a **SnapTrade test/sandbox**
client — it connects to simulated brokerage data, ideal for verifying the flow.
Swap in a production SnapTrade client id + consumer key the same way when ready.

## Connecting a brokerage (in the Mac app)
1. Rebuild/relaunch the Atlas desktop app (the portfolio engine is native Rust —
   it only runs in the Mac app, not the browser preview).
2. Open **Settings → Portfolio → Connect a brokerage**.
3. Your browser opens SnapTrade's portal — pick your broker and sign in there.
4. Atlas polls until the link completes, then syncs. Your portfolio value,
   holdings, allocation and an invested-capital curve appear in the expanded
   **Watchlist** view (Portfolio hero) and in Settings.

Sync runs **on app open and when you hit refresh** (your chosen cadence).

## What's stored locally
- `~/Library/Application Support/com.magnuspilegaard.atlas/portfolio.duckdb`
  — accounts, holdings (snapshot, replaced each sync), and the deduped activity
  history. Disconnecting (Settings → Portfolio → trash icon) revokes the local
  link and wipes these tables.

## Tauri commands (native engine)
`portfolio_status`, `portfolio_connect_url`, `portfolio_sync`,
`portfolio_summary`, `portfolio_holdings`, `portfolio_history`,
`portfolio_allocation`, `portfolio_disconnect` — in `src-tauri/src/portfolio.rs`,
backed by `snaptrade.rs` (signed client), `portfolio_db.rs` (DuckDB) and
`secrets.rs` (Keychain).
