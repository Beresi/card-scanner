import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // Tauri-specific: suppress vite output so the Tauri CLI output is visible
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Watch the Rust sources so `tauri dev` can reload on host changes
      ignored: ["**/src-tauri/**"],
    },
  },

  // Expose VITE_ and TAURI_ env vars to the webview
  envPrefix: ["VITE_", "TAURI_"],

  build: {
    // Tauri supports ES2021+; the webview is Chromium-based on all platforms
    target: "es2021",
    // Inline assets below 1 MB so the dist is a single bundle for Tauri
    assetsInlineLimit: 0,
  },
});
