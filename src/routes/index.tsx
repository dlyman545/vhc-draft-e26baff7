import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  component: DraftPage,
  ssr: false,
});

const COLORS = ["#3b82f6", "#ef4444", "#22c55e", "#f59e0b"];
const DRAFT_ID = 1;

type Team = { n: string; p: string[] };
type Pick = { name: string; team: number; at: number };
type DraftState = {
  tc: number;
  teams: Team[];
  pool: string[];
  picks: Pick[];
};

const DEFAULT_STATE: DraftState = {
  tc: 2,
  teams: [
    { n: "Team 1", p: [] },
    { n: "Team 2", p: [] },
    { n: "Team 3", p: [] },
    { n: "Team 4", p: [] },
  ],
  pool: [],
  picks: [],
};

function hexToRgb(hex: string) {
  const m = hex.slice(1).match(/.{2}/g)!;
  return m.map((x) => parseInt(x, 16)).join(",");
}

function DraftPage() {
  const [S, setS] = useState<DraftState>(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [popoverFor, setPopoverFor] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [input, setInput] = useState("");
  const localVersion = useRef(0);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Initial load + realtime subscription
  useEffect(() => {
    let active = true;
    supabase
      .from("draft_state")
      .select("state")
      .eq("id", DRAFT_ID)
      .maybeSingle()
      .then(({ data }) => {
        if (!active) return;
        if (data?.state && Object.keys(data.state as object).length) {
          setS({ ...DEFAULT_STATE, ...(data.state as DraftState) });
        }
        setLoaded(true);
      });

    const ch = supabase
      .channel("draft_state_live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "draft_state", filter: `id=eq.${DRAFT_ID}` },
        (payload) => {
          const next = (payload.new as { state?: DraftState })?.state;
          if (next && Object.keys(next).length) {
            setS({ ...DEFAULT_STATE, ...next });
          }
        }
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(ch);
    };
  }, []);

  // Persist to Supabase whenever local state changes (after initial load)
  useEffect(() => {
    if (!loaded) return;
    const v = ++localVersion.current;
    const t = setTimeout(() => {
      if (v !== localVersion.current) return;
      supabase
        .from("draft_state")
        .upsert({ id: DRAFT_ID, state: S as unknown as object, updated_at: new Date().toISOString() })
        .then(() => {});
    }, 120);
    return () => clearTimeout(t);
  }, [S, loaded]);

  // Close popover on outside click / esc
  useEffect(() => {
    if (!popoverFor) return;
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setPopoverFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopoverFor(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [popoverFor]);

  const totalPicks = S.picks.length;
  const round = Math.floor(totalPicks / S.tc) + 1;
  const pickInRound = (totalPicks % S.tc) + 1;
  const overall = totalPicks + 1;
  const onTheClockIdx = totalPicks % S.tc;
  const lastPick = S.picks[S.picks.length - 1];

  const addPlayers = () => {
    const names = input.split("\n").map((l) => l.trim()).filter(Boolean);
    setS((prev) => {
      const taken = new Set([...prev.pool, ...prev.teams.flatMap((t) => t.p)]);
      const next = [...prev.pool];
      for (const n of names) if (!taken.has(n)) { next.push(n); taken.add(n); }
      return { ...prev, pool: next };
    });
    setInput("");
  };

  const assign = (name: string, ti: number) => {
    setS((prev) => {
      const teams = prev.teams.map((t, i) =>
        i === ti ? { ...t, p: [...t.p, name] } : t
      );
      return {
        ...prev,
        pool: prev.pool.filter((p) => p !== name),
        teams,
        picks: [...prev.picks, { name, team: ti, at: Date.now() }],
      };
    });
    setPopoverFor(null);
  };

  const release = (name: string, ti: number) => {
    setS((prev) => ({
      ...prev,
      teams: prev.teams.map((t, i) =>
        i === ti ? { ...t, p: t.p.filter((p) => p !== name) } : t
      ),
      pool: [name, ...prev.pool],
      picks: prev.picks.filter((pk) => !(pk.name === name && pk.team === ti)),
    }));
  };

  const setTc = (n: number) => setS((prev) => ({ ...prev, tc: n }));

  const clearAll = () => {
    setS((prev) => {
      const allPlayers = prev.teams.flatMap((t) => t.p);
      return {
        ...prev,
        teams: prev.teams.map((t) => ({ ...t, p: [] })),
        pool: [...allPlayers, ...prev.pool],
        picks: [],
      };
    });
    setConfirmClear(false);
  };

  const renameTeam = (ti: number, n: string) =>
    setS((prev) => ({
      ...prev,
      teams: prev.teams.map((t, i) => (i === ti ? { ...t, n } : t)),
    }));

  const visibleTeams = useMemo(() => S.teams.slice(0, S.tc), [S.teams, S.tc]);

  return (
    <>
      <style>{css}</style>
      <div id="app">
        <header className="hdr">
          <Shield />
          <div className="hdr-center">
            <div className="hdr-eyebrow">Official Player Selection · Live</div>
            <div className="hdr-title">Vagrant Hockey Club Draft</div>
            <div className="hdr-sub">
              <span className="round-pill">
                Round <b>{round}</b>
              </span>
              <span className="round-pill">
                Pick <b>{pickInRound}</b>
              </span>
              <span className="round-pill overall">
                Overall <b>#{overall}</b>
              </span>
              <span className="live-dot" /> Live
            </div>
          </div>
          <Shield />
        </header>

        <div className="ticker">
          <div className="ticker-label">On the Clock</div>
          <div className="ticker-otc">
            <span
              className="otc-dot"
              style={{ background: COLORS[onTheClockIdx] }}
            />
            <span className="otc-name" style={{ color: COLORS[onTheClockIdx] }}>
              {visibleTeams[onTheClockIdx]?.n ?? "—"}
            </span>
          </div>
          <div className="ticker-label">Last Pick</div>
          <div className="ticker-last">
            {lastPick ? (
              <>
                <span style={{ color: COLORS[lastPick.team] }}>
                  {S.teams[lastPick.team]?.n}
                </span>
                <span className="ticker-arrow">→</span>
                <span className="ticker-player">{lastPick.name}</span>
              </>
            ) : (
              <span className="ticker-empty">Waiting for first selection…</span>
            )}
          </div>
        </div>

        <div className="toolbar">
          <div className="tc-wrap">
            <span className="tc-label">Teams</span>
            <div className="tc-btns">
              {[2, 3, 4].map((n) => (
                <button
                  key={n}
                  className={`tc-btn${S.tc === n ? " on" : ""}`}
                  onClick={() => setTc(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <button className="clr-btn" onClick={() => setConfirmClear(true)}>
            Clear All Picks
          </button>
        </div>

        <div className="body">
          <div className="pool-col">
            <div className="sec-hdr">
              <span className="sec-title">Draft Pool</span>
              <span className="badge">{S.pool.length}</span>
            </div>
            <div className="inp-area">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    addPlayers();
                  }
                }}
                placeholder="Type or paste names (one per line)…"
              />
              <button className="add-btn" onClick={addPlayers}>
                + Add to Pool
              </button>
            </div>
            <div className="pool-list">
              {S.pool.length === 0 ? (
                <div className="empty-pool">No players in pool</div>
              ) : (
                S.pool.map((n, i) => {
                  const open = popoverFor === n;
                  return (
                    <div key={n} className={`p-row${open ? " selected" : ""}`}>
                      <span className="p-num">{i + 1}</span>
                      <span className="p-name">{n}</span>
                      <div className="p-pick-wrap">
                        <button
                          className="pick-icon"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPopoverFor(open ? null : n);
                          }}
                          aria-label={`Draft ${n}`}
                        >
                          <svg viewBox="0 0 8 8">
                            <polygon points="2,1 7,4 2,7" />
                          </svg>
                        </button>
                        {open && (
                          <div className="pick-pop" ref={popRef}>
                            <div className="pop-arrow" />
                            <div className="pop-label">Draft to</div>
                            {visibleTeams.map((t, ti) => (
                              <button
                                key={ti}
                                className="pop-team"
                                onClick={() => assign(n, ti)}
                              >
                                <span
                                  className="pop-dot"
                                  style={{ background: COLORS[ti] }}
                                />
                                <span className="pop-name">{t.n}</span>
                                <span className="pop-ct">{t.p.length}p</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="teams-col">
            <div
              className="teams-grid"
              style={{
                gridTemplateColumns: S.tc === 3 ? "1fr 1fr 1fr" : "1fr 1fr",
              }}
            >
              {visibleTeams.map((t, ti) => {
                const c = COLORS[ti];
                const rgb = hexToRgb(c);
                const onClock = ti === onTheClockIdx;
                return (
                  <div
                    key={ti}
                    className={`tcard${onClock ? " on-clock" : ""}`}
                    style={{ borderTop: `3px solid ${c}` }}
                  >
                    <div
                      className="tcard-hdr"
                      style={{ background: `rgba(${rgb},.05)` }}
                    >
                      <div className="tcard-bar" style={{ background: c }} />
                      <input
                        className="tcard-name"
                        value={t.n}
                        style={{ color: c, caretColor: c }}
                        onChange={(e) => renameTeam(ti, e.target.value)}
                      />
                      {onClock && <span className="otc-pill">On the Clock</span>}
                      <span
                        className="tcard-pill"
                        style={{
                          color: c,
                          background: `rgba(${rgb},.1)`,
                          border: `1px solid rgba(${rgb},.25)`,
                        }}
                      >
                        {t.p.length} {t.p.length === 1 ? "player" : "players"}
                      </span>
                    </div>
                    <div className="tcard-body">
                      {t.p.length === 0 ? (
                        <div className="empty-team">On the clock…</div>
                      ) : (
                        t.p.map((p, idx) => (
                          <div
                            key={p}
                            className="tm-player"
                            onClick={() => release(p, ti)}
                          >
                            <span
                              className="tm-pick-no"
                              style={{ color: c }}
                            >
                              R{Math.floor((S.picks.findIndex(pk => pk.name === p && pk.team === ti)) / S.tc) + 1 || idx + 1}
                            </span>
                            <span className="tm-pname">{p}</span>
                            <span className="rel-hint">Release</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {confirmClear && (
        <div className="modal-overlay" onClick={() => setConfirmClear(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Clear All Picks?</h3>
            <p>All players return to the draft pool. Team names are kept. This affects every viewer.</p>
            <div className="modal-btns">
              <button className="mbtn mbtn-cancel" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
              <button className="mbtn mbtn-ok" onClick={clearAll}>
                Clear
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Shield() {
  return (
    <svg className="hdr-shield" viewBox="0 0 46 56">
      <path d="M23 2L3 11v17c0 13 9 22.5 20 25.5C34 50.5 43 41 43 28V11Z" fill="#0b1835" stroke="#c9a84c" strokeWidth="1.5" />
      <path d="M23 7.5L8 15v13c0 10 6.5 17.5 15 20 8.5-2.5 15-10 15-20V15Z" fill="#060d22" />
      <text x="23" y="33" textAnchor="middle" fontFamily="Barlow Condensed, sans-serif" fontSize="14" fontWeight="900" fill="#c9a84c">VHC</text>
    </svg>
  );
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,400;0,600;0,700;0,800;0,900;1,700&family=Barlow:wght@400;500;600&display=swap');
html, body { background:#04091a; color:#e2e8f4; font-family:'Barlow', sans-serif; min-height:100vh; }
* { box-sizing: border-box; }
#app { max-width:1300px; margin:0 auto; min-height:100vh; display:flex; flex-direction:column; }

.hdr { background: linear-gradient(180deg, #07112c 0%, #060d22 100%); border-bottom:2px solid #c9a84c; padding:18px 24px 14px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-shrink:0; position:relative; }
.hdr::after { content:""; position:absolute; left:0; right:0; bottom:-2px; height:2px; background:linear-gradient(90deg, transparent, #c9a84c, transparent); }
.hdr-center { text-align:center; flex:1; }
.hdr-eyebrow { font-family:'Barlow Condensed', sans-serif; font-size:11px; font-weight:700; letter-spacing:.35em; color:#c9a84c; text-transform:uppercase; margin-bottom:4px; }
.hdr-title { font-family:'Barlow Condensed', sans-serif; font-size:38px; font-weight:900; text-transform:uppercase; letter-spacing:.12em; color:#fff; line-height:1; text-shadow:0 2px 12px rgba(201,168,76,.3); }
.hdr-sub { display:flex; align-items:center; justify-content:center; gap:10px; margin-top:8px; font-family:'Barlow Condensed', sans-serif; font-size:11px; font-weight:700; letter-spacing:.18em; color:#5a6f99; text-transform:uppercase; }
.round-pill { padding:3px 10px; border:1px solid rgba(201,168,76,.3); border-radius:2px; color:#9aa8c4; }
.round-pill b { color:#c9a84c; margin-left:4px; }
.round-pill.overall b { color:#fff; }
.live-dot { width:7px; height:7px; border-radius:50%; background:#ef4444; box-shadow:0 0 8px #ef4444; animation:pulse 1.4s infinite; margin-left:6px; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
.hdr-shield { width:54px; height:64px; flex-shrink:0; filter:drop-shadow(0 2px 6px rgba(0,0,0,.5)); }

.ticker { display:flex; align-items:center; gap:14px; padding:10px 22px; background:linear-gradient(90deg, #04091a, #0a1530, #04091a); border-bottom:1px solid rgba(201,168,76,.2); flex-shrink:0; flex-wrap:wrap; }
.ticker-label { font-family:'Barlow Condensed', sans-serif; font-size:10px; font-weight:800; letter-spacing:.25em; color:#4a5f88; text-transform:uppercase; }
.ticker-otc { display:flex; align-items:center; gap:8px; padding:4px 12px; background:rgba(0,0,0,.3); border-radius:3px; }
.otc-dot { width:10px; height:10px; border-radius:50%; box-shadow:0 0 10px currentColor; }
.otc-name { font-family:'Barlow Condensed', sans-serif; font-size:16px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
.ticker-last { display:flex; align-items:center; gap:8px; font-family:'Barlow Condensed', sans-serif; font-size:13px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; flex:1; min-width:0; overflow:hidden; }
.ticker-arrow { color:#3a4f74; }
.ticker-player { color:#fff; }
.ticker-empty { color:#3a4f74; font-style:italic; text-transform:none; letter-spacing:0; }

.toolbar { display:flex; align-items:center; justify-content:space-between; padding:9px 20px; background:#060d22; border-bottom:1px solid rgba(201,168,76,.18); gap:12px; flex-wrap:wrap; flex-shrink:0; }
.tc-wrap { display:flex; align-items:center; gap:10px; }
.tc-label { font-family:'Barlow Condensed', sans-serif; font-size:12px; font-weight:700; letter-spacing:.2em; color:#5a6f99; text-transform:uppercase; }
.tc-btns { display:flex; border:1px solid rgba(201,168,76,.38); border-radius:3px; overflow:hidden; }
.tc-btn { background:transparent; border:none; color:#c9a84c; font-family:'Barlow Condensed', sans-serif; font-size:15px; font-weight:700; padding:5px 16px; cursor:pointer; transition:background .12s; }
.tc-btn:hover { background:rgba(201,168,76,.1); }
.tc-btn.on { background:#c9a84c; color:#04091a; }

.clr-btn { background:transparent; border:1px solid #7f1d1d; color:#f87171; font-family:'Barlow Condensed', sans-serif; font-size:12px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; padding:6px 16px; border-radius:3px; cursor:pointer; transition:all .12s; }
.clr-btn:hover { background:#7f1d1d; color:#fff; }

.body { display:grid; grid-template-columns: 300px 1fr; flex:1; }
.pool-col { background:#060d22; border-right:1px solid rgba(255,255,255,.06); display:flex; flex-direction:column; min-height:0; }
.sec-hdr { display:flex; align-items:center; justify-content:space-between; padding:8px 14px; border-bottom:1px solid rgba(255,255,255,.06); background:#07102a; flex-shrink:0; }
.sec-title { font-family:'Barlow Condensed', sans-serif; font-size:12px; font-weight:800; letter-spacing:.22em; color:#c9a84c; text-transform:uppercase; }
.badge { background:rgba(201,168,76,.1); color:#c9a84c; font-family:'Barlow Condensed', sans-serif; font-size:11px; font-weight:700; padding:1px 9px; border-radius:2px; border:1px solid rgba(201,168,76,.28); }
.inp-area { padding:10px; border-bottom:1px solid rgba(255,255,255,.05); flex-shrink:0; }
.inp-area textarea { width:100%; background:#030812; border:1px solid rgba(255,255,255,.09); border-radius:3px; color:#e2e8f4; font-family:'Barlow', sans-serif; font-size:13px; padding:7px 10px; resize:none; height:68px; outline:none; transition:border-color .15s; }
.inp-area textarea:focus { border-color:rgba(201,168,76,.45); }
.inp-area textarea::placeholder { color:#1a2640; }
.add-btn { margin-top:6px; width:100%; background:rgba(201,168,76,.08); border:1px solid rgba(201,168,76,.3); color:#c9a84c; font-family:'Barlow Condensed', sans-serif; font-size:12px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; padding:6px; border-radius:3px; cursor:pointer; transition:all .12s; }
.add-btn:hover { background:rgba(201,168,76,.16); }

.pool-list { overflow-y:auto; overflow-x:visible; flex:1; min-height:120px; }
.pool-list::-webkit-scrollbar { width:3px; }
.pool-list::-webkit-scrollbar-thumb { background:rgba(201,168,76,.2); border-radius:2px; }
.empty-pool { padding:20px; text-align:center; font-family:'Barlow Condensed', sans-serif; font-size:11px; color:#1a2640; letter-spacing:.15em; text-transform:uppercase; }

.p-row { display:flex; align-items:center; border-bottom:1px solid rgba(255,255,255,.04); transition:background .1s; position:relative; }
.p-row.selected { background:#0b1835; }
.p-num { font-family:'Barlow Condensed', sans-serif; font-size:11px; font-weight:600; color:#1e2d50; width:30px; text-align:right; padding:0 6px 0 10px; flex-shrink:0; }
.p-name { font-size:13px; font-weight:500; color:#b0bcd4; flex:1; padding:8px 4px 8px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.p-row.selected .p-name { color:#fff; }
.p-pick-wrap { padding:6px 10px 6px 4px; flex-shrink:0; position:relative; }
.pick-icon { width:24px; height:24px; border-radius:50%; background:rgba(201,168,76,.1); border:1px solid rgba(201,168,76,.3); display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all .12s; padding:0; }
.pick-icon:hover { background:rgba(201,168,76,.3); transform:scale(1.08); }
.pick-icon svg { width:8px; height:8px; fill:#c9a84c; }
.p-row.selected .pick-icon { background:#c9a84c; border-color:#c9a84c; }
.p-row.selected .pick-icon svg { fill:#04091a; }

.pick-pop { position:absolute; top:50%; right:calc(100% + 8px); transform:translateY(-50%); background:#0a1530; border:1px solid #c9a84c; border-radius:5px; padding:8px; min-width:200px; z-index:50; box-shadow:0 8px 28px rgba(0,0,0,.7), 0 0 0 4px rgba(201,168,76,.08); animation:popIn .12s ease-out; }
@keyframes popIn { from { opacity:0; transform:translateY(-50%) translateX(6px); } to { opacity:1; transform:translateY(-50%) translateX(0); } }
.pop-arrow { position:absolute; top:50%; right:-6px; transform:translateY(-50%) rotate(45deg); width:10px; height:10px; background:#0a1530; border-right:1px solid #c9a84c; border-top:1px solid #c9a84c; }
.pop-label { font-family:'Barlow Condensed', sans-serif; font-size:10px; font-weight:800; letter-spacing:.22em; color:#c9a84c; text-transform:uppercase; padding:2px 6px 6px; }
.pop-team { display:flex; align-items:center; gap:9px; width:100%; background:transparent; border:1px solid rgba(255,255,255,.08); border-radius:3px; padding:7px 10px; cursor:pointer; transition:all .12s; margin-bottom:4px; text-align:left; }
.pop-team:last-child { margin-bottom:0; }
.pop-team:hover { border-color:#c9a84c; background:#0f1e38; transform:translateX(-2px); }
.pop-dot { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
.pop-name { font-family:'Barlow Condensed', sans-serif; font-size:14px; font-weight:700; letter-spacing:.07em; color:#c8d4ec; text-transform:uppercase; flex:1; }
.pop-ct { font-family:'Barlow Condensed', sans-serif; font-size:11px; color:#3a4f74; }

.teams-col { padding:14px; overflow-y:auto; }
.teams-col::-webkit-scrollbar { width:4px; }
.teams-col::-webkit-scrollbar-thumb { background:rgba(255,255,255,.1); border-radius:2px; }
.teams-grid { display:grid; gap:12px; }

.tcard { background:#060d22; border:1px solid rgba(255,255,255,.07); border-radius:4px; overflow:hidden; transition:box-shadow .2s; }
.tcard.on-clock { box-shadow:0 0 0 1px rgba(201,168,76,.5), 0 0 24px rgba(201,168,76,.18); }
.tcard-hdr { display:flex; align-items:center; gap:10px; padding:9px 12px; border-bottom:1px solid rgba(255,255,255,.06); }
.tcard-bar { width:3px; height:28px; border-radius:2px; flex-shrink:0; }
.tcard-name { background:transparent; border:none; outline:none; font-family:'Barlow Condensed', sans-serif; font-size:16px; font-weight:800; text-transform:uppercase; letter-spacing:.1em; color:#fff; flex:1; min-width:0; cursor:pointer; }
.tcard-name:focus { cursor:text; }
.otc-pill { font-family:'Barlow Condensed', sans-serif; font-size:9px; font-weight:800; letter-spacing:.18em; text-transform:uppercase; padding:2px 7px; border-radius:2px; background:#c9a84c; color:#04091a; flex-shrink:0; animation:pulse 1.6s infinite; }
.tcard-pill { font-family:'Barlow Condensed', sans-serif; font-size:11px; font-weight:700; padding:2px 10px; border-radius:2px; white-space:nowrap; flex-shrink:0; }
.tcard-body { min-height:40px; }
.tm-player { display:flex; align-items:center; padding:7px 13px; border-bottom:1px solid rgba(255,255,255,.04); cursor:pointer; transition:background .1s; gap:10px; }
.tm-player:last-child { border-bottom:none; }
.tm-player:hover { background:rgba(239,68,68,.07); }
.tm-player:hover .rel-hint { opacity:1; }
.tm-pick-no { font-family:'Barlow Condensed', sans-serif; font-size:10px; font-weight:800; letter-spacing:.1em; opacity:.6; min-width:22px; }
.tm-pname { font-size:13px; color:#cdd7eb; flex:1; }
.rel-hint { font-family:'Barlow Condensed', sans-serif; font-size:10px; color:#ef4444; opacity:0; transition:opacity .12s; font-weight:700; letter-spacing:.06em; text-transform:uppercase; white-space:nowrap; }
.empty-team { padding:14px; text-align:center; font-family:'Barlow Condensed', sans-serif; font-size:11px; color:#1a2640; letter-spacing:.15em; text-transform:uppercase; }

.modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.75); z-index:500; display:flex; align-items:center; justify-content:center; }
.modal { background:#07102a; border:1px solid rgba(201,168,76,.42); border-radius:6px; padding:28px 24px; width:300px; text-align:center; }
.modal h3 { font-family:'Barlow Condensed', sans-serif; font-size:22px; font-weight:900; text-transform:uppercase; letter-spacing:.1em; color:#fff; margin:0 0 10px; }
.modal p { font-size:13px; color:#5a6f99; margin:0 0 22px; line-height:1.6; }
.modal-btns { display:flex; gap:10px; }
.mbtn { flex:1; font-family:'Barlow Condensed', sans-serif; font-size:14px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; padding:10px; border-radius:3px; cursor:pointer; border:1px solid; transition:all .12s; }
.mbtn-cancel { background:transparent; border-color:rgba(255,255,255,.12); color:#5a6f99; }
.mbtn-cancel:hover { background:rgba(255,255,255,.05); }
.mbtn-ok { background:#b91c1c; border-color:#b91c1c; color:#fff; }
.mbtn-ok:hover { background:#ef4444; border-color:#ef4444; }

@media (max-width: 760px) {
  .body { grid-template-columns: 1fr; }
  .hdr-title { font-size:24px; }
  .hdr { padding:12px 14px 10px; }
  .hdr-shield { width:40px; height:48px; }
  .pick-pop { right:auto; left:0; top:calc(100% + 8px); transform:none; }
  .pop-arrow { top:-6px; right:auto; left:14px; transform:rotate(225deg); }
}
`;
