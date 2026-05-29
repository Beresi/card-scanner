// Placeholder shell — views (Deal Feed, Watchlist, Settings, Health) land in Phase 3.
// The cb-shell 3-column grid and backdrop are stubbed here so the token system
// is visible immediately. No API calls, no state.

export function App() {
  return (
    <>
      {/* Global backdrop: 44px grid + vignette (z-index 0, pointer-events none) */}
      <div className="cb-app-bg" aria-hidden="true" />
      <div className="cb-app-vignette" aria-hidden="true" />

      {/* 3-column shell skeleton */}
      <div className="cb-shell">
        {/* Left rail — nav (stub) */}
        <aside className="cb-rail-left" />

        {/* Center stage */}
        <main className="cb-stage">
          <div className="cb-stage-scroll">
            <div style={{ padding: "var(--pad)", maxWidth: 1480, margin: "0 auto" }}>
              <p className="cb-eyebrow" style={{ marginBottom: 8 }}>card // broker</p>
              <h1 style={{ color: "var(--accent)", marginBottom: 4 }}>◈ CARD // BROKER</h1>
              <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
                Desktop shell — views arrive in Phase 3.
              </p>
            </div>
          </div>
        </main>

        {/* Right rail — telemetry (stub) */}
        <aside className="cb-rail-right" />
      </div>
    </>
  );
}
