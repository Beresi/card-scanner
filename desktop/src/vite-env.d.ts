/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Cloudflare Worker API (e.g. https://api.example.workers.dev). */
  readonly VITE_API_BASE_URL?: string;
  /**
   * Dev-only Bearer token for local API calls.
   * TODO: replace with Tauri secure-storage get_auth_token() once security-agent
   * lands it (src-tauri stub exists). NEVER commit a real token here.
   */
  readonly VITE_DEV_AUTH_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
