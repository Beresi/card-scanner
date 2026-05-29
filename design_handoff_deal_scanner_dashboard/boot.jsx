/* ============================================================
   BOOT SEQUENCE  — signature first-load moment
   Terminal init lines → logo flicker → fade to app.
   localStorage gated; skippable.
   ============================================================ */
function BootSequence({ onDone }) {
  const LINES = [
    { t: "CARD//BROKER  v1.0.0  ·  deal-scanner kernel", cls: "boot-head" },
    { t: "> establishing uplink · cloudflare edge ............. OK", d: 360 },
    { t: "> cardtrader api · GET /info ....................... 200", d: 300 },
    { t: "> auth token · bearer scope [read·write] ........... VALID", d: 300 },
    { t: "> mounting D1 · cardtrader_scanner ................. OK", d: 260 },
    { t: "> loading watchlist ............................ 8 ITEMS", d: 300 },
    { t: "> expansion cache ........................... 412 SETS", d: 220 },
    { t: "> blueprint cache ....................... 38,114 CARDS", d: 240 },
    { t: "> telegram bot · @cardbroker_bot · getMe ......... LINKED", d: 320 },
    { t: "> cron · 0 * * * * · next scan T-53:12 ............. ARMED", d: 300 },
    { t: "> scanner online.", cls: "boot-ok", d: 420 },
  ];

  const [shown, setShown] = useState(0);
  const [phase, setPhase] = useState("lines"); // lines -> logo -> out
  const skipRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      for (let i = 0; i < LINES.length; i++) {
        if (cancelled || skipRef.current) break;
        await new Promise((r) => setTimeout(r, LINES[i].d || 220));
        if (cancelled || skipRef.current) break;
        setShown(i + 1);
      }
      if (cancelled || skipRef.current) return;
      await new Promise((r) => setTimeout(r, 320));
      if (cancelled) return;
      setPhase("logo");
      await new Promise((r) => setTimeout(r, 1150));
      if (cancelled) return;
      finish();
    }
    run();
    return () => { cancelled = true; };
  }, []);

  function finish() {
    setPhase("out");
    setTimeout(onDone, 620);
  }
  function skip() {
    skipRef.current = true;
    setShown(LINES.length);
    setPhase("logo");
    setTimeout(finish, 700);
  }

  return (
    <div className={"boot boot-" + phase} onClick={skip}>
      <div className="boot-scan"></div>
      <div className="boot-inner">
        {phase === "lines" && (
          <div className="boot-term">
            {LINES.slice(0, shown).map((l, i) => (
              <div key={i} className={"boot-line " + (l.cls || "")}>
                {l.t}
              </div>
            ))}
            {shown < LINES.length && <span className="boot-cursor">▊</span>}
          </div>
        )}

        {(phase === "logo" || phase === "out") && (
          <div className="boot-logo">
            <div className="boot-logo-mark">
              <span className="boot-logo-glyph">◈</span>
            </div>
            <div className="boot-logo-text" data-text="CARD//BROKER">
              <span className="boot-logo-1">CARD</span><span className="boot-logo-slash">//</span><span className="boot-logo-2">BROKER</span>
            </div>
            <div className="boot-logo-sub eyebrow">underpriced-copy hunter · online</div>
          </div>
        )}
      </div>
      {phase === "lines" && <div className="boot-skip eyebrow">click anywhere to skip</div>}
    </div>
  );
}
window.BootSequence = BootSequence;
