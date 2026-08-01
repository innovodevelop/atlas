// Minimal SnapTrade API client with request signing, in Rust.
//
// SnapTrade signs every request: the `Signature` header is
//   base64( HMAC_SHA256( key = consumerKey, msg = JSON({content, path, query}) ) )
// where `content` is the parsed request body (or null), `path` is the URL path,
// and `query` is the exact querystring sent (clientId + timestamp, plus
// userId/userSecret for user-scoped calls). The signed querystring must be
// byte-identical to the one on the wire, so we build it once and reuse it.
//
// Read-only usage: we only ever GET holdings/balances/activities and POST the
// user-registration + connection-portal calls. Atlas never receives brokerage
// login credentials — the user authenticates inside SnapTrade's hosted portal.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;

const BASE: &str = "https://api.snaptrade.com/api/v1";

type HmacSha256 = Hmac<Sha256>;

fn now_ts() -> String {
    chrono::Utc::now().timestamp().to_string()
}

fn sign(consumer_key: &str, path: &str, query: &str, body: Option<&Value>) -> String {
    // Build the signing object with keys in the fixed order content,path,query.
    let content = match body {
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "null".into()),
        None => "null".into(),
    };
    let path_json = serde_json::to_string(path).unwrap();
    let query_json = serde_json::to_string(query).unwrap();
    let sig_content = format!("{{\"content\":{},\"path\":{},\"query\":{}}}", content, path_json, query_json);

    let mut mac = HmacSha256::new_from_slice(consumer_key.as_bytes()).expect("hmac key");
    mac.update(sig_content.as_bytes());
    STANDARD.encode(mac.finalize().into_bytes())
}

pub struct Client {
    client_id: String,
    consumer_key: String,
}

impl Client {
    pub fn from_keychain() -> Result<Self, String> {
        let (client_id, consumer_key) = crate::secrets::app_credentials()?;
        Ok(Self { client_id, consumer_key })
    }

    // Build the querystring (order preserved) shared by signing + the request URL.
    fn query(&self, user: Option<(&str, &str)>) -> String {
        let mut q = format!("clientId={}&timestamp={}", urlenc(&self.client_id), now_ts());
        if let Some((uid, usecret)) = user {
            q.push_str(&format!("&userId={}&userSecret={}", urlenc(uid), urlenc(usecret)));
        }
        q
    }

    fn call(&self, method: &str, path: &str, user: Option<(&str, &str)>, body: Option<Value>) -> Result<Value, String> {
        let full_path = format!("/api/v1{}", path);
        let query = self.query(user);
        let signature = sign(&self.consumer_key, &full_path, &query, body.as_ref());
        let url = format!("{}{}?{}", BASE, path, query);

        let req = crate::http::agent().request(method, &url)
            .set("Signature", &signature)
            .set("Content-Type", "application/json")
            .set("Accept", "application/json");

        let resp = match body {
            Some(b) => req.send_json(b),
            None => req.call(),
        };

        match resp {
            Ok(r) => r.into_json::<Value>().map_err(|e| format!("bad JSON from SnapTrade: {e}")),
            Err(ureq::Error::Status(code, r)) => {
                let detail = r.into_string().unwrap_or_default();
                Err(format!("SnapTrade {code}: {}", detail.chars().take(300).collect::<String>()))
            }
            Err(e) => Err(format!("SnapTrade request failed: {e}")),
        }
    }

    /// Register (or re-fetch) a SnapTrade user; returns (userId, userSecret).
    pub fn register_user(&self, user_id: &str) -> Result<(String, String), String> {
        let body = serde_json::json!({ "userId": user_id });
        let v = self.call("POST", "/snapTrade/registerUser", None, Some(body))?;
        let uid = v.get("userId").and_then(|x| x.as_str()).ok_or("no userId in response")?.to_string();
        let secret = v.get("userSecret").and_then(|x| x.as_str()).ok_or("no userSecret in response")?.to_string();
        Ok((uid, secret))
    }

    /// Connection-portal URL the user opens to link a brokerage.
    pub fn login_redirect(&self, user_id: &str, user_secret: &str) -> Result<String, String> {
        let v = self.call("POST", "/snapTrade/login", Some((user_id, user_secret)), Some(serde_json::json!({})))?;
        v.get("redirectURI").and_then(|x| x.as_str()).map(|s| s.to_string())
            .ok_or_else(|| "no redirectURI in login response".to_string())
    }

    pub fn list_accounts(&self, user_id: &str, user_secret: &str) -> Result<Vec<Value>, String> {
        let v = self.call("GET", "/accounts", Some((user_id, user_secret)), None)?;
        Ok(v.as_array().cloned().unwrap_or_default())
    }

    pub fn positions(&self, user_id: &str, user_secret: &str, account_id: &str) -> Result<Vec<Value>, String> {
        let v = self.call("GET", &format!("/accounts/{}/positions", account_id), Some((user_id, user_secret)), None)?;
        Ok(v.as_array().cloned().unwrap_or_default())
    }

    pub fn balances(&self, user_id: &str, user_secret: &str, account_id: &str) -> Result<Vec<Value>, String> {
        let v = self.call("GET", &format!("/accounts/{}/balances", account_id), Some((user_id, user_secret)), None)?;
        Ok(v.as_array().cloned().unwrap_or_default())
    }

    /// Activity/transaction history — the large dataset (all trades/dividends/…).
    pub fn activities(&self, user_id: &str, user_secret: &str) -> Result<Vec<Value>, String> {
        let v = self.call("GET", "/activities", Some((user_id, user_secret)), None)?;
        Ok(v.as_array().cloned().unwrap_or_default())
    }
}

fn urlenc(s: &str) -> String {
    // Minimal percent-encoding for query values (SnapTrade ids are already safe
    // ASCII, but be defensive for secrets containing +, /, =).
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
