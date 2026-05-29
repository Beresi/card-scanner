/* ============================================================
   SETTINGS  — single config row, grouped sections
   ============================================================ */
function Row({ label, hint, children }) {
  return (
    <div className="set-row">
      <div className="set-row-lbl">
        <span>{label}</span>
        {hint && <span className="set-row-hint mono faint">{hint}</span>}
      </div>
      <div className="set-row-ctl">{children}</div>
    </div>
  );
}

function Settings({ config, setConfig, onTest, accentOptions, accent, onAccent }) {
  const c = config;
  const set = (patch) => setConfig((p) => ({ ...p, ...patch }));
  const [tested, setTested] = useState(false);

  function num(field, w = 92) {
    return <input className={"cb-input cb-num"} style={{ width: w }} type="number" value={c[field]}
      onChange={(e) => set({ [field]: Number(e.target.value) })} />;
  }

  return (
    <div className="settings">
      {/* APPEARANCE */}
      <Panel title="Appearance" className="set-panel">
        <Row label="Theme" hint="dark-first build">
          <Segmented value={c.theme} size="sm"
            options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }]}
            onChange={(v) => set({ theme: v })} />
        </Row>
        <Row label="Accent color" hint="applies live">
          <div className="set-swatches">
            {accentOptions.map((a) => (
              <button key={a} className={"set-swatch " + (accent === a ? "is-on" : "")} style={{ "--sw": a }}
                onClick={() => onAccent(a)} title={a} />
            ))}
          </div>
        </Row>
        <Row label="List density" hint="applies live">
          <Segmented value={c.density} size="sm"
            options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]}
            onChange={(v) => set({ density: v })} />
        </Row>
      </Panel>

      {/* NEW-TICKET DEFAULTS */}
      <Panel title="New-ticket defaults" className="set-panel"
        right={<span className="eyebrow">moving baseline · §9a</span>}>
        <p className="set-blurb mono faint">Items left to “inherit” follow these live. Changing a default retroactively updates every inheriting item.</p>
        <div className="set-grid">
          <Row label="Default threshold">
            <div className="wrow-inline">
              <input type="range" min="20" max="90" step="5" value={c.default_threshold_pct} className="feed-range"
                onChange={(e) => set({ default_threshold_pct: Number(e.target.value) })} />
              <span className="mono wrow-val">{c.default_threshold_pct}%</span>
            </div>
          </Row>
          <Row label="Default min condition">
            <select className="cb-select" value={c.default_min_condition} onChange={(e) => set({ default_min_condition: e.target.value })}>
              {CB.CONDITIONS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </Row>
          <Row label="Cohort size" hint="next-N cheapest">{num("cohort_size")}</Row>
          <Row label="Min comparators" hint="thin-market floor">{num("min_cohort")}</Row>
          <Row label="New-item foil pref">
            <Segmented value={c.new_ticket_foil_pref} size="sm"
              options={[{ value: "any", label: "Any" }, { value: "nonfoil", label: "Nonfoil" }, { value: "foil", label: "Foil" }]}
              onChange={(v) => set({ new_ticket_foil_pref: v })} />
          </Row>
          <Row label="New-item importance">
            <Segmented value={c.new_ticket_importance} size="sm"
              options={[{ value: "normal", label: "Normal" }, { value: "high", label: "High" }]}
              onChange={(v) => set({ new_ticket_importance: v })} />
          </Row>
        </div>
      </Panel>

      {/* NOTIFICATIONS */}
      <Panel title="Notifications" className="set-panel">
        <Row label="Telegram bot" hint="@cardbroker_bot">
          <span className="set-tg">
            <Status kind="live" pulse label="LINKED" />
            <Btn variant="quiet" size="sm" icon={<I name="send" size={13} />}
              onClick={() => { onTest(); setTested(true); setTimeout(() => setTested(false), 2400); }}>
              {tested ? "Sent ✓" : "Send test"}
            </Btn>
          </span>
        </Row>
        <Row label="Global TG min discount" hint="stricter than app threshold">
          <div className="wrow-inline">
            <input type="range" min="40" max="90" step="5" value={c.telegram_min_discount_pct} className="feed-range"
              onChange={(e) => set({ telegram_min_discount_pct: Number(e.target.value) })} />
            <span className="mono wrow-val">{c.telegram_min_discount_pct}%</span>
          </div>
        </Row>
        <Row label="Quiet hours" hint="hold pushes · digest after">
          <div className="set-quiet">
            <span className="mono">{String(c.quiet_hours_start).padStart(2, "0")}:00</span>
            <span className="faint">→</span>
            <span className="mono">{String(c.quiet_hours_end).padStart(2, "0")}:00</span>
            <span className="set-quiet-tz mono faint">{c.timezone}</span>
            <Switch on={!!c.digest_on_quiet_end} onChange={(v) => set({ digest_on_quiet_end: v ? 1 : 0 })} label="digest" />
          </div>
        </Row>
      </Panel>

      {/* SCAN & DATA */}
      <Panel title="Scan & data" className="set-panel">
        <Row label="Schedule" hint="read-only in v1">
          <span className="mono set-cron">crons = ["0 * * * *"] <span className="faint">· hourly · UTC</span></span>
        </Row>
        <Row label="Account currency"><span className="mono">{c.currency}</span></Row>
        <Row label="CardTrader token" hint="GET /info">
          <Status kind="live" label="VALID · read·write scope" />
        </Row>
        <Row label="Deal retention" hint="auto-prune older · 0 = forever">
          <div className="wrow-inline">{num("deal_retention_days", 78)}<span className="mono dim">days</span></div>
        </Row>
      </Panel>

      {/* MAINTENANCE */}
      <Panel title="Maintenance" className="set-panel">
        <Row label="Replay boot sequence">
          <Btn variant="quiet" size="sm" icon={<I name="bolt" size={13} />}
            onClick={() => { localStorage.removeItem("cardbroker_booted"); location.reload(); }}>Replay on reload</Btn>
        </Row>
        <Row label="Clear all deals" hint="irreversible">
          <Btn variant="danger" size="sm" icon={<I name="x" size={13} />}>Clear feed</Btn>
        </Row>
      </Panel>
    </div>
  );
}
window.Settings = Settings;
