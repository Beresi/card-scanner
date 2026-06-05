// Card // Broker — Tauri host commands
//
// Security invariants (enforced here):
//   - Secret VALUES are NEVER read into Rust memory by this file.
//   - The run command passes a FILE PATH to the sidecar via env; the sidecar parses the
//     file itself. No secret value crosses the IPC bridge or appears in any log.
//   - The status command reads only KEY PRESENCE (non-empty value after "=") — it never
//     returns, logs, or exposes any value.
//   - All I/O returns Result<_, String>; no unwrap/expect on fallible paths.
//   - The sidecar receives the vars-file path via ENV only (not argv, which is visible in
//     the OS process list).

use serde::Serialize;
use tauri_plugin_shell::ShellExt;

// ---------------------------------------------------------------------------
// Vars-file path resolution
//
// Owner's repo path — single-machine personal tool.
// Override by setting CARD_BROKER_VARS_FILE in the environment before launching the app.
// ---------------------------------------------------------------------------

const WORKER_DIR: &str = r"E:\Projects\card-scanner\worker";

/// Resolve the vars-file path to use for local scan credentials.
///
/// Resolution order (first existing file wins):
///   1. `CARD_BROKER_VARS_FILE` env var (explicit override — use this when the repo moves)
///   2. `<WORKER_DIR>/.dev.vars.local`  (local overrides, git-ignored)
///   3. `<WORKER_DIR>/.dev.vars`        (shared dev secrets, git-ignored)
///
/// Returns `None` if no candidate exists on disk.
fn resolve_vars_file() -> Option<std::path::PathBuf> {
    // Candidate 1: explicit env override.
    if let Ok(path) = std::env::var("CARD_BROKER_VARS_FILE") {
        let p = std::path::PathBuf::from(&path);
        if p.exists() {
            return Some(p);
        }
        // Env var was set but the path doesn't exist — fall through to the defaults
        // so the caller gets a descriptive error rather than a confusing "not configured".
    }

    // Candidate 2: .dev.vars.local (git-ignored local overrides).
    let local = std::path::Path::new(WORKER_DIR).join(".dev.vars.local");
    if local.exists() {
        return Some(local);
    }

    // Candidate 3: .dev.vars (shared dev secrets, also git-ignored).
    let shared = std::path::Path::new(WORKER_DIR).join(".dev.vars");
    if shared.exists() {
        return Some(shared);
    }

    None
}

// ---------------------------------------------------------------------------
// Vars-file key-presence check
//
// Reads the file line-by-line; for each line that matches `KEY=<non-empty-value>`,
// records the key as present. Secret VALUES are never stored, logged, or returned.
// ---------------------------------------------------------------------------

struct VarsPresence {
    has_cardtrader_api_token: bool,
    has_cf_api_token: bool,
    has_telegram_bot_token: bool,
    has_telegram_chat_id: bool,
}

fn check_vars_presence(path: &std::path::Path) -> std::io::Result<VarsPresence> {
    use std::io::{BufRead, BufReader};

    let file = std::fs::File::open(path)?;
    let reader = BufReader::new(file);

    let mut presence = VarsPresence {
        has_cardtrader_api_token: false,
        has_cf_api_token: false,
        has_telegram_bot_token: false,
        has_telegram_chat_id: false,
    };

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();

        // Skip comments and blank lines.
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }

        // Split on the first '=' only; require a non-empty value.
        if let Some(eq_pos) = trimmed.find('=') {
            let key = trimmed[..eq_pos].trim();
            let value = trimmed[eq_pos + 1..].trim();
            if value.is_empty() {
                continue;
            }
            // Record presence by key name — the VALUE is discarded immediately.
            match key {
                "CARDTRADER_API_TOKEN" => presence.has_cardtrader_api_token = true,
                "CF_API_TOKEN" => presence.has_cf_api_token = true,
                "TELEGRAM_BOT_TOKEN" => presence.has_telegram_bot_token = true,
                "TELEGRAM_CHAT_ID" => presence.has_telegram_chat_id = true,
                _ => {} // other keys irrelevant to presence check
            }
        }
    }

    Ok(presence)
}

// ---------------------------------------------------------------------------
// Public data types (sent over the Tauri IPC bridge)
// ---------------------------------------------------------------------------

/// Returned by `get_local_scan_status` — presence flags only, no values ever.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalScanStatus {
    pub configured: bool,
    pub has_telegram: bool,
}

/// Returned by `run_local_scan`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalScanStarted {
    pub started: bool,
    pub run_id: Option<u32>,
}

/// Returned by `run_local_catalog_resync`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResyncStarted {
    pub started: bool,
    /// Number of sets the re-pull will process (from the sidecar "started" event).
    pub total_sets: Option<u32>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Returns presence flags for the vars-file credentials — no values, ever.
///
/// `configured` = a candidate vars file exists AND contains non-empty
///                `CARDTRADER_API_TOKEN` and `CF_API_TOKEN`.
/// `has_telegram` = the file also contains non-empty `TELEGRAM_BOT_TOKEN`
///                  and `TELEGRAM_CHAT_ID`.
///
/// Returns `{ configured: false, has_telegram: false }` when no file is found — never errors.
#[tauri::command]
pub fn get_local_scan_status() -> LocalScanStatus {
    let not_configured = LocalScanStatus {
        configured: false,
        has_telegram: false,
    };

    let Some(path) = resolve_vars_file() else {
        return not_configured;
    };

    let presence = match check_vars_presence(&path) {
        Ok(p) => p,
        Err(_) => return not_configured,
    };

    let configured = presence.has_cardtrader_api_token && presence.has_cf_api_token;
    let has_telegram = presence.has_telegram_bot_token && presence.has_telegram_chat_id;

    LocalScanStatus {
        configured,
        has_telegram,
    }
}

/// Convenience boolean: true iff the vars file exists and contains the two required keys.
///
/// The frontend uses this as a simple enable/disable gate for the Scan Now button.
#[tauri::command]
pub fn local_scan_available() -> bool {
    get_local_scan_status().configured
}

/// Spawn the `scan-local` sidecar, passing the vars-file path via `CARD_BROKER_VARS_FILE`.
///
/// The sidecar reads all secrets from the file itself — this command never reads or
/// transmits any secret value.
///
/// Flow:
///   1. Resolve the vars-file path; return Err if none of the candidate files exist.
///   2. Spawn the sidecar with `CARD_BROKER_VARS_FILE=<resolved_path>` injected into its env.
///   3. Drain stdout line-by-line until we see `{"event":"started","runId":N}` or the process
///      exits — whichever comes first. Return `{ started: true, run_id: Some(N) }`.
///   4. Continue draining stdout/stderr in a detached Tokio task so the sidecar keeps running
///      after this command returns (the process is NOT waited on by the caller).
///
/// SECURITY: No secret value is read, logged, or passed anywhere in this function.
///           Only the FILE PATH (not its contents) is injected as an env var.
#[tauri::command]
pub async fn run_local_scan(app: tauri::AppHandle) -> Result<LocalScanStarted, String> {
    // -- 1. Resolve vars-file path -------------------------------------------
    let vars_path = resolve_vars_file().ok_or_else(|| {
        "local scan not configured: no vars file found (expected worker/.dev.vars.local)"
            .to_string()
    })?;

    // Convert to a UTF-8 string for the env var. Path is always on the local FS so this
    // should be lossless; if not, fail fast with a clear message (not a panic).
    let vars_path_str = vars_path
        .to_str()
        .ok_or("vars file path contains non-UTF-8 characters")?;

    // -- 2. Build the sidecar command, injecting the FILE PATH (not secrets) --
    // NOTE: pass the BASENAME only. tauri-plugin-shell resolves a sidecar as
    // <exe_dir>/<arg>.exe (base_dir.join(arg)). Tauri copies the externalBin next
    // to the main exe as `scan-local.exe` (no `binaries/` subdir), so the arg here
    // must be "scan-local" — using "binaries/scan-local" makes it look for a
    // non-existent <exe_dir>/binaries/ folder → CreateProcess ERROR_PATH_NOT_FOUND.
    // The `binaries/` prefix belongs only in tauri.conf.json `externalBin` (the
    // build-time source path).
    let cmd = app
        .shell()
        .sidecar("scan-local")
        .map_err(|e| format!("failed to locate sidecar: {e}"))?
        .env("CARD_BROKER_VARS_FILE", vars_path_str);
    // The sidecar's env-local loader reads CARDTRADER_API_TOKEN, CF_API_TOKEN,
    // TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, etc. from the file at this path.
    // We do NOT read, log, or pass any of those values here.

    // -- 3. Spawn; read stdout until "started" or exit -----------------------
    let (mut rx, _child) = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn local scan: {e}"))?;

    use tauri_plugin_shell::process::CommandEvent;

    // Collect stdout lines until we see the "started" event.
    // A line budget prevents a runaway sidecar from stalling the command indefinitely.
    const MAX_PRE_START_LINES: usize = 256;
    let mut run_id: Option<u32> = None;
    let mut lines_seen = 0usize;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line_bytes) => {
                lines_seen += 1;
                let line = String::from_utf8_lossy(&line_bytes);
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    match v.get("event").and_then(|e| e.as_str()) {
                        Some("started") => {
                            run_id = v.get("runId").and_then(|r| r.as_u64()).map(|n| n as u32);
                            break;
                        }
                        Some("error") => {
                            let msg = v
                                .get("message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("sidecar config error");
                            return Err(format!("local scan failed: {msg}"));
                        }
                        _ => {}
                    }
                }
                if lines_seen >= MAX_PRE_START_LINES {
                    // Sidecar is alive but hasn't emitted "started" yet; treat as started
                    // with unknown run_id and let the background task keep draining.
                    break;
                }
            }
            CommandEvent::Stderr(line_bytes) => {
                // Log stderr at debug level only — no secret values (we never read them).
                let line = String::from_utf8_lossy(&line_bytes);
                log::debug!("[scan-local stderr] {}", line.trim());
            }
            CommandEvent::Terminated(status) => {
                let code = status.code.unwrap_or(-1);
                return Err(format!(
                    "local scan process exited before starting (code {code})"
                ));
            }
            _ => {}
        }
    }

    // -- 4. Hand off remaining stdout/stderr to a detached background task ----
    // The sidecar continues running; we just log "done"/"error" events.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes);
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                        match v.get("event").and_then(|e| e.as_str()) {
                            Some("done") => {
                                // Log aggregate counts only — never log field values.
                                let deals_found = v
                                    .get("summary")
                                    .and_then(|s| s.get("dealsFound"))
                                    .and_then(|n| n.as_u64())
                                    .unwrap_or(0);
                                log::info!("[scan-local] done. deals_found={deals_found}");
                            }
                            Some("error") => {
                                let msg = v
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("unknown error");
                                log::warn!("[scan-local] error: {msg}");
                            }
                            _ => {}
                        }
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes);
                    log::debug!("[scan-local stderr] {}", line.trim());
                }
                CommandEvent::Terminated(status) => {
                    log::info!(
                        "[scan-local] process terminated, exit code: {:?}",
                        status.code
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(LocalScanStarted {
        started: true,
        run_id,
    })
}

/// Spawn the `scan-local` sidecar in catalog-resync mode (full-heal blueprint
/// re-pull), passing the vars-file path via `CARD_BROKER_VARS_FILE` and the task
/// selector via `CARD_BROKER_TASK=catalog-resync`.
///
/// Mirrors `run_local_scan`: drains stdout until the sidecar emits
/// `{"event":"started","task":"catalog-resync","totalSets":N}` (or exits), then
/// returns `{ started: true, total_sets: Some(N) }`. The re-pull continues in a
/// detached task (~13 min for a full run) — the caller is NOT blocked on it.
///
/// SECURITY: only the vars-file PATH is injected as an env var; no secret value
/// is read, logged, or transmitted by this function.
#[tauri::command]
pub async fn run_local_catalog_resync(
    app: tauri::AppHandle,
) -> Result<CatalogResyncStarted, String> {
    let vars_path = resolve_vars_file().ok_or_else(|| {
        "local scan not configured: no vars file found (expected worker/.dev.vars.local)"
            .to_string()
    })?;
    let vars_path_str = vars_path
        .to_str()
        .ok_or("vars file path contains non-UTF-8 characters")?;

    let cmd = app
        .shell()
        .sidecar("scan-local")
        .map_err(|e| format!("failed to locate sidecar: {e}"))?
        .env("CARD_BROKER_VARS_FILE", vars_path_str)
        .env("CARD_BROKER_TASK", "catalog-resync");

    let (mut rx, _child) = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn catalog re-sync: {e}"))?;

    use tauri_plugin_shell::process::CommandEvent;

    const MAX_PRE_START_LINES: usize = 256;
    let mut total_sets: Option<u32> = None;
    let mut lines_seen = 0usize;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line_bytes) => {
                lines_seen += 1;
                let line = String::from_utf8_lossy(&line_bytes);
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    match v.get("event").and_then(|e| e.as_str()) {
                        Some("started") => {
                            total_sets =
                                v.get("totalSets").and_then(|r| r.as_u64()).map(|n| n as u32);
                            break;
                        }
                        Some("error") => {
                            let msg = v
                                .get("message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("sidecar config error");
                            return Err(format!("catalog re-sync failed: {msg}"));
                        }
                        _ => {}
                    }
                }
                if lines_seen >= MAX_PRE_START_LINES {
                    break;
                }
            }
            CommandEvent::Stderr(line_bytes) => {
                let line = String::from_utf8_lossy(&line_bytes);
                log::debug!("[catalog-resync stderr] {}", line.trim());
            }
            CommandEvent::Terminated(status) => {
                let code = status.code.unwrap_or(-1);
                return Err(format!(
                    "catalog re-sync process exited before starting (code {code})"
                ));
            }
            _ => {}
        }
    }

    // Detach: keep draining so the sidecar runs to completion in the background.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes);
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                        match v.get("event").and_then(|e| e.as_str()) {
                            Some("done") => {
                                let ok = v
                                    .get("summary")
                                    .and_then(|s| s.get("ok"))
                                    .and_then(|n| n.as_u64())
                                    .unwrap_or(0);
                                let grew = v
                                    .get("summary")
                                    .and_then(|s| s.get("grew"))
                                    .and_then(|n| n.as_u64())
                                    .unwrap_or(0);
                                log::info!("[catalog-resync] done. ok={ok} grew={grew}");
                            }
                            Some("error") => {
                                let msg = v
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("unknown error");
                                log::warn!("[catalog-resync] error: {msg}");
                            }
                            _ => {}
                        }
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes);
                    log::debug!("[catalog-resync stderr] {}", line.trim());
                }
                CommandEvent::Terminated(status) => {
                    log::info!(
                        "[catalog-resync] process terminated, exit code: {:?}",
                        status.code
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(CatalogResyncStarted {
        started: true,
        total_sets,
    })
}
