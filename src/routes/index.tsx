import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  component: DraftPage,
  ssr: false,
});

const COLORS = ["#3b82f6", "#ef4444", "#22c55e", "#f59e0b"];
const COLOR_NAMES = ["Blue", "Red", "Green", "Gold"];
const DRAFT_ID = 1;

type Team = { n: string; p: string[] };
type Pick = { name: string; team: number; at: number };
type DraftState = {
  tc: number;
  teams: Team[];
  pool: string[];
  picks: Pick[];
  firstPick?: number;
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
  firstPick: 0,
};

function hexToRgb(hex: string) {
  const m = hex.slice(1).match(/.{2}/g)!;
  return m.map((x) => parseInt(x, 16)).join(",");
}

function DraftPage() {
  const [S, setS] = useState<DraftState>(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmClearPool, setConfirmClearPool] = useState(false);
  const [confirmShrink, setConfirmShrink] = useState<{ newTc: number; affected: { ti: number; players: string[] }[] } | null>(null);
  const [input, setInput] = useState("");
  const [coinFlip, setCoinFlip] = useState<{ spinning: boolean; winner: number | null }>({ spinning: false, winner: null });
  const localVersion = useRef(0);
  const lastSentJSON = useRef<string>("");

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
            const merged = { ...DEFAULT_STATE, ...next };
            // Ignore echoes of our own writes — they cause re-renders that swallow clicks.
            if (JSON.stringify(merged) === lastSentJSON.current) return;
            setS(merged);
          }
        }
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(ch);
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const v = ++localVersion.current;
    const t = setTimeout(() => {
      if (v !== localVersion.current) return;
      lastSentJSON.current = JSON.stringify(S);
      supabase
        .from("draft_state")
        .upsert({
          id: DRAFT_ID,
          state: S as unknown as never,
          updated_at: new Date().toISOString(),
        })
        .then(() => {});
    }, 120);
    return () => clearTimeout(t);
  }, [S, loaded]);

  const totalPicks = S.picks.length;
  const round = Math.floor(totalPicks / S.tc) + 1;
  const pickInRound = (totalPicks % S.tc) + 1;
  const overall = totalPicks + 1;
  const firstPick = S.firstPick ?? 0;
  const onTheClockIdx = (totalPicks + firstPick) % S.tc;
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
    setS((prev) => ({
      ...prev,
      pool: prev.pool.filter((p) => p !== name),
      teams: prev.teams.map((t, i) => (i === ti ? { ...t, p: [...t.p, name] } : t)),
      picks: [...prev.picks, { name, team: ti, at: Date.now() }],
    }));
  };

  const draftToClock = (name: string) => {
    if (!visibleTeams[onTheClockIdx]) return;
    assign(name, onTheClockIdx);
  };

  const runCoinFlip = () => {
    if (S.picks.length > 0) return;
    setCoinFlip({ spinning: true, winner: null });
    const winner = Math.floor(Math.random() * S.tc);
    setTimeout(() => {
      setCoinFlip({ spinning: false, winner });
      setS((prev) => ({ ...prev, firstPick: winner }));
    }, 1800);
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

  const clearAll = () => {
    setS((prev) => {
      const allPlayers = prev.teams.flatMap((t) => t.p);
      const seen = new Set<string>();
      const pool = [...allPlayers, ...prev.pool].filter((n) => {
        if (seen.has(n)) return false;
        seen.add(n);
        return true;
      });
      return {
        ...prev,
        teams: prev.teams.map((t) => ({ ...t, p: [] })),
        pool,
        picks: [],
      };
    });
    setConfirmClear(false);
  };

  const clearPool = () => {
    setS((prev) => ({ ...prev, pool: [] }));
    setConfirmClearPool(false);
  };

  const renameTeam = (ti: number, n: string) =>
    setS((prev) => ({
      ...prev,
      teams: prev.teams.map((t, i) => (i === ti ? { ...t, n } : t)),
    }));

  const setTc = (n: number) => {
    const affected = S.teams
      .slice(n)
      .map((t, i) => ({ ti: n + i, players: t.p }))
      .filter((x) => x.players.length > 0);
    if (n < S.tc && affected.length > 0) {
      setConfirmShrink({ newTc: n, affected });
      return;
    }
    setS((prev) => ({ ...prev, tc: n }));
  };

  const shrinkReleaseOnly = () => {
    if (!confirmShrink) return;
    const { newTc, affected } = confirmShrink;
    const releasedNames = affected.flatMap((a) => a.players);
    const releasedSet = new Set(releasedNames);
    setS((prev) => {
      const seen = new Set<string>();
      const pool = [...releasedNames, ...prev.pool].filter((n) => {
        if (seen.has(n)) return false;
        seen.add(n);
        return true;
      });
      return {
        ...prev,
        tc: newTc,
        teams: prev.teams.map((t, i) => (i >= newTc ? { ...t, p: [] } : t)),
        pool,
        picks: prev.picks.filter((pk) => !(pk.team >= newTc && releasedSet.has(pk.name))),
      };
    });
    setConfirmShrink(null);
  };

  const shrinkResetAll = () => {
    if (!confirmShrink) return;
    const { newTc } = confirmShrink;
    setS((prev) => {
      const allPlayers = prev.teams.flatMap((t) => t.p);
      const seen = new Set<string>();
      const pool = [...allPlayers, ...prev.pool].filter((n) => {
        if (seen.has(n)) return false;
        seen.add(n);
        return true;
      });
      return {
        ...prev,
        tc: newTc,
        teams: prev.teams.map((t) => ({ ...t, p: [] })),
        pool,
        picks: [],
      };
    });
    setConfirmShrink(null);
  };

  const visibleTeams = useMemo(() => S.teams.slice(0, S.tc), [S.teams, S.tc]);

  const pickIndexFor = (name: string, ti: number) =>
    S.picks.findIndex((pk) => pk.name === name && pk.team === ti);

  return (
    <>
      <style>{css}</style>
      <div className="page">
        <div className="shell">
          <header className="hdr">
            <Crest />
            <div className="hdr-center">
              <div className="hdr-eyebrow">
                <span className="live">
                  <span className="live-dot" /> Live
                </span>
                <span className="dot-sep">·</span>
                Official Player Selection
              </div>
              <h1 className="hdr-title">Vagrant Hockey Club Draft</h1>
              <div className="hdr-meta">
                <Stat label="Round" value={round} />
                <Stat label="Pick" value={pickInRound} />
                <Stat label="Overall" value={`#${overall}`} highlight />
                <Stat label="Players Drafted" value={totalPicks} />
              </div>
            </div>
            <Crest />
          </header>

          <div className="broadcast">
            <div className="bc-block">
              <div className="bc-label">On the Clock</div>
              <div className="bc-team">
                <span
                  className="bc-dot"
                  style={{
                    background: COLORS[onTheClockIdx],
                    boxShadow: `0 0 14px ${COLORS[onTheClockIdx]}`,
                  }}
                />
                <span style={{ color: COLORS[onTheClockIdx] }}>
                  {visibleTeams[onTheClockIdx]?.n ?? "—"}
                </span>
              </div>
            </div>
            <div className="bc-divider" />
            <div className="bc-block flex-1 min-w-0">
              <div className="bc-label">Last Selection</div>
              <div className="bc-last">
                {lastPick ? (
                  <>
                    <span
                      className="bc-team-tag"
                      style={{
                        color: COLORS[lastPick.team],
                        borderColor: `rgba(${hexToRgb(COLORS[lastPick.team])},.4)`,
                      }}
                    >
                      {S.teams[lastPick.team]?.n}
                    </span>
                    <span className="bc-player">{lastPick.name}</span>
                  </>
                ) : (
                  <span className="bc-empty">Awaiting first selection</span>
                )}
              </div>
            </div>
            <div className="bc-divider hide-sm" />
            <div className="bc-block hide-sm">
              <div className="bc-label">Teams</div>
              <div className="seg">
                {[2, 3, 4].map((n) => (
                  <button
                    key={n}
                    className={`seg-btn${S.tc === n ? " on" : ""}`}
                    onClick={() => setTc(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="reset-btn"
              onClick={runCoinFlip}
              disabled={S.picks.length > 0}
              title={S.picks.length > 0 ? "Reset draft to flip again" : "Coin flip for first pick"}
              style={{ marginRight: 8 }}
            >
              🪙 Coin Flip
            </button>
            <button className="reset-btn" onClick={() => setConfirmClear(true)}>
              Reset Draft
            </button>
          </div>

          <div className="body">
            <aside className="pool-col">
              <div className="sec-hdr">
                <div>
                  <div className="sec-eyebrow">Available</div>
                  <div className="sec-title">Draft Pool</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="badge">{S.pool.length}</span>
                  <button
                    className="clear-pool-btn"
                    onClick={() => setConfirmClearPool(true)}
                    disabled={S.pool.length === 0}
                    title="Clear draft pool"
                  >
                    Clear
                  </button>
                </div>
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
                  placeholder="Add prospects — one name per line…"
                />
                <button className="add-btn" onClick={addPlayers} disabled={!input.trim()}>
                  Add to Pool
                </button>
              </div>

              <div className="pool-list">
                {S.pool.length === 0 ? (
                  <div className="empty-pool">
                    <div className="empty-ico">⛸</div>
                    No prospects on the board
                  </div>
                ) : (
                  S.pool.map((n, i) => {
                    return (
                      <div key={n} className="p-row">
                        <span className="p-num">{String(i + 1).padStart(2, "0")}</span>
                        <span className="p-name">{n}</span>
                        <button
                          className="pick-btn"
                          style={{
                            ["--tc" as string]: COLORS[onTheClockIdx],
                            ["--tc-rgb" as string]: hexToRgb(COLORS[onTheClockIdx]),
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            draftToClock(n);
                          }}
                          title={`Draft to ${visibleTeams[onTheClockIdx]?.n ?? ""}`}
                        >
                          Draft → {visibleTeams[onTheClockIdx]?.n ?? ""}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </aside>

            <main className="teams-col">
              <div
                className="teams-grid"
                style={{
                  gridTemplateColumns:
                    S.tc === 2
                      ? "repeat(2, minmax(0, 1fr))"
                      : S.tc === 3
                      ? "repeat(3, minmax(0, 1fr))"
                      : "repeat(2, minmax(0, 1fr))",
                }}
              >
                {visibleTeams.map((t, ti) => {
                  const c = COLORS[ti];
                  const rgb = hexToRgb(c);
                  const onClock = ti === onTheClockIdx;
                  return (
                    <section
                      key={ti}
                      className={`tcard${onClock ? " on-clock" : ""}`}
                      style={{
                        ["--tc" as string]: c,
                        ["--tc-rgb" as string]: rgb,
                      }}
                    >
                      <div className="tcard-stripe" />
                      <header className="tcard-hdr">
                        <div className="tcard-id">
                          <div className="tcard-num">{String(ti + 1).padStart(2, "0")}</div>
                          <div className="tcard-color">{t.n}</div>
                        </div>
                        <div className="tcard-name-wrap">
                          <input
                            className="tcard-name"
                            value={t.n}
                            onChange={(e) => renameTeam(ti, e.target.value)}
                          />
                          <div className="tcard-stats">
                            <span>{t.p.length} {t.p.length === 1 ? "player" : "players"}</span>
                            {onClock && <span className="otc-pill">● On the Clock</span>}
                          </div>
                        </div>
                      </header>
                      <div className="tcard-body">
                        {t.p.length === 0 ? (
                          <div className="empty-team">
                            {onClock ? "Make the next pick" : "No selections yet"}
                          </div>
                        ) : (
                          t.p.map((p) => {
                            const idx = pickIndexFor(p, ti);
                            const r = idx >= 0 ? Math.floor(idx / S.tc) + 1 : 1;
                            return (
                              <div key={p} className="tm-player" onClick={() => release(p, ti)}>
                                <span className="tm-round">R{r}</span>
                                <span className="tm-pname">{p}</span>
                                <span className="rel-hint">Release</span>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            </main>
          </div>
        </div>
      </div>

      {(coinFlip.spinning || coinFlip.winner !== null) && (
        <div className="modal-overlay" onClick={() => !coinFlip.spinning && setCoinFlip({ spinning: false, winner: null })}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ textAlign: "center" }}>
            <h3>{coinFlip.spinning ? "Flipping…" : "First Pick"}</h3>
            <div style={{
              fontSize: 72,
              margin: "16px 0",
              display: "inline-block",
              animation: coinFlip.spinning ? "coinflip 0.5s linear infinite" : "none",
            }}>🪙</div>
            {coinFlip.winner !== null && !coinFlip.spinning && (
              <p style={{ fontSize: 20 }}>
                <strong style={{ color: COLORS[coinFlip.winner] }}>
                  {visibleTeams[coinFlip.winner]?.n}
                </strong>{" "}
                picks first!
              </p>
            )}
            {!coinFlip.spinning && (
              <div className="modal-btns">
                <button className="mbtn mbtn-ok" onClick={() => setCoinFlip({ spinning: false, winner: null })}>
                  Let's Draft
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {confirmClear && (
        <div className="modal-overlay" onClick={() => setConfirmClear(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Reset the Draft?</h3>
            <p>All players return to the pool. Team names are kept. This affects every viewer in real time.</p>
            <div className="modal-btns">
              <button className="mbtn mbtn-cancel" onClick={() => setConfirmClear(false)}>Cancel</button>
              <button className="mbtn mbtn-ok" onClick={clearAll}>Reset</button>
            </div>
          </div>
        </div>
      )}

      {confirmClearPool && (
        <div className="modal-overlay" onClick={() => setConfirmClearPool(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Clear the Draft Pool?</h3>
            <p>
              This removes all {S.pool.length} undrafted prospect(s) from the pool.
              Players already on teams are not affected. This affects every viewer in real time.
            </p>
            <div className="modal-btns">
              <button className="mbtn mbtn-cancel" onClick={() => setConfirmClearPool(false)}>Cancel</button>
              <button className="mbtn mbtn-ok" onClick={clearPool}>Clear Pool</button>
            </div>
          </div>
        </div>
      )}

      {confirmShrink && (
        <div className="modal-overlay" onClick={() => setConfirmShrink(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Reduce to {confirmShrink.newTc} teams?</h3>
            <p>
              {confirmShrink.affected.reduce((s, a) => s + a.players.length, 0)} player(s) are
              assigned to team(s) being removed. What would you like to do?
            </p>
            <div className="modal-btns" style={{ flexWrap: "wrap" }}>
              <button className="mbtn mbtn-cancel" onClick={() => setConfirmShrink(null)}>Cancel</button>
              <button className="mbtn mbtn-ok" onClick={shrinkReleaseOnly}>Release those players</button>
              <button className="mbtn mbtn-ok" onClick={shrinkResetAll}>Reset full draft</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className={`stat${highlight ? " stat-hl" : ""}`}>
      <div className="stat-val">{value}</div>
      <div className="stat-lbl">{label}</div>
    </div>
  );
}

function Crest() {
  return (
    <svg className="crest" viewBox="0 0 60 72" aria-hidden>
      <defs>
        <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a2950" />
          <stop offset="1" stopColor="#060d22" />
        </linearGradient>
      </defs>
      <path d="M30 3L5 14v22c0 17 12 28 25 32 13-4 25-15 25-32V14Z" fill="url(#cg)" stroke="#c9a84c" strokeWidth="1.5" />
      <path d="M30 9L11 18v18c0 13 9 22 19 26 10-4 19-13 19-26V18Z" fill="none" stroke="rgba(201,168,76,.35)" strokeWidth=".8" />
      <text x="30" y="42" textAnchor="middle" fontFamily="Barlow Condensed, sans-serif" fontSize="18" fontWeight="900" fill="#c9a84c" letterSpacing="1">VHC</text>
    </svg>
  );
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Inter:wght@400;500;600;700&display=swap');

@keyframes coinflip { 0% { transform: rotateY(0deg) } 100% { transform: rotateY(360deg) } }

*, *::before, *::after { box-sizing: border-box; }
html, body, #root { background:#03060f; color:#e2e8f4; font-family:'Inter', system-ui, sans-serif; min-height:100vh; margin:0; }
.flex-1 { flex:1; }
.min-w-0 { min-width:0; }
.hide-sm { }
@media (max-width: 820px) { .hide-sm { display:none !important; } }

.page {
  min-height:100vh;
  background:
    radial-gradient(1100px 600px at 50% -120px, rgba(201,168,76,.10), transparent 60%),
    radial-gradient(900px 500px at 100% 100%, rgba(59,130,246,.06), transparent 70%),
    linear-gradient(180deg, #03060f 0%, #050a1c 100%);
  padding:18px;
}
.shell {
  max-width:1400px; margin:0 auto;
  background:linear-gradient(180deg, rgba(10,18,40,.8), rgba(6,12,30,.8));
  border:1px solid rgba(201,168,76,.18);
  border-radius:10px;
  overflow:hidden;
  box-shadow:0 30px 80px -30px rgba(0,0,0,.8), 0 0 0 1px rgba(255,255,255,.02) inset;
}

/* ─── HEADER ─── */
.hdr {
  position:relative;
  padding:22px 28px 20px;
  display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:24px;
  border-bottom:1px solid rgba(201,168,76,.25);
  background:
    radial-gradient(800px 220px at 50% -40px, rgba(201,168,76,.18), transparent 65%),
    linear-gradient(180deg, #0a1430 0%, #060d22 100%);
}
.hdr::after {
  content:""; position:absolute; left:0; right:0; bottom:-1px; height:2px;
  background:linear-gradient(90deg, transparent, #c9a84c 30%, #c9a84c 70%, transparent);
  opacity:.7;
}
.crest { width:56px; height:68px; flex-shrink:0; filter:drop-shadow(0 4px 10px rgba(0,0,0,.5)); }
.hdr-center { text-align:center; }
.hdr-eyebrow {
  display:inline-flex; align-items:center; gap:8px;
  font-family:'Barlow Condensed', sans-serif;
  font-size:11px; font-weight:700; letter-spacing:.32em;
  color:#8aa0c9; text-transform:uppercase; margin-bottom:6px;
}
.dot-sep { color:rgba(201,168,76,.5); }
.live { display:inline-flex; align-items:center; gap:6px; color:#ef4444; font-weight:800; }
.live-dot { width:7px; height:7px; border-radius:50%; background:#ef4444; box-shadow:0 0 10px #ef4444; animation:pulse 1.4s infinite; }
@keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.9)} }

.hdr-title {
  margin:0;
  font-family:'Barlow Condensed', sans-serif;
  font-size:42px; font-weight:900; line-height:1;
  text-transform:uppercase; letter-spacing:.1em;
  color:#fff;
  text-shadow:0 2px 18px rgba(201,168,76,.25);
}
.hdr-meta { display:flex; justify-content:center; gap:8px; margin-top:14px; flex-wrap:wrap; }
.stat {
  display:flex; flex-direction:column; align-items:center;
  background:rgba(0,0,0,.35);
  border:1px solid rgba(201,168,76,.18);
  border-radius:5px;
  padding:6px 14px;
  min-width:74px;
}
.stat-val {
  font-family:'Barlow Condensed', sans-serif;
  font-weight:900; font-size:20px; line-height:1; color:#fff; letter-spacing:.04em;
}
.stat-lbl {
  font-family:'Barlow Condensed', sans-serif;
  font-size:9px; font-weight:700; letter-spacing:.22em; text-transform:uppercase;
  color:#5a6f99; margin-top:4px;
}
.stat-hl { border-color:rgba(201,168,76,.5); background:linear-gradient(180deg, rgba(201,168,76,.18), rgba(201,168,76,.04)); }
.stat-hl .stat-val { color:#c9a84c; }

/* ─── BROADCAST BAR ─── */
.broadcast {
  display:flex; align-items:center; gap:18px;
  padding:14px 22px;
  background:linear-gradient(90deg, #050b1a 0%, #0a1530 50%, #050b1a 100%);
  border-bottom:1px solid rgba(255,255,255,.06);
  flex-wrap:wrap;
}
.bc-block { display:flex; flex-direction:column; gap:4px; }
.bc-label {
  font-family:'Barlow Condensed', sans-serif;
  font-size:10px; font-weight:800; letter-spacing:.28em;
  color:#4a5f88; text-transform:uppercase;
}
.bc-team {
  display:flex; align-items:center; gap:9px;
  font-family:'Barlow Condensed', sans-serif;
  font-size:18px; font-weight:900; letter-spacing:.08em; text-transform:uppercase;
}
.bc-dot { width:11px; height:11px; border-radius:50%; }
.bc-divider { width:1px; height:36px; background:rgba(201,168,76,.18); }
.bc-last {
  display:flex; align-items:center; gap:10px;
  min-width:0; overflow:hidden;
}
.bc-team-tag {
  font-family:'Barlow Condensed', sans-serif;
  font-size:11px; font-weight:800; letter-spacing:.18em; text-transform:uppercase;
  border:1px solid; border-radius:3px; padding:3px 8px;
  flex-shrink:0;
}
.bc-player {
  font-family:'Barlow Condensed', sans-serif;
  font-size:18px; font-weight:700; letter-spacing:.04em;
  color:#fff; text-transform:uppercase;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.bc-empty { font-size:13px; color:#3a4f74; font-style:italic; }

.seg {
  display:inline-flex; border:1px solid rgba(201,168,76,.35);
  border-radius:4px; overflow:hidden; background:rgba(0,0,0,.25);
}
.seg-btn {
  background:transparent; border:none;
  font-family:'Barlow Condensed', sans-serif;
  font-size:14px; font-weight:800; padding:5px 14px;
  color:#c9a84c; cursor:pointer; transition:all .12s;
}
.seg-btn:hover { background:rgba(201,168,76,.12); }
.seg-btn.on { background:#c9a84c; color:#04091a; }

.reset-btn {
  margin-left:auto;
  background:transparent;
  border:1px solid rgba(127,29,29,.7);
  color:#f87171;
  font-family:'Barlow Condensed', sans-serif;
  font-size:12px; font-weight:800; letter-spacing:.16em; text-transform:uppercase;
  padding:7px 14px; border-radius:4px; cursor:pointer; transition:all .15s;
}
.reset-btn:hover { background:#7f1d1d; color:#fff; border-color:#ef4444; }

.clear-pool-btn {
  background:transparent;
  border:1px solid rgba(127,29,29,.6);
  color:#f87171;
  font-family:'Barlow Condensed', sans-serif;
  font-size:11px; font-weight:800; letter-spacing:.14em; text-transform:uppercase;
  padding:4px 9px; border-radius:3px; cursor:pointer; transition:all .15s;
}
.clear-pool-btn:hover:not(:disabled) { background:#7f1d1d; color:#fff; border-color:#ef4444; }
.clear-pool-btn:disabled { opacity:.35; cursor:not-allowed; }

/* ─── BODY ─── */
.body { display:grid; grid-template-columns: 320px 1fr; min-height:580px; }
@media (max-width: 820px) { .body { grid-template-columns: 1fr; } }

.pool-col {
  background:linear-gradient(180deg, #060d22, #050a1c);
  border-right:1px solid rgba(201,168,76,.12);
  display:flex; flex-direction:column;
}
.sec-hdr {
  display:flex; align-items:center; justify-content:space-between;
  padding:14px 18px;
  border-bottom:1px solid rgba(255,255,255,.05);
}
.sec-eyebrow {
  font-family:'Barlow Condensed', sans-serif;
  font-size:10px; font-weight:700; letter-spacing:.25em;
  color:#4a5f88; text-transform:uppercase;
}
.sec-title {
  font-family:'Barlow Condensed', sans-serif;
  font-size:20px; font-weight:900; letter-spacing:.06em;
  color:#fff; text-transform:uppercase;
}
.badge {
  background:rgba(201,168,76,.12); color:#c9a84c;
  font-family:'Barlow Condensed', sans-serif;
  font-size:14px; font-weight:800; padding:3px 12px; border-radius:3px;
  border:1px solid rgba(201,168,76,.32);
  min-width:36px; text-align:center;
}

.inp-area { padding:14px 14px 12px; border-bottom:1px solid rgba(255,255,255,.05); }
.inp-area textarea {
  width:100%;
  background:rgba(0,0,0,.4);
  border:1px solid rgba(255,255,255,.08);
  border-radius:5px;
  color:#e2e8f4;
  font-family:'Inter', sans-serif;
  font-size:13px;
  padding:10px 12px;
  resize:none; height:74px; outline:none;
  transition:border-color .15s, background .15s;
}
.inp-area textarea:focus { border-color:rgba(201,168,76,.5); background:rgba(0,0,0,.55); }
.inp-area textarea::placeholder { color:#2a3a5e; }
.add-btn {
  margin-top:8px; width:100%;
  background:linear-gradient(180deg, rgba(201,168,76,.2), rgba(201,168,76,.08));
  border:1px solid rgba(201,168,76,.4); color:#c9a84c;
  font-family:'Barlow Condensed', sans-serif;
  font-size:13px; font-weight:800; letter-spacing:.16em; text-transform:uppercase;
  padding:9px; border-radius:4px; cursor:pointer; transition:all .15s;
}
.add-btn:hover:not(:disabled) {
  background:linear-gradient(180deg, rgba(201,168,76,.32), rgba(201,168,76,.14));
  color:#fff;
}
.add-btn:disabled { opacity:.4; cursor:not-allowed; }

.pool-list { flex:1; overflow-y:auto; padding:6px 0; }
.pool-list::-webkit-scrollbar { width:4px; }
.pool-list::-webkit-scrollbar-thumb { background:rgba(201,168,76,.25); border-radius:2px; }

.empty-pool {
  padding:48px 20px; text-align:center;
  font-family:'Barlow Condensed', sans-serif;
  font-size:11px; color:#1f2d4d;
  letter-spacing:.22em; text-transform:uppercase;
}
.empty-ico { font-size:32px; opacity:.25; margin-bottom:10px; }

.p-row {
  display:flex; align-items:center; gap:10px;
  padding:9px 14px;
  border-bottom:1px solid rgba(255,255,255,.03);
  transition:background .12s;
}
.p-row:hover { background:rgba(201,168,76,.04); }
.p-row.active { background:rgba(201,168,76,.1); }
.p-num {
  font-family:'Barlow Condensed', sans-serif;
  font-size:11px; font-weight:700; letter-spacing:.05em;
  color:#2a3a5e; width:22px; flex-shrink:0;
}
.p-name {
  flex:1; font-size:14px; color:#cbd5ee; font-weight:500;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.p-row.active .p-name, .p-row:hover .p-name { color:#fff; }
.pick-btn {
  display:inline-flex; align-items:center; gap:6px;
  background:rgba(201,168,76,.12);
  border:1px solid rgba(201,168,76,.35);
  color:#c9a84c;
  font-family:'Barlow Condensed', sans-serif;
  font-size:11px; font-weight:800; letter-spacing:.15em; text-transform:uppercase;
  padding:5px 10px; border-radius:3px;
  cursor:pointer; transition:all .12s; flex-shrink:0;
}
.pick-btn:hover, .p-row.active .pick-btn {
  background:#c9a84c; color:#04091a; border-color:#c9a84c;
}

/* ─── TEAMS ─── */
.teams-col { padding:18px; overflow-y:auto; }
.teams-col::-webkit-scrollbar { width:4px; }
.teams-col::-webkit-scrollbar-thumb { background:rgba(255,255,255,.1); border-radius:2px; }
.teams-grid { display:grid; gap:14px; }

.tcard {
  position:relative; overflow:hidden;
  background:linear-gradient(180deg, #0a1228 0%, #060d22 100%);
  border:1px solid rgba(255,255,255,.06);
  border-radius:6px;
  transition:border-color .2s, box-shadow .2s;
}
.tcard.on-clock {
  border-color:rgba(var(--tc-rgb), .55);
  box-shadow:
    0 0 0 1px rgba(var(--tc-rgb), .25),
    0 0 32px -4px rgba(var(--tc-rgb), .35);
}
.tcard-stripe {
  position:absolute; top:0; left:0; right:0; height:3px;
  background:linear-gradient(90deg, var(--tc), rgba(var(--tc-rgb), .3));
}
.tcard-hdr {
  display:flex; align-items:center; gap:14px;
  padding:14px 16px 12px;
  border-bottom:1px solid rgba(255,255,255,.05);
  background:linear-gradient(180deg, rgba(var(--tc-rgb), .08), transparent);
}
.tcard-id { display:flex; flex-direction:column; align-items:center; flex-shrink:0; }
.tcard-num {
  font-family:'Barlow Condensed', sans-serif;
  font-size:30px; font-weight:900; line-height:1;
  color:var(--tc); letter-spacing:.02em;
}
.tcard-color {
  font-family:'Barlow Condensed', sans-serif;
  font-size:9px; font-weight:700; letter-spacing:.22em;
  color:rgba(var(--tc-rgb), .65); text-transform:uppercase; margin-top:4px;
}
.tcard-name-wrap { flex:1; min-width:0; }
.tcard-name {
  background:transparent; border:none; outline:none;
  font-family:'Barlow Condensed', sans-serif;
  font-size:22px; font-weight:900; letter-spacing:.06em; text-transform:uppercase;
  color:#fff; width:100%; padding:2px 4px; margin:-2px -4px;
  border-radius:3px;
  transition:background .15s;
}
.tcard-name:hover { background:rgba(255,255,255,.04); }
.tcard-name:focus { background:rgba(0,0,0,.3); }
.tcard-stats {
  display:flex; align-items:center; gap:8px; margin-top:5px; flex-wrap:wrap;
  font-family:'Barlow Condensed', sans-serif;
  font-size:11px; font-weight:700; letter-spacing:.16em; text-transform:uppercase;
  color:#5a6f99;
}
.otc-pill {
  background:var(--tc); color:#04091a;
  padding:2px 7px; border-radius:2px; font-size:10px; white-space:nowrap;
  font-weight:900; letter-spacing:.18em;
  animation:pulse 1.6s infinite;
}

.tcard-body { min-height:80px; }
.tm-player {
  display:flex; align-items:center; gap:12px;
  padding:9px 16px;
  border-bottom:1px solid rgba(255,255,255,.04);
  cursor:pointer; transition:background .12s;
}
.tm-player:last-child { border-bottom:none; }
.tm-player:hover { background:rgba(239,68,68,.08); }
.tm-player:hover .rel-hint { opacity:1; }
.tm-round {
  font-family:'Barlow Condensed', sans-serif;
  font-size:10px; font-weight:800; letter-spacing:.12em;
  color:rgba(var(--tc-rgb), .8);
  min-width:24px;
  background:rgba(var(--tc-rgb), .12);
  padding:2px 5px; border-radius:2px;
  text-align:center;
}
.tm-pname { flex:1; font-size:14px; color:#cdd7eb; font-weight:500; }
.rel-hint {
  font-family:'Barlow Condensed', sans-serif;
  font-size:10px; color:#ef4444; font-weight:800;
  letter-spacing:.16em; text-transform:uppercase;
  opacity:0; transition:opacity .12s;
}
.empty-team {
  padding:30px 16px; text-align:center;
  font-family:'Barlow Condensed', sans-serif;
  font-size:11px; color:#1f2d4d;
  letter-spacing:.22em; text-transform:uppercase;
}
.tcard.on-clock .empty-team { color:rgba(var(--tc-rgb), .55); }

/* ─── PORTAL POPOVER ─── */
.pop {
  position:fixed; z-index:9999; width:260px;
  background:linear-gradient(180deg, #0a1530 0%, #07102a 100%);
  border:1px solid rgba(201,168,76,.5);
  border-radius:7px;
  box-shadow:
    0 24px 60px -10px rgba(0,0,0,.85),
    0 0 0 6px rgba(201,168,76,.06),
    0 0 40px -10px rgba(201,168,76,.3);
  overflow:visible;
  animation:popIn .14s cubic-bezier(.2,.8,.3,1.1);
}
@keyframes popIn { from { opacity:0; transform:scale(.96); } to { opacity:1; transform:scale(1); } }
.pop-arrow {
  position:absolute; width:11px; height:11px;
  background:#0a1530; border:1px solid rgba(201,168,76,.5);
  border-right:none; border-top:none;
  transform:rotate(45deg);
}
.pop-left .pop-arrow { right:-7px; top:50%; margin-top:-5.5px;
  background:#07102a; border:1px solid rgba(201,168,76,.5); border-left:none; border-bottom:none; }
.pop-right .pop-arrow { left:-7px; top:50%; margin-top:-5.5px; }
.pop-below .pop-arrow { top:-7px; left:24px;
  background:#0a1530; border:1px solid rgba(201,168,76,.5); border-right:none; border-bottom:none; }

.pop-hdr {
  padding:12px 14px 10px;
  border-bottom:1px solid rgba(201,168,76,.15);
  background:linear-gradient(180deg, rgba(201,168,76,.1), transparent);
}
.pop-eyebrow {
  font-family:'Barlow Condensed', sans-serif;
  font-size:9px; font-weight:800; letter-spacing:.28em;
  color:#c9a84c; text-transform:uppercase; margin-bottom:3px;
}
.pop-name {
  font-family:'Barlow Condensed', sans-serif;
  font-size:18px; font-weight:900; letter-spacing:.04em;
  color:#fff; text-transform:uppercase;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.pop-list { padding:8px; display:flex; flex-direction:column; gap:5px; }
.pop-team {
  display:flex; align-items:center; gap:10px;
  background:rgba(0,0,0,.3);
  border:1px solid rgba(255,255,255,.07);
  border-left:3px solid var(--tc);
  border-radius:4px;
  padding:9px 12px;
  cursor:pointer; transition:all .12s;
  text-align:left;
}
.pop-team:hover {
  background:rgba(var(--tc-rgb), .14);
  border-color:rgba(var(--tc-rgb), .55);
  border-left-color:var(--tc);
  transform:translateX(2px);
}
.pop-dot {
  width:9px; height:9px; border-radius:50%; background:var(--tc);
  box-shadow:0 0 8px var(--tc);
  flex-shrink:0;
}
.pop-team-name {
  flex:1;
  font-family:'Barlow Condensed', sans-serif;
  font-size:14px; font-weight:800; letter-spacing:.08em;
  color:#fff; text-transform:uppercase;
}
.pop-team-ct {
  font-family:'Barlow Condensed', sans-serif;
  font-size:11px; font-weight:700;
  color:rgba(var(--tc-rgb), .9);
  background:rgba(var(--tc-rgb), .14);
  padding:2px 7px; border-radius:2px; min-width:22px; text-align:center;
}
.pop-foot {
  padding:8px 14px 10px;
  font-family:'Barlow Condensed', sans-serif;
  font-size:10px; font-weight:600; letter-spacing:.18em;
  color:#3a4f74; text-transform:uppercase; text-align:center;
  border-top:1px solid rgba(255,255,255,.04);
}

/* ─── MODAL ─── */
.modal-overlay {
  position:fixed; inset:0;
  background:rgba(2,5,12,.78);
  backdrop-filter:blur(4px);
  z-index:1000;
  display:flex; align-items:center; justify-content:center;
  animation:fade .15s ease-out;
}
@keyframes fade { from { opacity:0 } to { opacity:1 } }
.modal {
  background:linear-gradient(180deg, #0a1530, #07102a);
  border:1px solid rgba(201,168,76,.45);
  border-radius:8px;
  padding:28px 26px;
  width:340px; max-width:calc(100vw - 32px);
  text-align:center;
  box-shadow:0 30px 80px -20px rgba(0,0,0,.9);
}
.modal h3 {
  font-family:'Barlow Condensed', sans-serif;
  font-size:24px; font-weight:900;
  text-transform:uppercase; letter-spacing:.1em;
  color:#fff; margin:0 0 10px;
}
.modal p { font-size:13px; color:#7387ad; margin:0 0 22px; line-height:1.6; }
.modal-btns { display:flex; gap:10px; }
.mbtn {
  flex:1; font-family:'Barlow Condensed', sans-serif;
  font-size:13px; font-weight:800; letter-spacing:.14em; text-transform:uppercase;
  padding:11px; border-radius:4px; cursor:pointer; border:1px solid; transition:all .12s;
}
.mbtn-cancel { background:transparent; border-color:rgba(255,255,255,.14); color:#7387ad; }
.mbtn-cancel:hover { background:rgba(255,255,255,.06); color:#fff; }
.mbtn-ok { background:#b91c1c; border-color:#b91c1c; color:#fff; }
.mbtn-ok:hover { background:#ef4444; border-color:#ef4444; }

@media (max-width: 760px) {
  .page { padding:10px; }
  .hdr { padding:16px 14px 14px; gap:12px; }
  .hdr-title { font-size:24px; }
  .crest { width:42px; height:50px; }
  .stat { padding:5px 10px; min-width:64px; }
  .stat-val { font-size:16px; }
  .broadcast { padding:12px 14px; gap:12px; }
  .bc-divider { display:none; }
  .teams-col { padding:12px; }
  .teams-grid { grid-template-columns:1fr !important; }
}
`;
