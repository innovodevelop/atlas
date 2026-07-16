// Tauri command layer for the local portfolio engine: orchestrates the
// SnapTrade client + the DuckDB store, parses SnapTrade's (nested, variable)
// JSON into flat rows, and exposes everything to the React frontend via invoke.

use serde_json::Value;
use std::path::PathBuf;
use tauri::Manager;

use crate::portfolio_db::{ActivityRow, Db, HoldingRow};
use crate::secrets;
use crate::snaptrade::Client;

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("portfolio.duckdb"))
}

// --- defensive JSON accessors (SnapTrade shapes vary by broker/endpoint) ---
fn dig<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for k in path { cur = cur.get(k)?; }
    Some(cur)
}
fn s(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn num(v: Option<&Value>) -> f64 {
    v.and_then(|x| x.as_f64()).unwrap_or(0.0)
}
// Ticker can appear as symbol.symbol.symbol, symbol.symbol, or symbol (string).
fn ticker(pos: &Value) -> String {
    if let Some(t) = dig(pos, &["symbol", "symbol", "symbol"]).and_then(|x| x.as_str()) { return t.into(); }
    if let Some(t) = dig(pos, &["symbol", "symbol"]).and_then(|x| x.as_str()) { return t.into(); }
    if let Some(t) = pos.get("symbol").and_then(|x| x.as_str()) { return t.into(); }
    s(dig(pos, &["universal_symbol", "symbol"]))
}
fn descr(pos: &Value) -> String {
    dig(pos, &["symbol", "symbol", "description"]).and_then(|x| x.as_str())
        .or_else(|| dig(pos, &["symbol", "description"]).and_then(|x| x.as_str()))
        .unwrap_or("").to_string()
}
fn asset_type(pos: &Value) -> String {
    dig(pos, &["symbol", "symbol", "type", "description"]).and_then(|x| x.as_str())
        .or_else(|| dig(pos, &["symbol", "type", "description"]).and_then(|x| x.as_str()))
        .unwrap_or("Other").to_string()
}

fn ensure_user(client: &Client) -> Result<(String, String), String> {
    if let Some(u) = secrets::snaptrade_user() { return Ok(u); }
    let user_id = uuid::Uuid::new_v4().to_string();
    let (uid, secret) = client.register_user(&user_id)?;
    secrets::set_snaptrade_user(&uid, &secret)?;
    Ok((uid, secret))
}

#[derive(serde::Serialize)]
pub struct Status { pub has_credentials: bool, pub connected: bool }

#[tauri::command]
pub fn portfolio_status(app: tauri::AppHandle) -> Status {
    let connected = secrets::snaptrade_user().is_some()
        && db_path(&app).ok().and_then(|p| Db::open(&p).ok())
            .and_then(|db| db.summary().ok()).map(|s| s.holdings_count > 0 || s.accounts_count > 0)
            .unwrap_or(false);
    Status { has_credentials: secrets::has_app_credentials(), connected }
}

/// Register the SnapTrade user if needed and return the connection-portal URL.
#[tauri::command]
pub fn portfolio_connect_url() -> Result<String, String> {
    let client = Client::from_keychain()?;
    let (uid, secret) = ensure_user(&client)?;
    client.login_redirect(&uid, &secret)
}

/// Pull accounts/positions/balances/activities from SnapTrade into DuckDB.
#[tauri::command]
pub fn portfolio_sync(app: tauri::AppHandle) -> Result<crate::portfolio_db::Summary, String> {
    let client = Client::from_keychain()?;
    let (uid, secret) = secrets::snaptrade_user().ok_or("Not connected — link a brokerage first")?;
    let db = Db::open(&db_path(&app)?)?;

    let accounts = client.list_accounts(&uid, &secret)?;
    for acct in &accounts {
        let account_id = s(acct.get("id"));
        if account_id.is_empty() { continue; }
        let account_name = acct.get("name").and_then(|x| x.as_str())
            .or_else(|| acct.get("institution_name").and_then(|x| x.as_str()))
            .unwrap_or("Account").to_string();

        // Balances (cash)
        let balances = client.balances(&uid, &secret, &account_id).unwrap_or_default();
        let cash: f64 = balances.iter().map(|b| num(b.get("cash"))).sum();
        let currency = balances.first().and_then(|b| dig(b, &["currency", "code"]).and_then(|x| x.as_str())).unwrap_or("USD").to_string();
        db.upsert_account(&account_id, &account_name, cash, &currency)?;

        // Positions → holdings snapshot
        let positions = client.positions(&uid, &secret, &account_id).unwrap_or_default();
        let rows: Vec<HoldingRow> = positions.iter().map(|p| {
            let qty = num(p.get("units").or_else(|| p.get("quantity")));
            let price = num(p.get("price"));
            let avg = num(p.get("average_purchase_price"));
            HoldingRow {
                account_id: account_id.clone(), account_name: account_name.clone(),
                symbol: ticker(p), description: descr(p), quantity: qty, price,
                market_value: qty * price, cost_basis: qty * avg,
                currency: currency.clone(), asset_type: asset_type(p),
            }
        }).filter(|r| !r.symbol.is_empty()).collect();
        db.replace_holdings(&account_id, &rows)?;
    }

    // Activity history (the large dataset)
    let activities = client.activities(&uid, &secret).unwrap_or_default();
    let arows: Vec<ActivityRow> = activities.iter().filter_map(|a| {
        let id = s(a.get("id"));
        if id.is_empty() { return None; }
        let account_id = a.get("account").and_then(|x| x.as_str()).map(|s| s.to_string())
            .unwrap_or_else(|| s(dig(a, &["account", "id"])));
        let symbol = a.get("symbol").and_then(|x| x.as_str()).map(|s| s.to_string())
            .unwrap_or_else(|| s(dig(a, &["symbol", "symbol"])));
        let date = s(a.get("trade_date"));
        let date = date.split('T').next().unwrap_or(&date).to_string();
        Some(ActivityRow {
            id, account_id, kind: s(a.get("type")), symbol,
            amount: num(a.get("amount")), trade_date: date, description: s(a.get("description")),
        })
    }).filter(|r| !r.trade_date.is_empty()).collect();
    db.insert_activities(&arows)?;

    db.summary()
}

#[tauri::command]
pub fn portfolio_summary(app: tauri::AppHandle) -> Result<crate::portfolio_db::Summary, String> {
    Db::open(&db_path(&app)?)?.summary()
}

#[tauri::command]
pub fn portfolio_holdings(app: tauri::AppHandle) -> Result<Vec<crate::portfolio_db::Holding>, String> {
    Db::open(&db_path(&app)?)?.top_holdings(50)
}

#[tauri::command]
pub fn portfolio_history(app: tauri::AppHandle) -> Result<Vec<crate::portfolio_db::HistoryPoint>, String> {
    Db::open(&db_path(&app)?)?.history()
}

#[tauri::command]
pub fn portfolio_allocation(app: tauri::AppHandle) -> Result<Vec<crate::portfolio_db::AllocSlice>, String> {
    Db::open(&db_path(&app)?)?.allocation()
}

#[tauri::command]
pub fn portfolio_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    secrets::clear_snaptrade_user()?;
    if let Ok(p) = db_path(&app) {
        if let Ok(db) = Db::open(&p) {
            let _ = db.wipe();
        }
    }
    Ok(())
}
