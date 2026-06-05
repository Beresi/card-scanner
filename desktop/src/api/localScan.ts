/**
 * localScan.ts — typed wrappers around the Tauri sidecar scan commands.
 *
 * The three invoke commands are:
 *   get_local_scan_status  — returns { configured, hasTelegram }
 *   local_scan_available   — boolean shorthand for status.configured
 *   run_local_scan         — fires the sidecar (detached); returns once "started" event emits
 *
 * Credentials are configured via worker/.dev.vars.local (reuses .dev.vars) on the
 * host machine — not entered through the UI. set_local_scan_config is removed.
 *
 * Non-Tauri context (plain browser dev session or invoke throws):
 *   getLocalScanStatus → { configured: false, hasTelegram: false } (never throws)
 *   runLocalScan       → throws Error (surfaced to the UI as a toast)
 */

/**
 * True only inside the Tauri webview, where the Rust host injects
 * window.__TAURI_INTERNALS__. In a plain browser tab (Vite `npm run dev`) this
 * is undefined, and any invoke() would throw the cryptic
 * "Cannot read properties of undefined (reading 'invoke')". Guarding up front
 * lets us return a clear, actionable message instead.
 */
function isTauriAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
      'undefined'
  );
}

/** Message shown whenever a local-scan command is attempted from a browser tab. */
const NOT_DESKTOP_MSG =
  'Local scan is only available in the Card // Broker desktop app — you appear to be in a browser tab. Launch the desktop app (or `npm run tauri dev`) and try again.';

// Dynamically import invoke so tree-shaking works in plain-browser builds and
// the import itself does not throw when @tauri-apps/api is absent.
async function invokeOrNull<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauriAvailable()) { return null; }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status returned by get_local_scan_status / getLocalScanStatus(). */
export interface LocalScanStatus {
  /** True when all four required credentials are present on this device. */
  configured: boolean;
  /** True when Telegram credentials are also stored alongside the required set. */
  hasTelegram: boolean;
}

/** Result from run_local_scan / runLocalScan(). */
export interface LocalScanResult {
  started: boolean;
  runId: number | null;
}

// ---------------------------------------------------------------------------
// getLocalScanStatus
// ---------------------------------------------------------------------------

/**
 * Returns the local scan configuration status from OS secure storage.
 *
 * Falls back to { configured: false, hasTelegram: false } when:
 *   - the app is running in a plain browser (no Tauri host)
 *   - invoke throws for any reason (keychain unavailable, command not found)
 *
 * Never throws — callers can safely call this unconditionally.
 */
export async function getLocalScanStatus(): Promise<LocalScanStatus> {
  try {
    const result = await invokeOrNull<LocalScanStatus>('get_local_scan_status');
    if (result && typeof result.configured === 'boolean') {
      return result;
    }
  } catch {
    // Intentionally ignored — fall through to default.
  }
  return { configured: false, hasTelegram: false };
}

// ---------------------------------------------------------------------------
// runLocalScan
// ---------------------------------------------------------------------------

/**
 * Fires the local sidecar scan (detached).
 *
 * Returns once the sidecar emits its "started" event — the scan continues
 * running long after this promise resolves. Poll scan_runs / health for progress.
 *
 * Throws an Error with a human-readable message when:
 *   - not configured (credentials missing)
 *   - the Tauri host is unavailable (plain browser session)
 *   - the sidecar is missing or dies before the "started" event
 */
export async function runLocalScan(): Promise<LocalScanResult> {
  if (!isTauriAvailable()) { throw new Error(NOT_DESKTOP_MSG); }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<LocalScanResult>('run_local_scan');
    return result;
  } catch (err) {
    // invoke throws a string message when the Tauri command returns Err(String)
    const msg =
      typeof err === 'string'
        ? err
        : err instanceof Error
        ? err.message
        : 'Local scan failed to start.';
    throw new Error(msg);
  }
}

