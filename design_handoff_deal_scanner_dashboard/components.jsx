/* ============================================================
   SHARED UI PRIMITIVES  (exported to window)
   ============================================================ */
const { useState, useRef, useEffect } = React;

/* ---- Panel: framed surface with optional eyebrow header ---- */
function Panel({ title, right, children, className = "", glow = false, style }) {
  return (
    <section
      className={"cb-panel " + (glow ? "cb-panel-glow " : "") + className}
      style={style}
    >
      {(title || right) && (
        <header className="cb-panel-head">
          <span className="eyebrow">{title}</span>
          <span className="cb-panel-right">{right}</span>
        </header>
      )}
      <div className="cb-panel-body">{children}</div>
    </section>
  );
}

/* ---- Button ---- */
function Btn({ children, onClick, variant = "ghost", size = "md", disabled, icon, title, type }) {
  return (
    <button
      type={type || "button"}
      className={`cb-btn cb-btn-${variant} cb-btn-${size}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon && <span className="cb-btn-ico">{icon}</span>}
      {children && <span>{children}</span>}
    </button>
  );
}

/* ---- StatusDot + label ---- */
function Status({ kind = "live", label, pulse }) {
  return (
    <span className="cb-status">
      <span className={`dot dot-${kind} ${pulse ? "pulse" : ""}`}></span>
      {label && <span className="mono cb-status-lbl">{label}</span>}
    </span>
  );
}

/* ---- Tag / chip ---- */
function Tag({ children, tone = "neutral", title }) {
  return <span className={`cb-tag cb-tag-${tone}`} title={title}>{children}</span>;
}

/* ---- Segmented control ---- */
function Segmented({ value, options, onChange, size = "md" }) {
  return (
    <div className={`cb-seg cb-seg-${size}`} role="tablist">
      {options.map((o) => {
        const val = typeof o === "string" ? o : o.value;
        const lbl = typeof o === "string" ? o : o.label;
        return (
          <button
            key={val}
            className={"cb-seg-opt " + (value === val ? "is-on" : "")}
            onClick={() => onChange(val)}
            role="tab"
            aria-selected={value === val}
          >
            {lbl}
          </button>
        );
      })}
    </div>
  );
}

/* ---- Toggle switch ---- */
function Switch({ on, onChange, label }) {
  return (
    <button className={"cb-switch " + (on ? "is-on" : "")} onClick={() => onChange(!on)} aria-pressed={on} title={label}>
      <span className="cb-switch-knob"></span>
    </button>
  );
}

/* ---- Field with inherit/override indicator ----
   value: current; defaultValue: config default; inherited: bool
   renders the control via `render(curr, set)`; shows a reset chip when overridden */
function InheritField({ label, inherited, defaultLabel, onReset, children }) {
  return (
    <div className="cb-ifield">
      <div className="cb-ifield-top">
        <span className="cb-ifield-lbl">{label}</span>
        {inherited ? (
          <span className="cb-inherit" title="Following the global default">
            <span className="dot dot-idle"></span>inherit · {defaultLabel}
          </span>
        ) : (
          <button className="cb-reset" onClick={onReset} title="Reset to global default">
            override ✕
          </button>
        )}
      </div>
      <div className={"cb-ifield-ctl " + (inherited ? "is-inherited" : "")}>{children}</div>
    </div>
  );
}

/* ---- mini sparkline bar (price vs baseline) ---- */
function PriceBar({ price, baseline }) {
  const pct = Math.max(4, Math.min(100, (price / baseline) * 100));
  return (
    <div className="cb-pbar" title={`price is ${Math.round((price/baseline)*100)}% of baseline`}>
      <div className="cb-pbar-fill" style={{ width: pct + "%" }}></div>
      <div className="cb-pbar-base"></div>
    </div>
  );
}

/* ---- country flag glyph (text) ---- */
function flag(cc) {
  if (!cc || cc.length !== 2) return "";
  const A = 0x1f1e6;
  return String.fromCodePoint(A + cc.charCodeAt(0) - 65, A + cc.charCodeAt(1) - 65);
}

/* ---- relative time ---- */
function ago(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

/* ---- icons (inline svg, stroke currentColor) ---- */
const Icon = {
  feed: (p) => (<svg viewBox="0 0 24 24" {...p}><path d="M4 6h16M4 12h16M4 18h10" /></svg>),
  radar: (p) => (<svg viewBox="0 0 24 24" {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><path d="M12 12l6-4" /></svg>),
  watch: (p) => (<svg viewBox="0 0 24 24" {...p}><path d="M4 5h16v6c0 5-4 7-8 8-4-1-8-3-8-8V5z" /><path d="M9 11l2 2 4-4" /></svg>),
  gear: (p) => (<svg viewBox="0 0 24 24" {...p}><circle cx="12" cy="12" r="3.2" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></svg>),
  pulse: (p) => (<svg viewBox="0 0 24 24" {...p}><path d="M3 12h4l2-6 4 12 2-6h6" /></svg>),
  bolt: (p) => (<svg viewBox="0 0 24 24" {...p}><path d="M13 3L5 13h6l-1 8 8-12h-6z" /></svg>),
  ext: (p) => (<svg viewBox="0 0 24 24" {...p}><path d="M14 5h5v5M19 5l-8 8M11 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" /></svg>),
  x: (p) => (<svg viewBox="0 0 24 24" {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>),
  eye: (p) => (<svg viewBox="0 0 24 24" {...p}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="2.6" /></svg>),
  plus: (p) => (<svg viewBox="0 0 24 24" {...p}><path d="M12 5v14M5 12h14" /></svg>),
  search: (p) => (<svg viewBox="0 0 24 24" {...p}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></svg>),
  send: (p) => (<svg viewBox="0 0 24 24" {...p}><path d="M21 3L3 11l7 2 2 7 9-17z" /><path d="M10 13l5-5" /></svg>),
  check: (p) => (<svg viewBox="0 0 24 24" {...p}><path d="M4 12l5 5L20 6" /></svg>),
  alert: (p) => (<svg viewBox="0 0 24 24" {...p}><path d="M12 4l9 16H3L12 4z" /><path d="M12 10v4M12 17v.5" /></svg>),
  card: (p) => (<svg viewBox="0 0 24 24" {...p}><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M8 7h6M8 11h8" /></svg>),
  layers: (p) => (<svg viewBox="0 0 24 24" {...p}><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></svg>),
};
function I({ name, size = 18, className = "" }) {
  const C = Icon[name];
  return C ? <C width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={"cb-ico " + className} /> : null;
}

/* ---- self-ticking countdown clock (isolated so the App doesn't
   re-render every second, which would disrupt entrance animations) ---- */
function Clock({ target, className }) {
  const [, force] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  let rem = Math.floor((target - Date.now()) / 1000);
  while (rem < 0) rem += 3600; // loop hourly for the demo
  const mm = String(Math.floor(rem / 60)).padStart(2, "0");
  const ss = String(rem % 60).padStart(2, "0");
  const urgent = rem < 60;
  return <span className={(className || "") + (urgent ? " clk-urgent" : "")}>{`T−${mm}:${ss}`}</span>;
}

Object.assign(window, {
  Panel, Btn, Status, Tag, Segmented, Switch, InheritField, PriceBar, I, Icon,
  flag, ago, Clock,
});
