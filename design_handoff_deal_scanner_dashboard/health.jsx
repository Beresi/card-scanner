/* ============================================================
   HEALTH  — scan run observability
   ============================================================ */
function Health({ scanRuns, scanTarget }) {
  const last = scanRuns[0];
  const totalDeals = scanRuns.reduce((s, r) => s + r.deals_found, 0);
  const totalTg = scanRuns.reduce((s, r) => s + r.telegram_sent, 0);
  const lastError = scanRuns.find((r) => r.error);

  function dur(r) {
    if (!r.finished_at) return "—";
    const d = Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000);
    return d + "s";
  }

  return (
    <div className="health">
      {/* big status banner */}
      <Panel glow className="health-banner bracket">
        <div className="health-banner-in">
          <div className="health-state">
            <Status kind="live" pulse />
            <div>
              <div className="health-state-big">SCANNER ONLINE</div>
              <div className="eyebrow">all systems nominal · last run {ago(last.started_at)} ago</div>
            </div>
          </div>
          <div className="health-next">
            <span className="eyebrow">next scan</span>
            <Clock target={scanTarget} className="health-next-clock mono" />
          </div>
        </div>
      </Panel>

      {/* stat tiles */}
      <div className="health-stats">
        {[
          { k: "uplink", v: "200 OK", lbl: "cardtrader /info", tone: "good" },
          { k: "token", v: "VALID", lbl: "bearer · r/w scope", tone: "good" },
          { k: "telegram", v: "LINKED", lbl: "@cardbroker_bot", tone: "good" },
          { k: "deals", v: totalDeals, lbl: "found · last 6 runs", tone: "accent" },
          { k: "tg", v: totalTg, lbl: "pushed · last 6 runs", tone: "accent" },
          { k: "errors", v: lastError ? 1 : 0, lbl: "in window", tone: lastError ? "warn" : "good" },
        ].map((s) => (
          <div key={s.k} className={"health-tile chamfer-sm health-tile-" + s.tone}>
            <span className="health-tile-v mono">{s.v}</span>
            <span className="eyebrow">{s.lbl}</span>
          </div>
        ))}
      </div>

      {/* run log */}
      <Panel title="Scan run log" right={<span className="eyebrow">scan_runs · most recent first</span>} className="health-log">
        <div className="hlog">
          <div className="hlog-h mono">
            <span>RUN</span><span>STARTED</span><span>DUR</span><span>ITEMS</span><span>BLUEPRINTS</span><span>API</span><span>DEALS</span><span>TG</span><span>STATUS</span>
          </div>
          {scanRuns.map((r) => (
            <div key={r.id} className={"hlog-row mono " + (r.error ? "hlog-err" : "")}>
              <span className="faint">#{r.id}</span>
              <span>{new Date(r.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} <span className="faint">({ago(r.started_at)})</span></span>
              <span>{dur(r)}</span>
              <span>{r.watch_items_scanned}</span>
              <span>{r.blueprints_scanned.toLocaleString()}</span>
              <span>{r.api_calls}</span>
              <span className={r.deals_found ? "accent-text" : "faint"}>{r.deals_found}</span>
              <span className={r.telegram_sent ? "accent-text" : "faint"}>{r.telegram_sent}</span>
              <span>{r.error ? <Tag tone="warn" title={r.error}>WARN</Tag> : <Tag tone="good">OK</Tag>}</span>
            </div>
          ))}
        </div>
        {lastError && (
          <div className="hlog-detail">
            <I name="alert" size={14} className="hot-text" />
            <span className="mono">{lastError.error}</span>
            <span className="faint mono">— logged, non-fatal, blueprint skipped</span>
          </div>
        )}
      </Panel>
    </div>
  );
}
window.Health = Health;
