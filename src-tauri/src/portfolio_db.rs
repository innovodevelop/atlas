// On-device portfolio store + analytics, backed by DuckDB (columnar OLAP) so
// aggregate/time-series queries stay fast even over a large activity history.
// Positions/balances are full snapshots (replaced each sync); activities are
// append-only and deduped by id.

use duckdb::{Connection, params};
use serde::Serialize;
use std::path::Path;

pub struct Db {
    conn: Connection,
}

#[derive(Serialize, Default)]
pub struct Summary {
    pub total_value: f64,
    pub total_cost: f64,
    pub unrealized_pnl: f64,
    pub unrealized_pct: f64,
    pub cash: f64,
    pub holdings_count: i64,
    pub accounts_count: i64,
    pub currency: String,
}

#[derive(Serialize)]
pub struct Holding {
    pub symbol: String,
    pub description: String,
    pub quantity: f64,
    pub price: f64,
    pub market_value: f64,
    pub cost_basis: f64,
    pub pnl: f64,
    pub account: String,
    pub asset_type: String,
}

#[derive(Serialize)]
pub struct AllocSlice {
    pub label: String,
    pub value: f64,
}

#[derive(Serialize)]
pub struct HistoryPoint {
    pub date: String,
    pub value: f64,
}

pub struct HoldingRow {
    pub account_id: String,
    pub account_name: String,
    pub symbol: String,
    pub description: String,
    pub quantity: f64,
    pub price: f64,
    pub market_value: f64,
    pub cost_basis: f64,
    pub currency: String,
    pub asset_type: String,
}

pub struct ActivityRow {
    pub id: String,
    pub account_id: String,
    pub kind: String,
    pub symbol: String,
    pub amount: f64,
    pub trade_date: String, // YYYY-MM-DD
    pub description: String,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        let db = Db { conn };
        db.init()?;
        Ok(db)
    }

    fn init(&self) -> Result<(), String> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS accounts (
               id TEXT PRIMARY KEY, name TEXT, cash DOUBLE, currency TEXT, synced_at TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS holdings (
               account_id TEXT, account_name TEXT, symbol TEXT, description TEXT,
               quantity DOUBLE, price DOUBLE, market_value DOUBLE, cost_basis DOUBLE,
               currency TEXT, asset_type TEXT
             );
             CREATE TABLE IF NOT EXISTS activities (
               id TEXT PRIMARY KEY, account_id TEXT, kind TEXT, symbol TEXT,
               amount DOUBLE, trade_date DATE, description TEXT
             );",
        ).map_err(|e| e.to_string())
    }

    pub fn wipe(&self) -> Result<(), String> {
        self.conn.execute_batch("DELETE FROM holdings; DELETE FROM accounts; DELETE FROM activities;")
            .map_err(|e| e.to_string())
    }

    pub fn upsert_account(&self, id: &str, name: &str, cash: f64, currency: &str) -> Result<(), String> {
        self.conn.execute(
            "INSERT INTO accounts (id,name,cash,currency,synced_at) VALUES (?,?,?,?,now())
             ON CONFLICT (id) DO UPDATE SET name=excluded.name, cash=excluded.cash,
               currency=excluded.currency, synced_at=excluded.synced_at",
            params![id, name, cash, currency],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Positions are a full snapshot per account — replace, don't accumulate.
    pub fn replace_holdings(&self, account_id: &str, rows: &[HoldingRow]) -> Result<(), String> {
        self.conn.execute("DELETE FROM holdings WHERE account_id = ?", params![account_id]).map_err(|e| e.to_string())?;
        for r in rows {
            self.conn.execute(
                "INSERT INTO holdings (account_id,account_name,symbol,description,quantity,price,market_value,cost_basis,currency,asset_type)
                 VALUES (?,?,?,?,?,?,?,?,?,?)",
                params![r.account_id, r.account_name, r.symbol, r.description, r.quantity, r.price, r.market_value, r.cost_basis, r.currency, r.asset_type],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn insert_activities(&self, rows: &[ActivityRow]) -> Result<usize, String> {
        let mut n = 0;
        for r in rows {
            let changed = self.conn.execute(
                "INSERT INTO activities (id,account_id,kind,symbol,amount,trade_date,description)
                 VALUES (?,?,?,?,?,CAST(? AS DATE),?) ON CONFLICT (id) DO NOTHING",
                params![r.id, r.account_id, r.kind, r.symbol, r.amount, r.trade_date, r.description],
            ).map_err(|e| e.to_string())?;
            n += changed;
        }
        Ok(n)
    }

    pub fn summary(&self) -> Result<Summary, String> {
        let mut s = self.conn.query_row(
            "SELECT COALESCE(SUM(market_value),0), COALESCE(SUM(cost_basis),0), COUNT(*),
                    (SELECT COUNT(*) FROM accounts), (SELECT COALESCE(SUM(cash),0) FROM accounts),
                    (SELECT COALESCE(MAX(currency),'USD') FROM holdings)
             FROM holdings",
            [],
            |row| Ok(Summary {
                total_value: row.get(0)?,
                total_cost: row.get(1)?,
                holdings_count: row.get(2)?,
                accounts_count: row.get(3)?,
                cash: row.get(4)?,
                currency: row.get(5)?,
                ..Default::default()
            }),
        ).map_err(|e| e.to_string())?;
        s.total_value += s.cash;
        s.unrealized_pnl = s.total_value - s.cash - s.total_cost;
        s.unrealized_pct = if s.total_cost > 0.0 { s.unrealized_pnl / s.total_cost * 100.0 } else { 0.0 };
        Ok(s)
    }

    pub fn top_holdings(&self, limit: usize) -> Result<Vec<Holding>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT symbol, ANY_VALUE(description), SUM(quantity), AVG(price), SUM(market_value),
                    SUM(cost_basis), ANY_VALUE(account_name), ANY_VALUE(asset_type)
             FROM holdings GROUP BY symbol ORDER BY SUM(market_value) DESC LIMIT ?",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            let mv: f64 = row.get(4)?;
            let cb: f64 = row.get(5)?;
            Ok(Holding {
                symbol: row.get(0)?, description: row.get(1)?, quantity: row.get(2)?, price: row.get(3)?,
                market_value: mv, cost_basis: cb, pnl: mv - cb,
                account: row.get(6)?, asset_type: row.get(7)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn allocation(&self) -> Result<Vec<AllocSlice>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT COALESCE(NULLIF(asset_type,''),'Other') AS t, SUM(market_value)
             FROM holdings GROUP BY t ORDER BY 2 DESC",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok(AllocSlice { label: row.get(0)?, value: row.get(1)? }))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// Invested-capital curve from the activity history (cumulative net cash
    /// flow by date) — a fast, honest first-cut time series for the area chart.
    pub fn history(&self) -> Result<Vec<HistoryPoint>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT CAST(trade_date AS TEXT), SUM(SUM(amount)) OVER (ORDER BY trade_date)
             FROM activities GROUP BY trade_date ORDER BY trade_date",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok(HistoryPoint { date: row.get(0)?, value: row.get(1)? }))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }
}
