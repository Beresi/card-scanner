// Card // Broker — Tauri v2 host library
//
// The host is intentionally THIN:
//   - open_buy_url : opens CardTrader Buy links in the OS system browser
//
// The host used to also spawn a bundled "scan-local" sidecar for the deep-sweep
// scan and the catalog full-heal. That sidecar existed only to run work longer
// than a Cloudflare Worker's CPU/subrequest budget allowed, and it reached the
// database over the D1 REST API. With the backend self-hosted those limits are
// gone, so both jobs are plain API routes (POST /api/scan/deep-sweep and
// POST /api/catalog/resync) served in-process by the local backend.
//
// Keeping the sidecar would have been a correctness bug, not just dead weight:
// it writes to whatever database its own credentials name, which after the
// migration is the old cloud D1 — "Scan Now" would have looked like it worked
// while its results landed where the app no longer reads.
//
// Business logic (scanning, deal detection) lives in the backend — never here.

use tauri_plugin_opener::OpenerExt;

/// Opens a URL in the user's default system browser.
///
/// Buy links MUST open externally — never navigate in the webview.
/// Returns an error string on failure so the frontend can surface it.
#[tauri::command]
fn open_buy_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_buy_url])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
