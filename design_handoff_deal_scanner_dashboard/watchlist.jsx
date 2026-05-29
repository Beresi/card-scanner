/* ============================================================
   WATCHLIST  — dense table (scales to 40+) + inspector panel
   ============================================================ */

/* effective value resolver */
function effOf(w, field, def) { return w[field] == null ? def : w[field]; }

/* ---- one compact table row ---- */
function WatchRow({ w, config, selected, onSelect, onChange }) {
  const thr = effOf(w, "threshold_pct", config.default_threshold_pct);
  const cond = effOf(w, "min_condition", config.default_min_condition);
  return (
    <div className={"wr " + (selected ? "is-sel " : "") + (w.active ? "" : "wr-off ")} onClick={() => onSelect(w.id)}>
      <span className="wr-type">
        <I name={w.type === "expansion" ? "layers" : "card"} size={15} className={w.type === "expansion" ? "accent-text" : "dim"} />
      </span>
      <span className="wr-name">
        <span className="wr-label">{w.label}</span>
        <span className="wr-exp mono">{w.expansion}</span>
      </span>
      <span className="wr-c wr-cond"><Tag tone={cond === "Near Mint" || cond === "Mint" ? "good" : "neutral"}>{CB.CONDITION_SHORT[cond]}+</Tag></span>
      <span className="wr-c wr-foil mono">{w.foil_pref}</span>
      <span className="wr-c wr-thr mono">≤{thr}%</span>
      <span className="wr-c wr-imp">{w.importance === "high" ? <Tag tone="hot">HIGH</Tag> : <span className="faint mono">normal</span>}</span>
      <span className="wr-c wr-tg">{w.telegram_enabled === 1 ? <Tag tone="accent"><I name="send" size={10} /></Tag> : <span className="faint">—</span>}</span>
      <span className="wr-c wr-hits mono"><span className={w.hits ? "accent-text" : "faint"}>{w.hits}</span></span>
      <span className="wr-c wr-act" onClick={(e) => e.stopPropagation()}>
        <Switch on={!!w.active} onChange={(v) => onChange(w.id, { active: v ? 1 : 0 })} label="active" />
      </span>
    </div>
  );
}

/* ---- inspector / editor (lives in the right rail) ---- */
function WatchInspector({ w, config, onChange, onClose, onDelete }) {
  const thr = effOf(w, "threshold_pct", config.default_threshold_pct);
  const cond = effOf(w, "min_condition", config.default_min_condition);
  const tgDisc = effOf(w, "telegram_min_discount_pct", config.telegram_min_discount_pct);
  return (
    <div className="insp">
      <div className="insp-head">
        <div className="insp-head-id">
          <I name={w.type === "expansion" ? "layers" : "card"} size={16} className={w.type === "expansion" ? "accent-text" : "dim"} />
          <div>
            <div className="insp-title">{w.label}</div>
            <div className="insp-sub mono">{w.expansion} · #{w.cardtrader_id}</div>
          </div>
        </div>
        <button className="addflow-close" onClick={onClose} title="Close inspector"><I name="x" size={15} /></button>
      </div>

      <div className="insp-body">
        <InheritField label="Threshold" inherited={w.threshold_pct == null} defaultLabel={config.default_threshold_pct + "%"}
          onReset={() => onChange(w.id, { threshold_pct: null })}>
          <div className="wrow-inline">
            <input type="range" min="20" max="90" step="5" value={thr} className="feed-range"
              onChange={(e) => onChange(w.id, { threshold_pct: Number(e.target.value) })} />
            <span className="mono wrow-val">{thr}%</span>
          </div>
        </InheritField>

        <InheritField label="Min condition" inherited={w.min_condition == null} defaultLabel={config.default_min_condition}
          onReset={() => onChange(w.id, { min_condition: null })}>
          <select className="cb-select" value={cond} onChange={(e) => onChange(w.id, { min_condition: e.target.value })}>
            {CB.CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </InheritField>

        <div className="cb-ifield">
          <div className="cb-ifield-top"><span className="cb-ifield-lbl">Foil preference</span></div>
          <Segmented value={w.foil_pref} size="sm"
            options={[{ value: "any", label: "Any" }, { value: "nonfoil", label: "Nonfoil" }, { value: "foil", label: "Foil" }]}
            onChange={(v) => onChange(w.id, { foil_pref: v })} />
        </div>

        <div className="cb-ifield">
          <div className="cb-ifield-top"><span className="cb-ifield-lbl">Importance</span></div>
          <Segmented value={w.importance} size="sm"
            options={[{ value: "normal", label: "Normal" }, { value: "high", label: "High · bypass" }]}
            onChange={(v) => onChange(w.id, { importance: v })} />
        </div>

        <div className="insp-tg">
          <div className="wrow-tg-head">
            <span className="eyebrow">Telegram routing</span>
            <Switch on={!!w.telegram_enabled} onChange={(v) => onChange(w.id, { telegram_enabled: v ? 1 : 0 })} />
          </div>
          <InheritField label="Min discount" inherited={w.telegram_min_discount_pct == null} defaultLabel={config.telegram_min_discount_pct + "%"}
            onReset={() => onChange(w.id, { telegram_min_discount_pct: null })}>
            <div className="wrow-inline">
              <input type="range" min="40" max="90" step="5" value={tgDisc} className="feed-range"
                onChange={(e) => onChange(w.id, { telegram_min_discount_pct: Number(e.target.value) })} />
              <span className="mono wrow-val">{tgDisc}%</span>
            </div>
          </InheritField>
          <InheritField label="Max price" inherited={w.telegram_max_price_cents == null} defaultLabel="no cap"
            onReset={() => onChange(w.id, { telegram_max_price_cents: null })}>
            <input className="cb-input" placeholder="no cap"
              value={w.telegram_max_price_cents == null ? "" : (w.telegram_max_price_cents / 100).toFixed(2)}
              onChange={(e) => { const v = e.target.value.trim(); onChange(w.id, { telegram_max_price_cents: v === "" ? null : Math.round(parseFloat(v) * 100) || null }); }} />
          </InheritField>
          <p className="wrow-note mono faint">
            {w.importance === "high"
              ? "High importance → pushes on ANY deal, bypassing the discount gate."
              : w.telegram_enabled
                ? `Pushes only when discount ≥ ${tgDisc}% (stricter than the ${thr}% app threshold).`
                : "App-only. Appears in the feed but never pings Telegram."}
          </p>
        </div>

        <div className="insp-foot">
          <Btn variant="danger" size="sm" icon={<I name="x" size={13} />} onClick={() => onDelete(w.id)}>Remove from watchlist</Btn>
        </div>
      </div>
    </div>
  );
}

function AddFlow({ config, onAdd, onClose }) {
  const [kind, setKind] = useState("card");
  const [exp, setExp] = useState(null);
  const [q, setQ] = useState("");
  const expansions = CB.expansions;
  const matchedExp = expansions.filter((e) => (e.name + e.code).toLowerCase().includes(q.toLowerCase()));
  const cards = exp ? CB.blueprints.filter((b) => b.expansion_id === exp.id) : [];
  const matchedCards = cards.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  function addSet(e) { onAdd({ type: "expansion", cardtrader_id: e.id, label: e.name, expansion: "— full set —" }); }
  function addCard(c) { onAdd({ type: "blueprint", cardtrader_id: c.id, label: c.name, expansion: exp.name }); }

  return (
    <div className="addflow-overlay" onClick={onClose}>
      <div className="addflow chamfer bracket" onClick={(e) => e.stopPropagation()}>
        <div className="addflow-head">
          <span className="eyebrow">add to watchlist · game: magic the gathering</span>
          <button className="addflow-close" onClick={onClose}><I name="x" size={16} /></button>
        </div>
        <Segmented value={kind} onChange={(v) => { setKind(v); setQ(""); setExp(null); }}
          options={[{ value: "card", label: "Watch a card" }, { value: "set", label: "Watch a whole set" }]} />
        {kind === "set" && (
          <div className="addflow-body">
            <div className="addflow-search">
              <I name="search" size={15} className="dim" />
              <input className="cb-input" autoFocus placeholder="search expansions by name or code…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="addflow-results">
              {matchedExp.map((e) => (
                <button key={e.id} className="addflow-opt" onClick={() => addSet(e)}>
                  <I name="layers" size={15} className="accent-text" />
                  <span className="addflow-opt-name">{e.name}</span>
                  <span className="mono faint">{e.code.toUpperCase()} · #{e.id}</span>
                  <I name="plus" size={14} className="dim addflow-opt-add" />
                </button>
              ))}
            </div>
          </div>
        )}
        {kind === "card" && (
          <div className="addflow-body">
            {!exp ? (
              <>
                <p className="addflow-step eyebrow">step 1 · pick the set</p>
                <div className="addflow-search">
                  <I name="search" size={15} className="dim" />
                  <input className="cb-input" autoFocus placeholder="search expansions…" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                <div className="addflow-results">
                  {matchedExp.map((e) => (
                    <button key={e.id} className="addflow-opt" onClick={() => { setExp(e); setQ(""); }}>
                      <I name="layers" size={15} className="accent-text" />
                      <span className="addflow-opt-name">{e.name}</span>
                      <span className="mono faint">{e.code.toUpperCase()}</span>
                      <span className="addflow-opt-add mono dim">select ›</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="addflow-step eyebrow">
                  step 2 · pick a card in <span className="accent-text">{exp.name}</span>
                  <button className="addflow-back" onClick={() => { setExp(null); setQ(""); }}>‹ change set</button>
                </p>
                <div className="addflow-search">
                  <I name="search" size={15} className="dim" />
                  <input className="cb-input" autoFocus placeholder="search cards…" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                <div className="addflow-results">
                  {matchedCards.length === 0 && <p className="mono faint addflow-none">no cached cards match — type to search</p>}
                  {matchedCards.map((c) => (
                    <button key={c.id} className="addflow-opt" onClick={() => addCard(c)}>
                      <I name="card" size={15} className="dim" />
                      <span className="addflow-opt-name">{c.name}</span>
                      <span className="mono faint">#{c.id}</span>
                      <I name="plus" size={14} className="dim addflow-opt-add" />
                    </button>
                  ))}
                </div>
              </>
            )}
            <p className="addflow-hint mono faint">tip · paste a cardtrader card URL to add by id</p>
          </div>
        )}
      </div>
    </div>
  );
}

const SORTS = {
  recent: (a, b) => b.id - a.id,
  name: (a, b) => a.label.localeCompare(b.label),
  hits: (a, b) => b.hits - a.hits,
  importance: (a, b) => (b.importance === "high") - (a.importance === "high"),
};

function Watchlist({ watchlist, setWatchlist, config, selectedId, onSelect, adding, setAdding }) {
  const [sort, setSort] = useState("recent");
  const [filter, setFilter] = useState("all"); // all | active | high | tg
  const [q, setQ] = useState("");

  function change(id, patch) { setWatchlist((ws) => ws.map((w) => w.id === id ? { ...w, ...patch } : w)); }

  let rows = watchlist.filter((w) => {
    if (filter === "active" && !w.active) return false;
    if (filter === "high" && w.importance !== "high") return false;
    if (filter === "tg" && w.telegram_enabled !== 1) return false;
    if (q && !(w.label + w.expansion).toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  rows = [...rows].sort(SORTS[sort]);

  return (
    <div className="wlist">
      <div className="wlist-cmd">
        <div className="wlist-cmd-left">
          <div className="wlist-search">
            <I name="search" size={14} className="dim" />
            <input className="cb-input" placeholder="filter cards & sets…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Segmented value={filter} onChange={setFilter} size="sm"
            options={[{ value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "high", label: "High" }, { value: "tg", label: "TG" }]} />
        </div>
        <div className="wlist-cmd-right">
          <div className="wlist-sort">
            <span className="eyebrow">sort</span>
            <select className="cb-select" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="recent">Recent</option>
              <option value="name">Name</option>
              <option value="hits">Hits</option>
              <option value="importance">Importance</option>
            </select>
          </div>
          <Btn variant="primary" onClick={() => setAdding(true)} icon={<I name="plus" size={15} />}>Add</Btn>
        </div>
      </div>

      <div className="wtable">
        <div className="wt-head mono">
          <span></span><span>CARD / SET</span><span className="wr-c">COND</span><span className="wr-c">FOIL</span>
          <span className="wr-c">THRESH</span><span className="wr-c">IMP</span><span className="wr-c">TG</span><span className="wr-c">HITS</span><span className="wr-c">ON</span>
        </div>
        <div className="wt-body">
          {rows.length === 0 && <div className="wt-empty mono faint">no items match this filter</div>}
          {rows.map((w) => (
            <WatchRow key={w.id} w={w} config={config} selected={selectedId === w.id} onSelect={onSelect} onChange={change} />
          ))}
        </div>
      </div>

      {adding && <AddFlow config={config} onAdd={(item) => {
        const id = Math.max(0, ...watchlist.map((w) => w.id)) + 1;
        setWatchlist((ws) => [{
          id, active: 1, hits: 0, min_condition: null, foil_pref: config.new_ticket_foil_pref,
          allow_graded: config.new_ticket_allow_graded, threshold_pct: null, importance: config.new_ticket_importance,
          telegram_enabled: config.new_ticket_telegram_enabled, telegram_min_discount_pct: null,
          telegram_max_price_cents: null, telegram_min_savings_cents: null, ...item,
        }, ...ws]);
        setAdding(false);
        onSelect(id);
      }} onClose={() => setAdding(false)} />}
    </div>
  );
}

window.Watchlist = Watchlist;
window.WatchInspector = WatchInspector;
window.effOf = effOf;
