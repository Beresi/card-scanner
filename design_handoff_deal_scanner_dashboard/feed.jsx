/* ============================================================
   DEAL FEED  — the primary center surface
   ============================================================ */
function DealCard({ d, onDismiss, onSeen, isNew, decrypt, stagger }) {
  const fresh = ago(d.found_at);
  const cond = CB.CONDITION_SHORT[d.condition] || d.condition;
  return (
    <article className={"deal chamfer-sm " + (d.priority === "high" ? "deal-high " : "") + (d.seen ? "deal-seen " : "") + (isNew ? "deal-ping " : "")}>
      {d.priority === "high" && <span className="deal-prio-rail"></span>}

      <div className="deal-top">
        <div className="deal-id">
          <ScrambleText text={d.card_name} active={isNew && decrypt} delay={stagger} className="deal-name" />
          <span className="deal-set mono">{d.expansion_name}</span>
        </div>
        <div className="deal-disc">
          <span className="deal-disc-num mono">−{d.discount_pct}%</span>
          <span className="eyebrow">under med</span>
        </div>
      </div>

      <div className="deal-pricing">
        <div className="deal-price-block">
          <span className="deal-price mono">{CB.usd(d.price_cents)}</span>
          <span className="deal-base mono">vs {CB.usd(d.baseline_cents)}</span>
          <span className="deal-save mono good-text">save {CB.usd(d.savings_cents)}</span>
        </div>
        <PriceBar price={d.price_cents} baseline={d.baseline_cents} />
      </div>

      <div className="deal-meta">
        <Tag tone={d.condition === "Near Mint" || d.condition === "Mint" ? "good" : "neutral"}>{cond}</Tag>
        <Tag>{d.foil ? "FOIL" : "NONFOIL"}</Tag>
        <Tag>EN</Tag>
        <Tag>q{d.quantity}</Tag>
        {d.can_sell_via_hub === 1 && <Tag tone="accent" title="CardTrader Zero eligible">CT0 ✓</Tag>}
      </div>

      <div className="deal-foot">
        <div className="deal-foot-left">
          <span className="deal-seller mono">{flag(d.seller_country)} {d.seller_username}</span>
          <span className="deal-foot-tags">
            {d.priority === "high" && <Tag tone="hot">PRIORITY</Tag>}
            {d.telegram_sent === 1 && <Tag tone="accent" title="Pushed to Telegram"><I name="send" size={10} /> SENT</Tag>}
            <span className="deal-age mono faint" title={new Date(d.found_at).toLocaleString()}>{fresh}</span>
          </span>
        </div>
        <div className="deal-actions">
          <a className="cb-btn cb-btn-primary cb-btn-sm" href={d.buy_url} target="_blank" rel="noreferrer">
            <span className="cb-btn-ico"><I name="ext" size={13} /></span><span>Buy</span>
          </a>
          {!d.seen && <Btn variant="quiet" size="sm" onClick={() => onSeen(d.id)} icon={<I name="eye" size={13} />} title="Mark seen" />}
          <Btn variant="quiet" size="sm" onClick={() => onDismiss(d.id)} icon={<I name="x" size={13} />} title="Dismiss" />
        </div>
      </div>
    </article>
  );
}

function DealFeed({ deals, setDeals, watchlist, newDealIds, decrypt }) {
  const [status, setStatus] = useState("open");      // open | all
  const [minDisc, setMinDisc] = useState(0);
  const [prio, setPrio] = useState("any");           // any | high
  const [wl, setWl] = useState("all");

  function dismiss(id) { setDeals((ds) => ds.map((d) => d.id === id ? { ...d, dismissed: 1 } : d)); }
  function seen(id) { setDeals((ds) => ds.map((d) => d.id === id ? { ...d, seen: 1 } : d)); }

  const filtered = deals.filter((d) => {
    if (status === "open" && d.dismissed) return false;
    if (d.discount_pct < minDisc) return false;
    if (prio === "high" && d.priority !== "high") return false;
    if (wl !== "all" && d.watchlist_id !== Number(wl)) return false;
    return true;
  });

  const openCount = deals.filter((d) => !d.dismissed).length;
  const newCount = deals.filter((d) => !d.dismissed && !d.seen).length;
  const totalSave = filtered.reduce((s, d) => s + d.savings_cents, 0);

  return (
    <div className="feed">
      {/* command strip */}
      <div className="feed-cmd">
        <div className="feed-cmd-left">
          <Segmented value={status} onChange={setStatus} size="sm"
            options={[{ value: "open", label: "Open" }, { value: "all", label: "All" }]} />
          <Segmented value={prio} onChange={setPrio} size="sm"
            options={[{ value: "any", label: "Any" }, { value: "high", label: "Priority" }]} />
          <div className="feed-wl">
            <I name="watch" size={13} className="dim" />
            <select className="cb-select feed-wl-sel" value={wl} onChange={(e) => setWl(e.target.value)}>
              <option value="all">All watch items</option>
              {watchlist.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          </div>
          <div className="feed-disc">
            <span className="eyebrow">min&nbsp;disc</span>
            <input type="range" min="0" max="80" step="5" value={minDisc} className="feed-range"
              onChange={(e) => setMinDisc(Number(e.target.value))} />
            <span className="mono feed-disc-val">{minDisc}%</span>
          </div>
        </div>
      </div>

      {/* readout strip */}
      <div className="feed-readout">
        <span><b className="mono accent-text">{filtered.length}</b> shown</span>
        <span className="feed-dot">·</span>
        <span><b className="mono">{openCount}</b> open</span>
        <span className="feed-dot">·</span>
        <span><b className="mono hot-text">{newCount}</b> unseen</span>
        <span className="feed-dot">·</span>
        <span>potential savings <b className="mono good-text">{CB.usd(totalSave)}</b></span>
      </div>

      {/* the list */}
      <div className="feed-list">
        {filtered.length === 0 && (
          <div className="feed-empty">
            <I name="radar" size={34} className="faint" />
            <p>No deals match these filters.</p>
            <span className="eyebrow">adjust filters or run a scan</span>
          </div>
        )}
        {filtered.map((d, i) => (
          <DealCard key={d.id} d={d} onDismiss={dismiss} onSeen={seen}
            isNew={newDealIds.includes(d.id)} decrypt={decrypt} stagger={newDealIds.indexOf(d.id) * 140} />
        ))}
      </div>
    </div>
  );
}
window.DealFeed = DealFeed;
