// Portfolio reads, straight off the local DuckDB analytics store.
//
// Every one of these calls the existing `#[tauri::command]` with a cloned
// AppHandle — portfolio.rs opens a fresh DuckDB connection per command rather
// than holding managed state, so there is nothing to fetch off the handle.
//
// The results are OUR structs (Summary/Holding/HistoryPoint/AllocSlice), flat
// and already named for humans, so there is no provider document to project
// away. The lists are still capped: `top_holdings(50)` and a full price history
// are both larger than a tool result should be.
//
// Linking and unlinking a brokerage are not here. registry.rs records why.
//
// KNOWN GAP, STATED SO NOBODY ASSUMES OTHERWISE: these numbers are whatever the
// last brokerage sync stored, and NOTHING in the response says when that was —
// none of the four structs carries a synced-at field, and this milestone does
// not add one. A model reading them cannot tell a fresh figure from a stale
// one, so it must not present them as live. Making that answerable means adding
// a timestamp to the store, which is a change to portfolio_db.rs, not here.

use serde_json::Value;
use tauri::AppHandle;

use super::ops_project;
use crate::control::Ctx;

fn as_capped_list<T: serde::Serialize>(rows: Vec<T>) -> Result<Value, String> {
    let v = serde_json::to_value(rows).map_err(|e| e.to_string())?;
    Ok(ops_project::capped(v.as_array().cloned().unwrap_or_default()))
}

/// Whether a brokerage is linked and whether the app has the credentials to
/// talk to one at all. Two booleans; nothing to cap.
pub fn status(app: &AppHandle, _args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let st = crate::portfolio::portfolio_status(app.clone());
    serde_json::to_value(st).map_err(|e| e.to_string())
}

/// Totals across every linked account. A single small struct.
pub fn summary(app: &AppHandle, _args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let s = crate::portfolio::portfolio_summary(app.clone())?;
    serde_json::to_value(s).map_err(|e| e.to_string())
}

pub fn holdings(app: &AppHandle, _args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    as_capped_list(crate::portfolio::portfolio_holdings(app.clone())?)
}

pub fn history(app: &AppHandle, _args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    as_capped_list(crate::portfolio::portfolio_history(app.clone())?)
}

pub fn allocation(app: &AppHandle, _args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    as_capped_list(crate::portfolio::portfolio_allocation(app.clone())?)
}
