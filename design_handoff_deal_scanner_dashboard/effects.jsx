/* ============================================================
   EFFECTS — ScrambleText (decrypt reveal) + Command Palette
   ============================================================ */

/* ---- decrypt / scramble text reveal ---- */
function ScrambleText({ text, active, delay = 0, className }) {
  const [display, setDisplay] = useState(active ? "" : text);
  useEffect(() => {
    if (!active) { setDisplay(text); return; }
    const glyphs = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&/<>*+=";
    const total = 16;
    let frame = 0, iv = null, to = null;
    to = setTimeout(() => {
      iv = setInterval(() => {
        frame++;
        const revealed = Math.floor((frame / total) * text.length);
        let out = "";
        for (let i = 0; i < text.length; i++) {
          if (i < revealed || text[i] === " ") out += text[i];
          else out += glyphs[(Math.random() * glyphs.length) | 0];
        }
        setDisplay(out);
        if (frame >= total) { clearInterval(iv); setDisplay(text); }
      }, 32);
    }, delay);
    return () => { clearTimeout(to); if (iv) clearInterval(iv); setDisplay(text); };
  }, [active, text]);
  return <span className={className}>{display}</span>;
}

/* ---- command palette (⌘K) ---- */
function CommandPalette({ commands, onClose }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);

  const filtered = commands.filter((c) => {
    if (!q) return true;
    const hay = (c.label + " " + (c.group || "") + " " + (c.hint || "")).toLowerCase();
    return q.toLowerCase().split(/\s+/).every((tok) => hay.includes(tok));
  });

  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
  useEffect(() => {
    function key(e) {
      if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, filtered.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); const c = filtered[idx]; if (c) { c.run(); onClose(); } }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [filtered, idx, onClose]);

  // group while preserving order
  const groups = [];
  filtered.forEach((c, i) => {
    const g = c.group || "Actions";
    let bucket = groups.find((x) => x.g === g);
    if (!bucket) { bucket = { g, items: [] }; groups.push(bucket); }
    bucket.items.push({ c, i });
  });

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk chamfer bracket" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input-wrap">
          <I name="search" size={16} className="dim" />
          <input ref={inputRef} className="cmdk-input" placeholder="type a command, view, or card…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="cmdk-esc mono">ESC</span>
        </div>
        <div className="cmdk-list">
          {filtered.length === 0 && <div className="cmdk-none mono faint">no matching command</div>}
          {groups.map((grp) => (
            <div key={grp.g} className="cmdk-group">
              <div className="cmdk-group-label eyebrow">{grp.g}</div>
              {grp.items.map(({ c, i }) => (
                <button key={i} className={"cmdk-item " + (i === idx ? "is-active" : "")}
                  onMouseEnter={() => setIdx(i)} onClick={() => { c.run(); onClose(); }}>
                  <I name={c.icon || "bolt"} size={15} className={i === idx ? "accent-text" : "dim"} />
                  <span className="cmdk-item-label">{c.label}</span>
                  {c.hint && <span className="cmdk-item-hint mono faint">{c.hint}</span>}
                  {i === idx && <span className="cmdk-enter mono">↵</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="cmdk-foot mono faint">
          <span>↑↓ navigate</span><span>↵ run</span><span>esc close</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ScrambleText, CommandPalette });
