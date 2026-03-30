import { useState, useEffect, useRef, useCallback } from "react";

// ─── Config ───────────────────────────────────────────────────────────────────
const PAIRS = [
  { symbol: "BTCINR",  label: "BTC",     full: "Bitcoin",  dcxPair: "B-BTC_INR",  candlePair: "BTCINR", color: "#f7931a", bg: "#fff8f0", icon: "₿" },
  { symbol: "ETHINR",  label: "ETH",     full: "Ethereum", dcxPair: "B-ETH_INR",  candlePair: "ETHINR", color: "#627eea", bg: "#f0f2ff", icon: "Ξ" },
  { symbol: "SOLINR",  label: "SOL",     full: "Solana",   dcxPair: "B-SOL_INR",  candlePair: "SOLINR", color: "#9945ff", bg: "#f8f0ff", icon: "◎" },
];

const EMA_FAST     = 9;
const EMA_SLOW     = 21;
const CANDLE_MS    = 5 * 60 * 1000;   // 5 min candle refresh
const TICKER_MS    = 10 * 1000;        // 10 sec live price refresh
const STORAGE_KEY  = "cryptoedge_v3";

// ─── EMA ──────────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function getSignal(closes) {
  if (closes.length < EMA_SLOW + 2) return null;
  const fast  = calcEMA(closes, EMA_FAST);
  const slow  = calcEMA(closes, EMA_SLOW);
  const fastP = calcEMA(closes.slice(0, -1), EMA_FAST);
  const slowP = calcEMA(closes.slice(0, -1), EMA_SLOW);
  if (!fast || !slow || !fastP || !slowP) return null;
  if (fastP <= slowP && fast > slow) return "BUY";
  if (fastP >= slowP && fast < slow) return "SELL";
  return null;
}

// ─── Storage ──────────────────────────────────────────────────────────────────
const load = () => { try { const s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch { return null; } };
const save = (s)  => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {} };

function freshState(capital) {
  return {
    capital:      Number(capital),
    startCapital: Number(capital),
    positions:    {},
    trades:       [],
    realizedPnl:  0,
  };
}
const initState = () => load() || freshState(1000);

// ─── Formatters ───────────────────────────────────────────────────────────────
const fmt     = (n, d = 2) => n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtSign = (n) => (n >= 0 ? "+" : "") + fmt(n);
const ts      = () => new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ─── App ──────────────────────────────────────────────────────────────────────
export default function CryptoEdge() {
  const [state, setState]         = useState(initState);
  const [prices, setPrices]       = useState({});
  const [prevPrices, setPrev]     = useState({});
  const [candles, setCandles]     = useState({});   // { symbol: number[] } — close prices
  const [emas, setEmas]           = useState({});
  const [logs, setLogs]           = useState([]);
  const [tab, setTab]             = useState("dashboard");
  const [apiStatus, setApiStatus] = useState({ ticker: "…", candles: "…" });
  const [showCapModal, setShowCap]= useState(false);
  const [capInput, setCapInput]   = useState("");
  const [flashPnl, setFlashPnl]   = useState(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => { save(state); }, [state]);

  const addLog = useCallback((msg, type = "info") => {
    setLogs(p => [{ msg, type, time: ts() }, ...p].slice(0, 120));
  }, []);

  // ─── Fetch Live Ticker ───────────────────────────────────────────────────
  const fetchTicker = useCallback(async () => {
    try {
      const res  = await fetch("/api/ticker");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const map  = {};
      data.forEach(t => { map[t.market] = parseFloat(t.last_price); });

      const newP = {};
      PAIRS.forEach(p => { if (map[p.dcxPair]) newP[p.symbol] = map[p.dcxPair]; });

      setPrev(prev => ({ ...prev, ...prices }));
      setPrices(pp => ({ ...pp, ...newP }));
      setApiStatus(s => ({ ...s, ticker: "live" }));
    } catch (e) {
      setApiStatus(s => ({ ...s, ticker: "error" }));
      addLog("Ticker error: " + e.message, "error");
    }
  }, [prices, addLog]);

  // ─── Fetch 5-min Candles ─────────────────────────────────────────────────
  const fetchCandles = useCallback(async () => {
    let anyOk = false;
    for (const p of PAIRS) {
      try {
        const res  = await fetch(`/api/candles?pair=${p.candlePair}`);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        // CoinDCX candle format: [{ open, high, low, close, volume, time }]
        // Sort by time ascending, extract closes
        const sorted = Array.isArray(data)
          ? [...data].sort((a, b) => a.time - b.time)
          : [];
        const closes = sorted.map(c => parseFloat(c.close)).filter(Boolean);

        if (closes.length > 0) {
          setCandles(prev => ({ ...prev, [p.symbol]: closes }));
          anyOk = true;
        }
      } catch (e) {
        addLog(`Candles error ${p.label}: ${e.message}`, "error");
      }
    }
    setApiStatus(s => ({ ...s, candles: anyOk ? "live" : "error" }));
  }, [addLog]);

  // ─── Tick loops ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetchTicker();
    const id = setInterval(fetchTicker, TICKER_MS);
    return () => clearInterval(id);
  }, [fetchTicker]);

  useEffect(() => {
    fetchCandles();
    const id = setInterval(fetchCandles, CANDLE_MS);
    return () => clearInterval(id);
  }, [fetchCandles]);

  // ─── EMA + Signal Engine (runs on candle update) ─────────────────────────
  useEffect(() => {
    const newEmas = {};
    PAIRS.forEach(p => {
      const closes = candles[p.symbol] || [];
      const fast   = calcEMA(closes, EMA_FAST);
      const slow   = calcEMA(closes, EMA_SLOW);
      newEmas[p.symbol] = { fast, slow, candles: closes.length };

      const signal = getSignal(closes);
      if (!signal) return;

      const price = prices[p.symbol];
      if (!price) return;

      const cur = stateRef.current;
      const pos = cur.positions[p.symbol];

      // Exit opposite position
      if (pos && pos.side !== signal) {
        const pnl       = (pos.side === "BUY" ? price - pos.entryPrice : pos.entryPrice - price) * pos.qty;
        const recovered = pos.qty * pos.entryPrice + pnl;
        setState(s => ({
          ...s,
          capital:     s.capital + recovered,
          realizedPnl: s.realizedPnl + pnl,
          positions:   Object.fromEntries(Object.entries(s.positions).filter(([k]) => k !== p.symbol)),
          trades:      [{ symbol: p.symbol, side: "EXIT", price, qty: pos.qty, pnl, time: ts() }, ...s.trades].slice(0, 80),
        }));
        setFlashPnl({ val: pnl, label: p.label });
        setTimeout(() => setFlashPnl(null), 3000);
        addLog(`🚪 EXIT ${p.label} @ ₹${fmt(price, 0)} | P&L: ₹${fmtSign(pnl)}`, pnl >= 0 ? "profit" : "loss");
        return;
      }

      // Enter new position
      if (!pos) {
        const usable = stateRef.current.capital * 0.9;
        if (usable < 1) { addLog("⚠️ Insufficient capital", "warn"); return; }
        const qty = usable / price;
        setState(s => ({
          ...s,
          capital:   s.capital - qty * price,
          positions: { ...s.positions, [p.symbol]: { entryPrice: price, qty, side: signal } },
          trades:    [{ symbol: p.symbol, side: signal, price, qty, pnl: null, time: ts() }, ...s.trades].slice(0, 80),
        }));
        addLog(`${signal === "BUY" ? "🟢" : "🔴"} ${signal} ${p.label} @ ₹${fmt(price, 0)}`, "entry");
      }
    });
    setEmas(newEmas);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles]);

  // ─── Derived ──────────────────────────────────────────────────────────────
  const unrealized = Object.entries(state.positions).reduce((sum, [sym, pos]) => {
    const p = prices[sym];
    if (!p) return sum;
    return sum + (pos.side === "BUY" ? p - pos.entryPrice : pos.entryPrice - p) * pos.qty;
  }, 0);
  const totalValue = state.capital + Object.entries(state.positions).reduce((sum, [sym, pos]) => {
    return sum + (prices[sym] || pos.entryPrice) * pos.qty;
  }, 0);
  const totalPct = state.startCapital > 0 ? ((totalValue - state.startCapital) / state.startCapital * 100) : 0;

  // ─── Capital modal ────────────────────────────────────────────────────────
  const handleSetCapital = () => {
    const val = parseFloat(capInput);
    if (!val || val < 1) return;
    setState(freshState(val));
    setLogs([]);
    setShowCap(false);
    setCapInput("");
    addLog(`💰 Capital set to ₹${fmt(val)}`, "info");
  };

  const handleReset = () => {
    if (!window.confirm("Reset all paper trading data?")) return;
    setState(freshState(state.startCapital));
    setLogs([]);
    addLog("🔄 Reset complete.", "info");
  };

  // ─── Overall status ───────────────────────────────────────────────────────
  const bothLive = apiStatus.ticker === "live" && apiStatus.candles === "live";
  const anyError = apiStatus.ticker === "error" || apiStatus.candles === "error";
  const statusColor = bothLive ? "#22c55e" : anyError ? "#ef4444" : "#f59e0b";
  const statusLabel = bothLive ? "Live" : anyError ? "Error" : "Connecting";

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>
      <style>{CSS}</style>

      {/* Flash Toast */}
      {flashPnl && (
        <div style={{ ...S.toast, background: flashPnl.val >= 0 ? "#f0fdf4" : "#fff1f2", borderColor: flashPnl.val >= 0 ? "#22c55e" : "#ef4444", color: flashPnl.val >= 0 ? "#16a34a" : "#dc2626" }}>
          {flashPnl.val >= 0 ? "🎉" : "📉"} {flashPnl.label} closed &nbsp;<strong>₹{fmtSign(flashPnl.val)}</strong>
        </div>
      )}

      {/* Capital Modal */}
      {showCapModal && (
        <div style={S.overlay} onClick={() => setShowCap(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalTitle}>Set Paper Capital</div>
            <div style={S.modalSub}>All positions and history will be cleared.</div>
            <input style={S.modalInput} type="number" placeholder="₹ Enter amount"
              value={capInput} onChange={e => setCapInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSetCapital()} autoFocus />
            <div style={S.modalBtns}>
              <button style={S.btnGhost} onClick={() => setShowCap(false)}>Cancel</button>
              <button style={S.btnPrimary} onClick={handleSetCapital}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header style={S.header}>
        <div style={S.logo}>
          <div style={S.logoIcon}>₿</div>
          <div>
            <div style={S.logoName}>CryptoEdge <span style={S.ai}>AI</span></div>
            <div style={S.logoSub}>Paper Trading · CoinDCX · 5m EMA</div>
          </div>
        </div>
        <div style={S.statusBadge}>
          <div style={{ ...S.dot, background: statusColor }} className="blink" />
          <span style={{ color: statusColor, fontSize: 11, fontWeight: 700 }}>{statusLabel}</span>
        </div>
      </header>

      {/* API Debug Strip */}
      {anyError && (
        <div style={S.errorStrip}>
          ⚠️ API issue — Ticker: {apiStatus.ticker} · Candles: {apiStatus.candles}
        </div>
      )}

      {/* Summary */}
      <div style={S.summary}>
        <SCard label="Portfolio" value={`₹${fmt(totalValue)}`} sub={`${fmtSign(totalPct)}%`} subColor={totalPct >= 0 ? "#16a34a" : "#dc2626"} color="#6366f1" />
        <SCard label="Realized P&L" value={`₹${fmtSign(state.realizedPnl)}`} color={state.realizedPnl >= 0 ? "#16a34a" : "#dc2626"} />
        <SCard label="Unrealized" value={`₹${fmtSign(unrealized)}`} color={unrealized >= 0 ? "#0891b2" : "#ea580c"} />
        <SCard label="Free Cash" value={`₹${fmt(state.capital)}`} color="#7c3aed" />
      </div>

      {/* Tabs */}
      <nav style={S.nav}>
        {[["dashboard","📊"],["positions","📂"],["trades","📋"],["logs","🔔"]].map(([t, icon]) => (
          <button key={t} style={{ ...S.tab, ...(tab === t ? S.tabOn : {}) }} onClick={() => setTab(t)}>
            {icon} {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      <main style={S.main}>

        {/* DASHBOARD */}
        {tab === "dashboard" && <>
          <div style={S.grid}>
            {PAIRS.map(p => {
              const price  = prices[p.symbol];
              const prev   = prevPrices[p.symbol];
              const up     = price && prev ? price > prev : null;
              const pos    = state.positions[p.symbol];
              const em     = emas[p.symbol] || {};
              const trend  = em.fast && em.slow ? (em.fast > em.slow ? "▲ Bullish" : "▼ Bearish") : "Warming up…";
              const tColor = em.fast && em.slow ? (em.fast > em.slow ? "#16a34a" : "#dc2626") : "#94a3b8";
              const warmPct= Math.min(100, ((em.candles || 0) / EMA_SLOW) * 100);
              const upnl   = pos && price ? (pos.side === "BUY" ? price - pos.entryPrice : pos.entryPrice - price) * pos.qty : null;

              return (
                <div key={p.symbol} style={{ ...S.pCard, borderTop: `4px solid ${p.color}` }} className="card">
                  <div style={S.pTop}>
                    <div style={{ ...S.pIcon, background: p.bg, color: p.color }}>{p.icon}</div>
                    <div style={{ flex: 1 }}>
                      <div style={S.pName}>{p.full}</div>
                      <div style={S.pSym}>{p.label}/INR</div>
                    </div>
                    {pos && <div style={{ ...S.badge, background: pos.side === "BUY" ? "#dcfce7" : "#fee2e2", color: pos.side === "BUY" ? "#16a34a" : "#dc2626" }}>{pos.side}</div>}
                  </div>

                  <div style={{ ...S.price, color: up === true ? "#16a34a" : up === false ? "#dc2626" : "#1e293b" }}
                    className={up === true ? "fg" : up === false ? "fr" : ""}>
                    {price ? `₹${fmt(price, 0)}` : "₹—"}
                  </div>

                  <div style={{ fontSize: 11, fontWeight: 700, color: tColor, marginBottom: 8 }}>{trend}</div>

                  <div style={S.emaRow}>
                    <span style={{ ...S.chip, background: "#eff6ff", color: "#3b82f6" }}>EMA{EMA_FAST}: {em.fast ? fmt(em.fast, 0) : "—"}</span>
                    <span style={{ ...S.chip, background: "#fdf4ff", color: "#a855f7" }}>EMA{EMA_SLOW}: {em.slow ? fmt(em.slow, 0) : "—"}</span>
                  </div>

                  {upnl != null && (
                    <div style={{ fontSize: 11, fontWeight: 700, color: upnl >= 0 ? "#16a34a" : "#dc2626", marginBottom: 6 }}>
                      Unrealized: ₹{fmtSign(upnl)}
                    </div>
                  )}

                  <div style={S.track}><div style={{ ...S.bar, width: `${warmPct}%`, background: warmPct >= 100 ? p.color : "#94a3b8" }} /></div>
                  <div style={S.trackLabel}>{warmPct >= 100 ? "✓ Signals active" : `${em.candles || 0}/${EMA_SLOW} candles loaded`}</div>
                </div>
              );
            })}
          </div>

          {/* Capital Row */}
          <div style={S.capRow}>
            <div>
              <div style={S.capLabel}>Starting Capital</div>
              <div style={S.capVal}>₹{fmt(state.startCapital)}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={S.btnOutline} onClick={() => setShowCap(true)}>✏️ Change</button>
              <button style={S.btnRed} onClick={handleReset}>🔄 Reset</button>
            </div>
          </div>

          {/* API Status detail */}
          <div style={S.apiBox}>
            <div style={S.apiRow}>
              <span>Ticker (10s)</span>
              <span style={{ color: apiStatus.ticker === "live" ? "#16a34a" : "#dc2626", fontWeight: 700 }}>
                {apiStatus.ticker === "live" ? "✓ Live" : apiStatus.ticker === "error" ? "✗ Error" : "…"}
              </span>
            </div>
            <div style={S.apiRow}>
              <span>5m Candles</span>
              <span style={{ color: apiStatus.candles === "live" ? "#16a34a" : "#dc2626", fontWeight: 700 }}>
                {apiStatus.candles === "live" ? "✓ Live" : apiStatus.candles === "error" ? "✗ Error" : "…"}
              </span>
            </div>
            <div style={S.apiRow}>
              <span>Strategy</span>
              <span style={{ color: "#6366f1", fontWeight: 700 }}>EMA {EMA_FAST}/{EMA_SLOW} · 5m candles</span>
            </div>
            <div style={S.apiRow}>
              <span>Open Positions</span>
              <span style={{ fontWeight: 700, color: "#1e293b" }}>{Object.keys(state.positions).length} / {PAIRS.length}</span>
            </div>
          </div>
        </>}

        {/* POSITIONS */}
        {tab === "positions" && <>
          <div style={S.secTitle}>Open Positions ({Object.keys(state.positions).length})</div>
          {Object.keys(state.positions).length === 0
            ? <Empty icon="📭" text="No open positions yet. Waiting for EMA crossover on 5m candles." />
            : Object.entries(state.positions).map(([sym, pos]) => {
              const pair  = PAIRS.find(p => p.symbol === sym);
              const price = prices[sym] || pos.entryPrice;
              const upnl  = (pos.side === "BUY" ? price - pos.entryPrice : pos.entryPrice - price) * pos.qty;
              const pct   = (upnl / (pos.entryPrice * pos.qty)) * 100;
              return (
                <div key={sym} style={{ ...S.posCard, borderLeft: `4px solid ${pair?.color}` }}>
                  <div style={S.posHead}>
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <span style={{ ...S.pIcon, background: pair?.bg, color: pair?.color, width:38, height:38, fontSize:18 }}>{pair?.icon}</span>
                      <div>
                        <div style={{ fontWeight:700, color:"#1e293b" }}>{pair?.full}</div>
                        <div style={{ fontSize:10, color:"#94a3b8" }}>{pair?.label}/INR</div>
                      </div>
                    </div>
                    <div style={{ ...S.badge, background: pos.side==="BUY"?"#dcfce7":"#fee2e2", color: pos.side==="BUY"?"#16a34a":"#dc2626", fontSize:13, padding:"5px 14px" }}>{pos.side}</div>
                  </div>
                  <div style={S.kvGrid}>
                    <Kv label="Entry"      val={`₹${fmt(pos.entryPrice, 0)}`} />
                    <Kv label="Current"    val={`₹${fmt(price, 0)}`} />
                    <Kv label="Quantity"   val={pos.qty.toFixed(6)} />
                    <Kv label="Invested"   val={`₹${fmt(pos.qty * pos.entryPrice)}`} />
                    <Kv label="Curr Value" val={`₹${fmt(pos.qty * price)}`} />
                    <Kv label="Unreal P&L" val={`₹${fmtSign(upnl)} (${fmtSign(pct)}%)`} color={upnl>=0?"#16a34a":"#dc2626"} />
                  </div>
                </div>
              );
            })
          }
        </>}

        {/* TRADES */}
        {tab === "trades" && <>
          <div style={S.secTitle}>Trade History ({state.trades.length})</div>
          {state.trades.length === 0
            ? <Empty icon="📋" text="No trades yet." />
            : state.trades.map((t, i) => {
              const pair = PAIRS.find(p => p.symbol === t.symbol);
              const isExit = t.side === "EXIT";
              const win = isExit && t.pnl >= 0;
              return (
                <div key={i} style={{ ...S.tCard, borderLeft: `4px solid ${isExit ? (win?"#22c55e":"#ef4444") : (pair?.color||"#6366f1")}` }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:20 }}>{pair?.icon}</span>
                    <div>
                      <div style={{ fontWeight:600, color:"#1e293b", fontSize:13 }}>{pair?.label}/INR</div>
                      <div style={{ fontSize:10, color:"#94a3b8" }}>{t.time}</div>
                    </div>
                  </div>
                  <div style={{ textAlign:"center" }}>
                    <div style={{ ...S.badge, background: t.side==="BUY"?"#dbeafe":isExit?(win?"#dcfce7":"#fee2e2"):"#fce7f3", color: t.side==="BUY"?"#2563eb":isExit?(win?"#16a34a":"#dc2626"):"#db2777" }}>{t.side}</div>
                    <div style={{ fontSize:11, color:"#64748b", marginTop:4 }}>₹{fmt(t.price,0)}</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    {t.pnl != null
                      ? <div style={{ fontWeight:700, color: t.pnl>=0?"#16a34a":"#dc2626" }}>₹{fmtSign(t.pnl)}</div>
                      : <div style={{ color:"#94a3b8", fontSize:12 }}>Open</div>
                    }
                    <div style={{ fontSize:10, color:"#94a3b8" }}>qty {t.qty.toFixed(4)}</div>
                  </div>
                </div>
              );
            })
          }
        </>}

        {/* LOGS */}
        {tab === "logs" && <>
          <div style={S.secTitle}>System Logs</div>
          {logs.length === 0
            ? <Empty icon="🔔" text="Logs will appear as signals fire." />
            : logs.map((l, i) => (
              <div key={i} style={{ ...S.logRow, borderLeft: `3px solid ${LC[l.type]||"#94a3b8"}` }}>
                <span style={S.logTime}>{l.time}</span>
                <span style={{ color: LC[l.type]||"#475569", flex:1, fontSize:12 }}>{l.msg}</span>
              </div>
            ))
          }
        </>}

      </main>

      <footer style={S.footer}>
        EMA {EMA_FAST}/{EMA_SLOW} · 5m Candles · Paper Mode · CoinDCX INR
      </footer>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function SCard({ label, value, sub, color, subColor }) {
  return (
    <div style={S.sc}>
      <div style={S.scLabel}>{label}</div>
      <div style={{ ...S.scVal, color }}>{value}</div>
      {sub && <div style={{ fontSize:11, color: subColor||"#64748b", fontWeight:600 }}>{sub}</div>}
    </div>
  );
}
function Kv({ label, val, color }) {
  return (
    <div style={S.kv}>
      <div style={S.kvL}>{label}</div>
      <div style={{ ...S.kvV, color: color||"#1e293b" }}>{val}</div>
    </div>
  );
}
function Empty({ icon, text }) {
  return <div style={{ textAlign:"center", padding:"48px 20px", color:"#94a3b8" }}><div style={{ fontSize:36, marginBottom:10 }}>{icon}</div><div style={{ fontSize:13 }}>{text}</div></div>;
}

const LC = { info:"#6366f1", entry:"#0891b2", profit:"#16a34a", loss:"#dc2626", warn:"#f59e0b", error:"#ef4444" };

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  root:      { minHeight:"100vh", background:"linear-gradient(135deg,#f0f9ff 0%,#faf5ff 50%,#fff7ed 100%)", fontFamily:"'Nunito','Segoe UI',sans-serif", display:"flex", flexDirection:"column", maxWidth:480, margin:"0 auto" },
  header:    { background:"white", padding:"14px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", boxShadow:"0 2px 12px #6366f115", position:"sticky", top:0, zIndex:10 },
  logo:      { display:"flex", alignItems:"center", gap:10 },
  logoIcon:  { width:40, height:40, borderRadius:12, background:"linear-gradient(135deg,#6366f1,#a855f7)", color:"white", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, fontWeight:700, boxShadow:"0 4px 12px #6366f140" },
  logoName:  { fontSize:17, fontWeight:800, color:"#1e293b", lineHeight:1.2 },
  ai:        { background:"linear-gradient(90deg,#6366f1,#a855f7)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" },
  logoSub:   { fontSize:9, color:"#94a3b8", letterSpacing:"0.04em" },
  statusBadge:{ display:"flex", alignItems:"center", gap:5, background:"#f8faff", border:"1px solid #e2e8f0", padding:"5px 10px", borderRadius:20 },
  dot:       { width:8, height:8, borderRadius:"50%" },
  errorStrip:{ background:"#fff1f2", color:"#dc2626", fontSize:11, fontWeight:700, padding:"8px 16px", textAlign:"center", borderBottom:"1px solid #fecdd3" },
  summary:   { display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, padding:"10px 12px", background:"white", borderBottom:"1px solid #f1f5f9" },
  sc:        { background:"#fafbff", borderRadius:10, padding:"10px 12px", border:"1px solid #e2e8f0" },
  scLabel:   { fontSize:9, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:4 },
  scVal:     { fontSize:16, fontWeight:800, lineHeight:1.1 },
  nav:       { display:"flex", background:"white", borderBottom:"2px solid #f1f5f9", position:"sticky", top:68, zIndex:9 },
  tab:       { flex:1, padding:"10px 4px", background:"transparent", border:"none", borderBottom:"3px solid transparent", color:"#94a3b8", cursor:"pointer", fontSize:10, fontWeight:700, letterSpacing:"0.03em", transition:"all 0.2s", fontFamily:"inherit" },
  tabOn:     { color:"#6366f1", borderBottom:"3px solid #6366f1", background:"#fafbff" },
  main:      { flex:1, padding:"14px 12px", overflowY:"auto" },
  grid:      { display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 },
  pCard:     { background:"white", borderRadius:14, padding:"13px", boxShadow:"0 2px 12px #0000000a", border:"1px solid #f1f5f9" },
  pTop:      { display:"flex", alignItems:"center", gap:8, marginBottom:8 },
  pIcon:     { width:32, height:32, borderRadius:9, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, fontWeight:700, flexShrink:0 },
  pName:     { fontSize:12, fontWeight:700, color:"#1e293b" },
  pSym:      { fontSize:9, color:"#94a3b8" },
  badge:     { fontSize:9, fontWeight:800, padding:"2px 7px", borderRadius:6, letterSpacing:"0.05em" },
  price:     { fontSize:19, fontWeight:800, marginBottom:4, transition:"color 0.3s" },
  emaRow:    { display:"flex", gap:4, flexWrap:"wrap", marginBottom:6 },
  chip:      { fontSize:9, fontWeight:700, padding:"2px 6px", borderRadius:5 },
  track:     { height:4, background:"#f1f5f9", borderRadius:2, overflow:"hidden", marginBottom:3 },
  bar:       { height:"100%", borderRadius:2, transition:"width 0.6s ease" },
  trackLabel:{ fontSize:9, color:"#94a3b8" },
  capRow:    { background:"white", borderRadius:14, padding:"13px 14px", display:"flex", justifyContent:"space-between", alignItems:"center", boxShadow:"0 2px 8px #0000000a", marginBottom:10, flexWrap:"wrap", gap:8 },
  capLabel:  { fontSize:10, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.08em" },
  capVal:    { fontSize:18, fontWeight:800, color:"#6366f1" },
  btnOutline:{ fontSize:11, fontWeight:700, padding:"7px 12px", borderRadius:8, border:"2px solid #6366f1", color:"#6366f1", background:"transparent", cursor:"pointer", fontFamily:"inherit" },
  btnRed:    { fontSize:11, fontWeight:700, padding:"7px 12px", borderRadius:8, border:"2px solid #ef4444", color:"#ef4444", background:"transparent", cursor:"pointer", fontFamily:"inherit" },
  apiBox:    { background:"white", borderRadius:12, padding:"12px 14px", boxShadow:"0 2px 8px #0000000a" },
  apiRow:    { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 0", borderBottom:"1px solid #f8fafc", fontSize:12, color:"#64748b" },
  secTitle:  { fontSize:11, fontWeight:800, color:"#6366f1", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:10 },
  posCard:   { background:"white", borderRadius:14, padding:"14px", marginBottom:10, boxShadow:"0 2px 10px #0000000a" },
  posHead:   { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 },
  kvGrid:    { display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 },
  kv:        { background:"#f8fafc", borderRadius:8, padding:"8px 10px" },
  kvL:       { fontSize:9, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:2 },
  kvV:       { fontSize:12, fontWeight:700 },
  tCard:     { background:"white", borderRadius:12, padding:"12px 14px", marginBottom:8, display:"flex", justifyContent:"space-between", alignItems:"center", boxShadow:"0 2px 8px #0000000a" },
  logRow:    { background:"white", borderRadius:8, padding:"7px 12px", marginBottom:5, display:"flex", gap:10, alignItems:"flex-start" },
  logTime:   { fontSize:10, color:"#94a3b8", minWidth:64, paddingTop:1 },
  footer:    { padding:"10px", textAlign:"center", fontSize:10, color:"#94a3b8", background:"white", borderTop:"1px solid #f1f5f9" },
  toast:     { position:"fixed", top:12, left:"50%", transform:"translateX(-50%)", border:"2px solid", borderRadius:12, padding:"10px 20px", fontSize:13, fontWeight:600, zIndex:100, boxShadow:"0 8px 24px #00000015", whiteSpace:"nowrap" },
  overlay:   { position:"fixed", inset:0, background:"#00000040", zIndex:50, display:"flex", alignItems:"center", justifyContent:"center", padding:20 },
  modal:     { background:"white", borderRadius:18, padding:24, width:"100%", maxWidth:320, boxShadow:"0 20px 60px #00000020" },
  modalTitle:{ fontSize:20, fontWeight:800, color:"#1e293b", marginBottom:6 },
  modalSub:  { fontSize:12, color:"#94a3b8", marginBottom:16 },
  modalInput:{ width:"100%", padding:"12px 14px", borderRadius:10, border:"2px solid #e2e8f0", fontSize:16, fontFamily:"inherit", outline:"none", marginBottom:16, boxSizing:"border-box" },
  modalBtns: { display:"flex", gap:10 },
  btnGhost:  { flex:1, fontSize:13, fontWeight:600, padding:"10px", borderRadius:10, border:"2px solid #e2e8f0", color:"#64748b", background:"white", cursor:"pointer", fontFamily:"inherit" },
  btnPrimary:{ flex:1, fontSize:13, fontWeight:700, padding:"10px", borderRadius:10, border:"none", background:"linear-gradient(135deg,#6366f1,#a855f7)", color:"white", cursor:"pointer", fontFamily:"inherit" },
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#f0f9ff;}
  .card{transition:transform 0.15s,box-shadow 0.15s;}
  .card:hover{transform:translateY(-2px);box-shadow:0 8px 24px #00000012!important;}
  .blink{animation:bl 2s infinite;}
  @keyframes bl{0%,100%{opacity:1}50%{opacity:0.35}}
  .fg{animation:fg 0.5s;}
  .fr{animation:fr 0.5s;}
  @keyframes fg{0%{color:#16a34a}100%{}}
  @keyframes fr{0%{color:#dc2626}100%{}}
  input:focus{border-color:#6366f1!important;outline:none;}
  button:active{opacity:0.8;}
  ::-webkit-scrollbar{width:4px;}
  ::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:2px;}
`;
