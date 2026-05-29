/* ============================================================
   SCAN OVERLAY — live radar sweep with deals pinging in
   ============================================================ */
function ScanOverlay({ onComplete }) {
  const STEPS = [
    "open scan_runs · started_at",
    "GET /info · validate token … 200",
    "load active watchlist … 7 items",
    "GET marketplace/products · expansion_id=1623 … 25×1190",
    "GET marketplace/products · blueprint_id=100501 … 25",
    "filter EN · NM+ · non-vacation · price-sort",
    "median baseline · next-10 cohort",
    "threshold gate · upsert ON CONFLICT(product_id)",
    "route telegram · importance + discount gate",
    "close scan_runs · finished_at",
  ];
  const [step, setStep] = useState(0);
  const [pings, setPings] = useState([]);
  const [found, setFound] = useState(0);

  useEffect(() => {
    let i = 0;
    const iv = setInterval(() => {
      i++;
      setStep(i);
      if (i === 5) { spawnPing(); }
      if (i === 6) { spawnPing(); spawnPing(); }
      if (i === 8) { spawnPing(); }
      if (i >= STEPS.length) {
        clearInterval(iv);
        setTimeout(onComplete, 650);
      }
    }, 360);
    return () => clearInterval(iv);
  }, []);

  function spawnPing() {
    const angle = Math.random() * Math.PI * 2;
    const r = 28 + Math.random() * 52;
    const x = 50 + Math.cos(angle) * r * 0.5;
    const y = 50 + Math.sin(angle) * r * 0.5;
    setPings((p) => [...p, { id: Math.random(), x, y }]);
    setFound((f) => f + 1);
  }

  return (
    <div className="scan-overlay">
      <div className="scan-box chamfer bracket">
        <div className="scan-radar">
          <div className="radar-rings">
            <span className="radar-ring"></span><span className="radar-ring"></span><span className="radar-ring"></span>
            <span className="radar-cross-h"></span><span className="radar-cross-v"></span>
          </div>
          <div className="radar-sweep"></div>
          {pings.map((p) => (
            <span key={p.id} className="radar-ping" style={{ left: p.x + "%", top: p.y + "%" }}></span>
          ))}
          <div className="radar-center mono">{found}</div>
        </div>
        <div className="scan-feed">
          <div className="scan-feed-head eyebrow">scan in progress · {Math.min(step, STEPS.length)}/{STEPS.length}</div>
          <div className="scan-lines">
            {STEPS.slice(0, step).map((s, i) => (
              <div key={i} className={"scan-line " + (i === step - 1 ? "is-cur" : "")}>
                <span className="scan-line-mark">{i === step - 1 ? "▸" : "✓"}</span>
                <span>{s}</span>
              </div>
            ))}
          </div>
          <div className="scan-progress"><div className="scan-progress-fill" style={{ width: (step / STEPS.length * 100) + "%" }}></div></div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   APP SHELL
   ============================================================ */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#22d3ee",
  "glow": 1,
  "density": "comfortable",
  "scanlines": false,
  "gridBg": true,
  "fxDecrypt": true,
  "fxToasts": true,
  "fxBlips": true
}/*EDITMODE-END*/;

const ACCENTS = ["#22d3ee", "#37e0c8", "#5b8cff", "#f0387a", "#f5b945", "#45e0a0"];

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [booted, setBooted] = useState(() => localStorage.getItem("cardbroker_booted") === "1");
  const [view, setView] = useState("feed");
  const [deals, setDeals] = useState(CB.deals);
  const [watchlist, setWatchlist] = useState(CB.watchlist);
  const [config, setConfig] = useState(CB.config);
  const [scanning, setScanning] = useState(false);
  const [newDealIds, setNewDealIds] = useState([]);
  const [scanTarget, setScanTarget] = useState(() => Date.now() + (53 * 60 + 12) * 1000);
  const [selectedWatchId, setSelectedWatchId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toasts, setToasts] = useState([]);

  /* ⌘K command palette */
  useEffect(() => {
    function k(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((o) => !o); }
    }
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  function pushToast(toast) {
    const id = Math.random();
    setToasts((ts) => [...ts, { ...toast, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 4600);
  }

  /* apply appearance to :root */
  useEffect(() => {
    const r = document.documentElement;
    r.style.setProperty("--accent", t.accent);
    r.style.setProperty("--glow", String(t.glow));
    const dense = t.density === "compact";
    r.style.setProperty("--pad", dense ? "12px" : "18px");
    r.style.setProperty("--row", dense ? "9px" : "14px");
    document.body.classList.toggle("scanlines", !!t.scanlines);
    document.body.classList.toggle("no-grid", !t.gridBg);
  }, [t]);

  function boot() { localStorage.setItem("cardbroker_booted", "1"); setBooted(true); }

  function runScan() {
    setScanning(true);
  }
  function scanComplete() {
    // surface the most-recent open deals as freshly-found "pings"
    const freshDeals = deals.filter((d) => !d.dismissed).slice(0, 3);
    setNewDealIds(freshDeals.map((d) => d.id));
    setScanning(false);
    setScanTarget(Date.now() + 3600 * 1000);
    setView("feed");
    if (t.fxToasts) {
      freshDeals.filter((d) => d.priority === "high").slice(0, 2).forEach((d, i) => {
        setTimeout(() => pushToast({
          title: d.card_name, sub: `${d.expansion_name} · −${d.discount_pct}% · ${CB.usd(d.price_cents)}`,
          tone: "hot",
        }), 250 + i * 320);
      });
    }
    setTimeout(() => setNewDealIds([]), 2800);
  }

  function delWatch(id) {
    setWatchlist((ws) => ws.filter((w) => w.id !== id));
    setSelectedWatchId(null);
  }
  function changeWatch(id, patch) { setWatchlist((ws) => ws.map((w) => w.id === id ? { ...w, ...patch } : w)); }
  const selectedWatch = watchlist.find((w) => w.id === selectedWatchId);

  function renderAside() {
    if (view === "watchlist") {
      return selectedWatch
        ? <WatchInspector w={selectedWatch} config={config} onChange={changeWatch} onClose={() => setSelectedWatchId(null)} onDelete={delWatch} />
        : <WatchSummary watchlist={watchlist} onAdd={() => setAdding(true)} />;
    }
    return <Telemetry deals={deals} scanRuns={CB.scanRuns} scanTarget={scanTarget} onScan={runScan} scanning={scanning} blips={t.fxBlips} />;
  }

  /* command palette command set */
  function buildCommands() {
    const cmds = [
      { group: "Navigate", icon: "feed", label: "Deal Feed", hint: "home", run: () => setView("feed") },
      { group: "Navigate", icon: "watch", label: "Watchlist", run: () => { setSelectedWatchId(null); setView("watchlist"); } },
      { group: "Navigate", icon: "gear", label: "Settings", run: () => setView("settings") },
      { group: "Navigate", icon: "pulse", label: "Health", run: () => setView("health") },
      { group: "Actions", icon: "radar", label: "Run scan now", hint: "scan", run: () => runScan() },
      { group: "Actions", icon: "plus", label: "Add card or set to watchlist", run: () => { setView("watchlist"); setSelectedWatchId(null); setAdding(true); } },
      { group: "Actions", icon: "bolt", label: "Replay boot sequence", run: () => { localStorage.removeItem("cardbroker_booted"); location.reload(); } },
      { group: "Actions", icon: "layers", label: t.scanlines ? "Disable CRT scanlines" : "Enable CRT scanlines", run: () => setTweak("scanlines", !t.scanlines) },
    ];
    watchlist.forEach((w) => cmds.push({
      group: "Jump to watch item", icon: w.type === "expansion" ? "layers" : "card",
      label: w.label, hint: w.expansion,
      run: () => { setView("watchlist"); setSelectedWatchId(w.id); },
    }));
    return cmds;
  }

  const NAV = [
    { id: "feed", label: "Deal Feed", icon: "feed" },
    { id: "watchlist", label: "Watchlist", icon: "watch" },
    { id: "settings", label: "Settings", icon: "gear" },
    { id: "health", label: "Health", icon: "pulse" },
  ];
  const TITLES = {
    feed: ["Deal Feed", "underpriced-copy hunter · live"],
    watchlist: ["Watchlist", "cards & sets under surveillance"],
    settings: ["Settings", "one config · the single source of truth"],
    health: ["Health", "scanner observability"],
  };
  const openCount = deals.filter((d) => !d.dismissed && !d.seen).length;

  if (!booted) {
    return (<><div className="app-bg"></div><BootSequence onDone={boot} /></>);
  }

  const [title, subtitle] = TITLES[view];

  return (
    <>
      <div className="app-bg"></div>
      <div className="app-vignette"></div>

      <div className="shell">
        {/* LEFT RAIL — dim periphery */}
        <aside className="rail">
          <div className="rail-brand">
            <span className="rail-glyph">◈</span>
            <span className="rail-brand-text"><b>CARD</b><span className="rail-slash">//</span>BROKER</span>
          </div>

          <nav className="rail-nav">
            {NAV.map((n) => (
              <button key={n.id} className={"rail-item " + (view === n.id ? "is-on" : "")} onClick={() => setView(n.id)}>
                <I name={n.icon} size={18} />
                <span>{n.label}</span>
                {n.id === "feed" && openCount > 0 && <span className="rail-badge mono">{openCount}</span>}
                {view === n.id && <span className="rail-active-bar"></span>}
              </button>
            ))}
          </nav>

          <div className="rail-foot">
            <div className="rail-sys">
              <div className="rail-sys-row"><Status kind="live" pulse label="SCANNER ONLINE" /></div>
              <div className="rail-sys-row"><span className="eyebrow">next scan</span><Clock target={scanTarget} className="mono accent-text" /></div>
              <div className="rail-sys-row"><span className="eyebrow">currency</span><span className="mono">{config.currency}</span></div>
            </div>
          </div>
        </aside>

        {/* CENTER COLUMN — the focus zone */}
        <main className="stage">
          <header className="topstrip">
            <div className="topstrip-title">
              <h1>{title}</h1>
              <span className="eyebrow">{subtitle}</span>
            </div>
            <div className="topstrip-right">
              <button className="cmdk-chip" onClick={() => setPaletteOpen(true)} title="Command palette">
                <I name="search" size={13} /><span className="mono">⌘K</span>
              </button>
              <span className="topstrip-div"></span>
              <div className="topstrip-clock">
                <span className="eyebrow">next scan</span>
                <Clock target={scanTarget} className="mono accent-text" />
              </div>
              <span className="topstrip-div"></span>
              <Status kind="live" pulse label="API 200" />
            </div>
          </header>

          <div className="stage-scroll">
            <div className="stage-inner">
              {view === "feed" && (
                <DealFeed deals={deals} setDeals={setDeals} watchlist={watchlist}
                  newDealIds={newDealIds} decrypt={t.fxDecrypt} />
              )}
              {view === "watchlist" && (
                <Watchlist watchlist={watchlist} setWatchlist={setWatchlist} config={config}
                  selectedId={selectedWatchId} onSelect={setSelectedWatchId} adding={adding} setAdding={setAdding} />
              )}
              {view === "settings" && (
                <Settings config={config} setConfig={setConfig} onTest={() => {}}
                  accentOptions={ACCENTS} accent={t.accent} onAccent={(a) => setTweak("accent", a)} />
              )}
              {view === "health" && <Health scanRuns={CB.scanRuns} scanTarget={scanTarget} />}
            </div>
          </div>
        </main>

        <aside className="aside">
          {renderAside()}
        </aside>
      </div>

      {scanning && <ScanOverlay onComplete={scanComplete} />}
      {paletteOpen && <CommandPalette commands={buildCommands()} onClose={() => setPaletteOpen(false)} />}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={"toast chamfer-sm toast-" + (t.tone || "accent")}>
            <span className="toast-rail"></span>
            <div className="toast-body">
              <div className="toast-head"><I name="send" size={12} /><span className="eyebrow">priority deal · telegram</span></div>
              <div className="toast-title">{t.title}</div>
              <div className="toast-sub mono">{t.sub}</div>
            </div>
          </div>
        ))}
      </div>

      <TweaksPanel>
        <TweakSection label="Appearance" />
        <TweakColor label="Accent" value={t.accent} options={ACCENTS} onChange={(v) => setTweak("accent", v)} />
        <TweakSlider label="Glow" value={t.glow} min={0} max={1.6} step={0.1} onChange={(v) => setTweak("glow", v)} />
        <TweakRadio label="Density" value={t.density} options={["comfortable", "compact"]} onChange={(v) => setTweak("density", v)} />
        <TweakSection label="Atmosphere" />
        <TweakToggle label="CRT scanlines" value={t.scanlines} onChange={(v) => setTweak("scanlines", v)} />
        <TweakToggle label="Grid backdrop" value={t.gridBg} onChange={(v) => setTweak("gridBg", v)} />
        <TweakSection label="Effects" />
        <TweakToggle label="Decrypt reveal" value={t.fxDecrypt} onChange={(v) => setTweak("fxDecrypt", v)} />
        <TweakToggle label="Incoming toasts" value={t.fxToasts} onChange={(v) => setTweak("fxToasts", v)} />
        <TweakToggle label="Radar blips" value={t.fxBlips} onChange={(v) => setTweak("fxBlips", v)} />
        <TweakSection label="Sequence" />
        <TweakButton label="Replay boot" onClick={() => { localStorage.removeItem("cardbroker_booted"); location.reload(); }}>Replay</TweakButton>
      </TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
