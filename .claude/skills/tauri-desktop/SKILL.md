---
name: tauri-desktop
description: Tauri v2 desktop host patterns for Card // Broker — thin Rust host, #[tauri::command] IPC, OS-backed secure token storage, open-in-system-browser, capability allowlist, tauri.conf.json, the npm run tauri dev/build flow, and webview↔host wiring. Load before touching src-tauri/, adding a command, storing the API token, or configuring packaging/updater.
---

# Tauri Desktop

## Purpose
The dashboard ships as a **Tauri v2** desktop app: a React+Vite+TS frontend in the system
webview + a thin **Rust host** (`src-tauri/`). The host does the few things a webview can't:
open external URLs in the system browser, hold the cloud API auth token in OS-backed secure
storage, and package/sign/auto-update the app. Business logic stays in the cloud Worker — the
host never runs the scan.

## Core patterns

### A thin command + secure token storage
```rust
// src-tauri/src/commands.rs
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn open_buy_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    // Buy links open in the system browser, never in-webview.
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_api_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
    // OS-backed secure storage (stronghold / store). NEVER plaintext config or the bundle.
    secure_store::set(&app, "api_token", &token).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_api_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    secure_store::get(&app, "api_token").map_err(|e| e.to_string())
}
```

### Registering commands + the frontend call
```rust
// src-tauri/src/main.rs
tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![open_buy_url, set_api_token, get_api_token])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```
```ts
// frontend
import { invoke } from '@tauri-apps/api/core';
await invoke('open_buy_url', { url: deal.buy_url });
const token = await invoke<string | null>('get_api_token');  // attach as bearer to /api calls
```

## tauri.conf.json + build
- Window options, bundle config, and the **updater** (endpoint + public key) live in
  `tauri.conf.json`. The bundle never contains secrets.
- Capability allowlist: enable ONLY the plugins/commands used (opener, store/stronghold,
  updater). Narrow `permissions` per window.
- Commands: `npm run tauri dev` (live dev against the cloud API), `npm run tauri build`
  (per-OS bundle/installer). Rust hygiene: `cargo fmt`, `cargo clippy`.

## Standards
@docs/standards/coding-standards.md
@docs/standards/shared-standards.md

## Examples
### Good
The frontend fetches `/api/*` with a bearer pulled from `get_api_token`; the token was saved
once via `set_api_token` into the OS keychain/stronghold. Buy buttons call `open_buy_url`.

### Bad
```rust
#[tauri::command]
fn get_token() -> String { "ct_live_abc123".into() }   // ❌ secret hardcoded in the binary
// ❌ token written to tauri.conf.json or localStorage; ❌ unwrap() on storage I/O;
// ❌ reimplementing the CardTrader scan in Rust
```

## Gotchas
- Keep the host THIN — most features belong to the frontend; only reach for Rust for native
  capabilities (browser open, secure storage, updater, packaging).
- No plaintext secrets in `tauri.conf.json`, source, or the JS bundle — OS secure storage only.
- Commands return `Result<…, String>`; never `unwrap()` fallible I/O.
- Minimal capability allowlist; broad allowlists are an attack surface.
- Never run the scan locally — that's the cloud Worker's job (Tauri-client + cloud-backend
  architecture).
- Bundle fonts locally; don't depend on Google Fonts at runtime.

## Related skills
- security — secret/token policy, capability hardening
- error-handling — Rust `Result` commands, no-leak logging
- state-management — the frontend attaches the token to API calls
