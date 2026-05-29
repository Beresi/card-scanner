// Card // Broker — Tauri v2 host library
//
// The host is intentionally THIN:
//   - open_buy_url  : opens CardTrader Buy links in the OS system browser
//   - get_auth_token / set_auth_token : (stub comments) OS-backed secure storage
//                     — to be implemented by security-agent using tauri-plugin-stronghold
//                       or tauri-plugin-store once the plugin is wired in.
//
// Business logic (scanning, deal detection) lives in the Cloudflare Worker — never here.

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

// ---------------------------------------------------------------------------
// Secure-storage stubs — implemented by security-agent in a follow-up.
//
// #[tauri::command]
// async fn get_auth_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
//     // Will use tauri-plugin-stronghold / tauri-plugin-store backed by the OS keychain.
//     // Token = Cloudflare Access service token / shared bearer for /api/* calls.
//     todo!("implement with OS-backed secure storage — never plaintext")
// }
//
// #[tauri::command]
// async fn set_auth_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
//     // Validates non-empty, then writes to OS secure storage.
//     todo!("implement with OS-backed secure storage — never plaintext")
// }
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_buy_url])
        .setup(|app| {
            // Nothing to set up at Phase 0; secure-storage init lands here later.
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
