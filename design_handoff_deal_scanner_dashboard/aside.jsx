/* ============================================================
   RIGHT RAIL — telemetry (feed/settings/health) + watch summary
   ============================================================ */

function MiniRadar({ active, blips }) {
  return (
    <div className={"mradar " + (active ? "is-live" : "")}>
      <span className="mradar-ring"></span>
      <span className="mradar-ring"></span>
      <span className="mradar-cross-h"></span>
      <span className="mradar-cross-v"></span>
      <span className="mradar-sweep"></span>
      {blips && (
        <>
          <span className="mradar-blip" style={{ left: "68%", top: "38%", animationDelay: "0s" }}></span>
          <span className="mradar-blip" style={{ left: "34%", top: "62%", animationDelay: "1.3s" }}></span>
          <span className="mradar-blip" style={{ left: "58%", top: "70%", animationDelay: "2.4s" }}></span>
        </>
      )}
    </div>
  );
}

function StatCell({ v, label, tone }) {
  return (
    <div className={"tstat tstat-" + (tone || "default")}>
      <span className="tstat-v mono">{v}</span>
      <span className="eyebrow">{label}</span>
    </div>
  );
}

function Telemetry({ deals, scanRuns, scanTarget, onScan, scanning, blips }) {
  const open = deals.filter((d) => !d.dismissed);
  const unseen = open.filter((d) => !d.seen).length;
  const savings = open.reduce((s, d) => s + d.savings_cents, 0);
  const scansToday = scanRuns.length;
  const tgToday = scanRuns.reduce((s, r) => s + r.telegram_sent, 0);

  // discount distribution buckets
  const buckets = [
    { k: "40–49", min: 40, max: 49 }, { k: "50–59", min: 50, max: 59 },
    { k: "60–69", min: 60, max: 69 }, { k: "70 +", min: 70, max: 999 },
  ].map((b) => ({ ...b, n: open.filter((d) => d.discount_pct >= b.min && d.discount_pct <= b.max).length }));
  const maxB = Math.max(1, ...buckets.map((b) => b.n));

  // activity log
  const activity = [...open].sort((a, b) => new Date(b.found_at) - new Date(a.found_at)).slice(0, 7);

  return (
    <div className="tele">
      <div className="tele-scan bracket">
        <MiniRadar active={scanning} blips={blips} />
        <div className="tele-scan-info">
          <span className="eyebrow">next scan</span>
          <Clock target={scanTarget} className="tele-clock mono" />
          <Status kind="live" pulse label="HOURLY · ARMED" />
        </div>
      </div>
      <Btn variant="primary" size="md" onClick={onScan} disabled={scanning} icon={<I name="radar" size={15} />}>
        {scanning ? "Scanning…" : "Scan now"}
      </Btn>

      <div className="tele-sec eyebrow">session</div>
      <div className="tstat-grid">
        <StatCell v={open.length} label="open deals" tone="accent" />
        <StatCell v={unseen} label="unseen" tone="hot" />
        <StatCell v={CB.usd(savings)} label="potential save" tone="good" />
        <StatCell v={scansToday} label="scans · 6h" />
      </div>

      <div className="tele-sec eyebrow">discount spread</div>
      <div className="tdist">
        {buckets.map((b) => (
          <div key={b.k} className="tdist-row">
            <span className="tdist-k mono">{b.k}%</span>
            <span className="tdist-bar"><span className="tdist-fill" style={{ width: (b.n / maxB * 100) + "%" }}></span></span>
            <span className="tdist-n mono">{b.n}</span>
          </div>
        ))}
      </div>

      <div className="tele-sec eyebrow">activity log</div>
      <div className="tlog">
        {activity.map((d) => (
          <div key={d.id} className="tlog-row">
            <span className={"dot " + (d.priority === "high" ? "dot-hot" : "dot-live")}></span>
            <span className="tlog-name">{d.card_name}</span>
            <span className="tlog-disc mono good-text">−{d.discount_pct}%</span>
            <span className="tlog-age mono faint">{ago(d.found_at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WatchSummary({ watchlist, onAdd }) {
  const active = watchlist.filter((w) => w.active).length;
  const high = watchlist.filter((w) => w.importance === "high").length;
  const tg = watchlist.filter((w) => w.telegram_enabled === 1).length;
  const sets = watchlist.filter((w) => w.type === "expansion").length;
  const cards = watchlist.length - sets;
  const totalHits = watchlist.reduce((s, w) => s + w.hits, 0);

  return (
    <div className="tele">
      <div className="tele-sec eyebrow">watchlist</div>
      <div className="tstat-grid">
        <StatCell v={watchlist.length} label="items" tone="accent" />
        <StatCell v={active} label="active" tone="good" />
        <StatCell v={high} label="high-priority" tone="hot" />
        <StatCell v={tg} label="telegram on" />
      </div>

      <div className="tele-sec eyebrow">composition</div>
      <div className="tdist">
        <div className="tdist-row"><span className="tdist-k mono">cards</span><span className="tdist-bar"><span className="tdist-fill" style={{ width: (cards / watchlist.length * 100) + "%" }}></span></span><span className="tdist-n mono">{cards}</span></div>
        <div className="tdist-row"><span className="tdist-k mono">sets</span><span className="tdist-bar"><span className="tdist-fill" style={{ width: (sets / watchlist.length * 100) + "%" }}></span></span><span className="tdist-n mono">{sets}</span></div>
      </div>

      <div className="tele-sec eyebrow">lifetime hits</div>
      <div className="tstat tstat-accent" style={{ marginBottom: 4 }}>
        <span className="tstat-v mono">{totalHits}</span>
        <span className="eyebrow">deals surfaced from these items</span>
      </div>

      <div className="ws-hint mono faint">Select any row to edit thresholds, condition, and Telegram routing in this panel.</div>
      <Btn variant="primary" size="md" onClick={onAdd} icon={<I name="plus" size={15} />}>Add card or set</Btn>
    </div>
  );
}

Object.assign(window, { Telemetry, WatchSummary });
