import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App";
import { EffectsProvider } from "./effects/EffectsContext";
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
