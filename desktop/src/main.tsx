import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App";
import { EffectsProvider } from "./effects/EffectsContext";

// Self-hosted fonts (bundled by Vite — no runtime CDN fetch, Tauri-offline safe).
// Chakra Petch = display/UI; IBM Plex Mono = data/numbers/eyebrows. Weights match
// the --f-* token stacks in tokens.css.
import "@fontsource/chakra-petch/400.css";
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/chakra-petch/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";

// Additional UI font choices (font-selector in Settings).
// Orbitron: display/headings, weights 400/500/700.
import "@fontsource/orbitron/400.css";
import "@fontsource/orbitron/500.css";
import "@fontsource/orbitron/700.css";
// Rajdhani: compact humanist, weights 400/500/600/700.
import "@fontsource/rajdhani/400.css";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/rajdhani/700.css";
// JetBrains Mono: mono pair for Rajdhani/Orbitron, weights 400/500/600.
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
// Space Mono: retro mono pair, weights 400/700.
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/primitives-ext.css";
import "./styles/watchlist.css";
import "./styles/settings.css";
import "./styles/health.css";
import "./styles/telemetry.css";
import "./styles/overlays.css";
import "./styles/boot.css";
import "./styles/effects.css";
import "./styles/cart.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cloud API calls; stale after 30 s, retry once on failure
      staleTime: 30_000,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <EffectsProvider>
        <App />
      </EffectsProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
