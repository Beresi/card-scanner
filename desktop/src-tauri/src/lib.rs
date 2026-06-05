// Card // Broker — Tauri v2 host library
//
// The host is intentionally THIN:
//   - open_buy_url          : opens CardTrader Buy links in the OS system browser
//   - get_local_scan_status : reports presence flags (no values) for vars-file credentials
//   - local_scan_available  : convenience bool — required keys present in the vars file?
//   - run_local_scan        : spawns the bundled scan-local sidecar; passes the vars-file
//                             path via CARD_BROKER_VARS_FILE env; returns { started, run_id }
//                             without blocking on completion
//   - run_local_catalog_resync : spawns the same sidecar with CARD_BROKER_TASK=catalog-resync
//                             for a full-heal blueprint re-pull; returns { started, total_sets }
//                             without blocking on completion
//
// Credentials come from worker/.dev.vars.local (or .dev.vars) — not the OS keychain.
// Business logic (scanning, deal detection) lives in the Cloudflare Worker — never here.

mod commands;

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
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            open_buy_url,
            commands::get_local_scan_status,
            commands::local_scan_available,
            commands::run_local_scan,
            commands::run_local_catalog_resync,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
