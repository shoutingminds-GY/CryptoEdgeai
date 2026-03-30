import { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const PAIRS = [
  { symbol: "BTCINR", label: "BTC", full: "Bitcoin", dcxPair: "B-BTC_INR", color: "#f7931a", bg: "#fff8f0", icon: "₿" },
  { symbol: "ETHINR", label: "ETH", full: "Ethereum", dcxPair: "B-ETH_INR", color: "#627eea", bg: "#f0f2ff", icon: "Ξ" },
  { symbol: "SOLINR", label: "SOL", full: "Solana",   dcxPair: "B-SOL_INR", color: "#9945ff", bg: "#f8f0ff", icon: "◎" },
];
const EMA_FAST = 9;
const EMA_SLOW = 21;
const TICK_MS  = 8000;
const STORAGE_KEY = "cryptoedge_v2";

// ─── EMA ──────────────────────────────────────────────────────────────────────
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}
function getSignal(prices) {
  if (prices.length < EMA_SLOW + 2) return null;
  const fast = calcEMA(prices, EMA_FAST), slow = calcEMA(prices, EMA_SLOW);
  const fastP = calcEMA(prices.slice(0, -1), EMA_FAST), slowP = calcEMA(prices.slice(0, -1), EMA_SLOW);
  if (!fast || !slow || !fastP || !slowP) return null;
  if (fastP <= slowP && fast > slow) return "BUY";
  if (fastP >= slowP && fast < slow) return "SELL";
  return null;
}

// ─── Storage ──────────────────────────────────────────────────────────────────
const load = () => { try { const s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch { return null; } };
const save = (s) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {} };

function freshState(capital) {
  return { capital: Number(capital), startCapital: Number(capital), positions: {}, trades: [], realizedPnl: 0 };
}
function initState() {
  const s = load();
  return s || freshState(1000);
}

// ─── Formatters ───────────────────────────────────────────────────────────────
const fmt  = (n, d = 2) => n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtSign = (n) => (n >= 0 ? "+" : "") + fmt(n);
const ts = () => new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ─── App ──────────────────────────────────────────────────────────────────────
export default function CryptoEdge() {
  const [state, setState]       = useState(initState);
  const [prices, setPrices]     = useState({});
  const [prevPrices, setPrev]   = useState({});
  const [history, setHistory]   = useState({});
  const [emas, setEmas]         = useState({});
  const [logs, setLogs]         = useState([]);
  const [tab, setTab]           = useState("dashboard");
  const [liveStatus, setLive]   = useState("connecting");
  const [capitalInput, setCapInput] = useState("");
  const [showCapModal, setShowCap]  = useState(false);
  const [flashPnl, setFlashPnl]     = useState(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => { save(state); }, [state]);

  const addLog = useCallback((msg, type = "info") => {
    setLogs(p => [{ msg, type, time: ts() }, ...p].slice(0, 100));
  }, []);

  // ─── Fetch ────────────────────────────────────────────────────────────────
  const fetchPrices = useCallback(async () => {
    try {
      const res = await fetch("https://api.coindcx.com/exchange/ticker");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const map = {};
      data.forEach(t => { map[t.market] = parseFloat(t.last_price); });

      const newP = {};
      PAIRS.forEach(p => { if (map[p.dcxPair]) newP[p.symbol] = map[p.dcxPair]; });

      setPrev(prev => ({ ...prev, ...prices }));
      setPrices(pp => ({ ...pp, ...newP }));
      setHistory(prev => {
        const next = { ...prev };
        PAIRS.forEach(p => {
          if (newP[p.symbol]) {
            next[p.symbol] = [...(prev[p.symbol] || []), newP[p.symbol]].slice(-80);
          }
        });
        return next;
      });
      setLive("live");
    } catch {
      setLive("error");
    }
  }, [prices]);

  useEffect(() => { fetchPrices(); const id = setInterval(fetchPrices, TICK_MS); return () => clearInterval(id); }, [fetchPrices]);

  // ─── Signal Engine ────────────────────────────────────────────────────────
  useEffect(() => {
    const newEmas = {};
    PAIRS.forEach(p => {
      const h = history[p.symbol] || [];
      newEmas[p.symbol] = { fast: calcEMA(h, EMA_FAST), slow: calcEMA(h, EMA_SLOW), ticks: h.length };
      const signal = getSignal(h);
      if (!signal) return;
      const price = prices[p.symbol];
      if (!price) return;
      const cur = stateRef.current;
      const pos = cur.positions[p.symbol];

      if (pos && pos.side !== signal) {
        const pnl = (signal === "SELL" ? price - pos.entryPrice : pos.entryPrice - price) * pos.qty;
        const recovered = pos.qty * pos.entryPrice + pnl;
        setState(s => ({
          ...s,
          capital: s.capital + recovered,
          realizedPnl: s.realizedPnl + pnl,
          positions: Object.fromEntries(Object.entries(s.positions).filter(([k]) => k !== p.symbol)),
          trades: [{ symbol: p.symbol, side: "EXIT", price, qty: pos.qty, pnl, time: ts() }, ...s.trades].slice(0, 60),
        }));
        setFlashPnl({ val: pnl, label: p.label });
        setTimeout(() => setFlashPnl(null), 2500);
        addLog(`EXIT ${p.label} @ ₹${fmt(price, 0)} | P&L: ${fmtSign(pnl)}`, pnl >= 0 ? "profit" : "loss");
        return;
      }
      if (!pos) {
        const cap = stateRef.current.capital;
        const usable = cap * 0.9;
        if (usable < 1) { addLog("Insufficient capital", "warn"); return; }
        const qty = usable / price;
        setState(s => ({
          ...s,
          capital: s.capital - qty * price,
          positions: { ...s.positions, [p.symbol]: { entryPrice: price, qty, side: signal } },
          trades: [{ symbol: p.symbol, side: signal, price, qty, pnl: null, time: ts() }, ...s.trades].slice(0, 60),
        }));
        addLog(`${signal} ${p.label} @ ₹${fmt(price, 0)}`, "entry");
      }
    });
    setEmas(newEmas);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history]);

  // ─── Derived ──────────────────────────────────────────────────────────────
  const unrealized = Object.entries(state.positions).reduce((sum, [sym, pos]) => {
    const p = prices[sym];
    if (!p) return sum;
    return sum + (pos.side === "BUY" ? p - pos.entryPrice : pos.entryPrice - p) * pos.qty;
  }, 0);
  const posValue = Object.entries(state.positions).reduce((sum, [sym, pos]) => sum + (prices[sym] || pos.entryPrice) * pos.qty, 0);
  const totalValue = state.capital + posValue;
  const totalPnl = state.realizedPnl + unrealized;
  const totalPct = state.startCapital > 0 ? ((totalValue - state.startCapital) / state.startCapital * 100) : 0;

  const handleSetCapital = () => {
    const val = parseFloat(capitalInput);
    if (!val || val < 1) return;
    const ns = freshState(val);
    setState(ns);
    setLogs([]);
    setShowCap(false);
    setCapInput("");
    addLog(`Capital set to ₹${fmt(val)}`, "info");
  };

  const handleReset = () => {
    if (!window.confirm("Reset all data?")) return;
    const ns = freshState(state.startCapital);
    setState(ns);
    setLogs([]);
    addLog("Reset complete.", "info");
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>
      <style>{CSS}</style>

      {/* Flash PnL Toast */}
      {flashPnl && (
        <div style={{ ...S.toast, background: flashPnl.val >= 0 ? "#e8faf2" : "#fff0f3", borderColor: flashPnl.val >= 0 ? "#22c55e" : "#ef4444", color: flashPnl.val >= 0 ? "#16a34a" : "#dc2626" }}>
          {flashPnl.val >= 0 ? "🎉" : "📉"} {flashPnl.label} closed &nbsp;<strong>{fmtSign(flashPnl.val)}</strong>
        </div>
      )}

      {/* Capital Modal */}
      {showCapModal && (
        <div style={S.overlay} onClick={() => setShowCap(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalTitle}>Set Capital</div>
            <div style={S.modalSub}>All current positions will be closed and data reset.</div>
            <input
              style={S.modalInput}
              type="number"
              placeholder="Enter amount (₹)"
              value={capitalInput}
              onChange={e => setCapInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSetCapital()}
              autoFocus
            />
            <div style={S.modalActions}>
              <button style={S.btnGhost} onClick={() => setShowCap(false)}>Cancel</button>
              <button style={S.btnPrimary} onClick={handleSetCapital}>Set Capital</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header style={S.header}>
        <div style={S.logo}>
          <div style={S.logoIcon}>₿</div>
          <div>
            <div style={S.logoName}>CryptoEdge <span style={S.logoAi}>AI</span></div>
            <div style={S.logoPaper}>Paper Trading · CoinDCX</div>
          </div>
        </div>
        <div style={S.headerRight}>
          <div style={{ ...S.liveDot, background: liveStatus === "live" ? "#22c55e" : liveStatus === "error" ? "#ef4444" : "#f59e0b" }} className="blink" />
          <span style={S.liveLabel}>{liveStatus === "live" ? "Live" : liveStatus === "error" ? "Error" : "…"}</span>
        </div>
      </header>

      {/* Summary Strip */}
      <div style={S.strip}>
        <StripCard label="Portfolio" value={`₹${fmt(totalValue)}`} sub={`${fmtSign(totalPct)}%`} subColor={totalPct >= 0 ? "#16a34a" : "#dc2626"} color="#6366f1" />
        <StripCard label="Realized P&L" value={`₹${fmtSign(state.realizedPnl)}`} color={state.realizedPnl >= 0 ? "#16a34a" : "#dc2626"} />
        <StripCard label="Unrealized" value={`₹${fmtSign(unrealized)}`} color={unrealized >= 0 ? "#0891b2" : "#ea580c"} />
        <StripCard label="Free Cash" value={`₹${fmt(state.capital)}`} color="#7c3aed" />
      </div>

      {/* Tabs */}
      <nav style={S.nav}>
        {["dashboard", "positions", "trades", "logs"].map(t => (
          <button key={t} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }} onClick={() => setTab(t)}>
            {{ dashboard: "📊", positions: "📂", trades: "📋", logs: "🔔" }[t]} {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      <main style={S.main}>

        {/* ── DASHBOARD ── */}
        {tab === "dashboard" && (
          <div>
            <div style={S.pairGrid}>
              {PAIRS.map(p => {
                const price  = prices[p.symbol];
                const prev   = prevPrices[p.symbol];
                const up     = price && prev ? price > prev : null;
                const pos    = state.positions[p.symbol];
                const em     = emas[p.symbol] || {};
                const trend  = em.fast && em.slow ? (em.fast > em.slow ? "▲ Bullish" : "▼ Bearish") : "Warming up…";
                const tColor = em.fast && em.slow ? (em.fast > em.slow ? "#16a34a" : "#dc2626") : "#94a3b8";
                const warmup = Math.min(100, ((em.ticks || 0) / EMA_SLOW) * 100);
                const upnl   = pos && price ? (pos.side === "BUY" ? price - pos.entryPrice : pos.entryPrice - price) * pos.qty : null;
                return (
                  <div key={p.symbol} style={{ ...S.pairCard, borderTop: `4px solid ${p.color}` }} className="card-hover">
                    <div style={S.pairTop}>
                      <div style={{ ...S.pairIcon, background: p.bg, color: p.color }}>{p.icon}</div>
                      <div>
                        <div style={S.pairName}>{p.full}</div>
                        <div style={S.pairSymbol}>{p.label}/INR</div>
                      </div>
                      {pos && (
                        <div style={{ ...S.posBadge, background: pos.side === "BUY" ? "#dcfce7" : "#fee2e2", color: pos.side === "BUY" ? "#16a34a" : "#dc2626" }}>
                          {pos.side}
                        </div>
                      )}
                    </div>
                    <div style={{ ...S.pairPrice, color: up === true ? "#16a34a" : up === false ? "#dc2626" : "#1e293b" }} className={up != null ? (up ? "flash-green" : "flash-red") : ""}>
                      ₹{price ? fmt(price, 0) : "—"}
                    </div>
                    <div style={{ color: tColor, fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{trend}</div>
                    <div style={S.emaRow}>
                      <span style={{ ...S.emaChip, background: "#eff6ff", color: "#3b82f6" }}>EMA{EMA_FAST}: {em.fast ? fmt(em.fast, 0) : "—"}</span>
                      <span style={{ ...S.emaChip, background: "#fdf4ff", color: "#a855f7" }}>EMA{EMA_SLOW}: {em.slow ? fmt(em.slow, 0) : "—"}</span>
                    </div>
                    {pos && upnl != null && (
                      <div style={{ ...S.upnlRow, color: upnl >= 0 ? "#16a34a" : "#dc2626" }}>
                        Unrealized: {fmtSign(upnl)}
                      </div>
                    )}
                    <div style={S.warmupTrack}>
                      <div style={{ ...S.warmupBar, width: `${warmup}%`, background: warmup >= 100 ? p.color : "#94a3b8" }} />
                    </div>
                    <div style={S.warmupLabel}>{warmup >= 100 ? "✓ Signals active" : `${em.ticks || 0}/${EMA_SLOW} ticks to signal`}</div>
                  </div>
                );
              })}
            </div>

            {/* Capital Controls */}
            <div style={S.controlRow}>
              <div style={S.capInfo}>
                <span style={S.capLabel}>Starting Capital</span>
                <span style={S.capValue}>₹{fmt(state.startCapital)}</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={S.btnOutline} onClick={() => setShowCap(true)}>✏️ Change Capital</button>
                <button style={S.btnDanger} onClick={handleReset}>🔄 Reset</button>
              </div>
            </div>
          </div>
        )}

        {/* ── POSITIONS ── */}
        {tab === "positions" && (
          <div>
            <div style={S.secTitle}>Open Positions ({Object.keys(state.positions).length})</div>
            {Object.keys(state.positions).length === 0
              ? <Empty text="No open positions — waiting for EMA crossover signals" />
              : Object.entries(state.positions).map(([sym, pos]) => {
                const pair  = PAIRS.find(p => p.symbol === sym);
                const price = prices[sym] || pos.entryPrice;
                const upnl  = (pos.side === "BUY" ? price - pos.entryPrice : pos.entryPrice - price) * pos.qty;
                const pct   = (upnl / (pos.entryPrice * pos.qty)) * 100;
                return (
                  <div key={sym} style={{ ...S.posCard2, borderLeft: `4px solid ${pair?.color || "#6366f1"}` }}>
                    <div style={S.posHead}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ ...S.pairIcon, background: pair?.bg, color: pair?.color, width: 36, height: 36, fontSize: 16 }}>{pair?.icon}</span>
                        <div>
                          <div style={{ fontWeight: 700, color: "#1e293b" }}>{pair?.full || sym}</div>
                          <div style={{ fontSize: 11, color: "#64748b" }}>{pair?.label}/INR</div>
                        </div>
                      </div>
                      <div style={{ ...S.posBadge, background: pos.side === "BUY" ? "#dcfce7" : "#fee2e2", color: pos.side === "BUY" ? "#16a34a" : "#dc2626", fontSize: 13, padding: "4px 14px" }}>
                        {pos.side}
                      </div>
                    </div>
                    <div style={S.posGrid}>
                      <Kv label="Entry Price" val={`₹${fmt(pos.entryPrice, 0)}`} />
                      <Kv label="Current Price" val={`₹${fmt(price, 0)}`} />
                      <Kv label="Quantity" val={pos.qty.toFixed(6)} />
                      <Kv label="Invested" val={`₹${fmt(pos.qty * pos.entryPrice)}`} />
                      <Kv label="Current Value" val={`₹${fmt(pos.qty * price)}`} />
                      <Kv label="Unrealized P&L" val={`${fmtSign(upnl)} (${fmtSign(pct)}%)`} color={upnl >= 0 ? "#16a34a" : "#dc2626"} />
                    </div>
                  </div>
                );
              })
            }
          </div>
        )}

        {/* ── TRADES ── */}
        {tab === "trades" && (
          <div>
            <div style={S.secTitle}>Trade History ({state.trades.length})</div>
            {state.trades.length === 0
              ? <Empty text="No trades executed yet" />
              : state.trades.map((t, i) => {
                const pair = PAIRS.find(p => p.symbol === t.symbol);
                const isExit = t.side === "EXIT";
                const win = isExit && t.pnl >= 0;
                return (
                  <div key={i} style={{ ...S.tradeCard, borderLeft: `4px solid ${isExit ? (win ? "#22c55e" : "#ef4444") : (pair?.color || "#6366f1")}` }}>
                    <div style={S.tradeLeft}>
                      <span style={{ fontSize: 18 }}>{pair?.icon}</span>
                      <div>
                        <div style={{ fontWeight: 600, color: "#1e293b", fontSize: 13 }}>{pair?.label}/INR</div>
                        <div style={{ fontSize: 11, color: "#94a3b8" }}>{t.time}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ ...S.tradeBadge, background: t.side === "BUY" ? "#dbeafe" : isExit ? (win ? "#dcfce7" : "#fee2e2") : "#fce7f3", color: t.side === "BUY" ? "#2563eb" : isExit ? (win ? "#16a34a" : "#dc2626") : "#db2777" }}>
                        {t.side}
                      </div>
                      <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>₹{fmt(t.price, 0)}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {t.pnl != null
                        ? <div style={{ fontWeight: 700, color: t.pnl >= 0 ? "#16a34a" : "#dc2626" }}>{fmtSign(t.pnl)}</div>
                        : <div style={{ color: "#94a3b8", fontSize: 12 }}>Open</div>
                      }
                      <div style={{ fontSize: 11, color: "#94a3b8" }}>qty: {t.qty.toFixed(4)}</div>
                    </div>
                  </div>
                );
              })
            }
          </div>
        )}

        {/* ── LOGS ── */}
        {tab === "logs" && (
          <div>
            <div style={S.secTitle}>System Logs</div>
            {logs.length === 0
              ? <Empty text="Logs will appear here as signals fire" />
              : logs.map((l, i) => (
                <div key={i} style={{ ...S.logRow, borderLeft: `3px solid ${LOG_C[l.type] || "#94a3b8"}` }}>
                  <span style={S.logTime}>{l.time}</span>
                  <span style={{ color: LOG_C[l.type] || "#475569", flex: 1 }}>{l.msg}</span>
                </div>
              ))
            }
          </div>
        )}
      </main>

      <footer style={S.footer}>
        <span>EMA {EMA_FAST}/{EMA_SLOW} Strategy · Auto-refresh {TICK_MS / 1000}s · Paper Only</span>
      </footer>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function StripCard({ label, value, sub, color, subColor }) {
  return (
    <div style={S.stripCard}>
      <div style={S.stripLabel}>{label}</div>
      <div style={{ ...S.stripValue, color }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: subColor || "#64748b", fontWeight: 600 }}>{sub}</div>}
    </div>
  );
}
function Kv({ label, val, color }) {
  return (
    <div style={S.kvBox}>
      <div style={S.kvLabel}>{label}</div>
      <div style={{ ...S.kvVal, color: color || "#1e293b" }}>{val}</div>
    </div>
  );
}
function Empty({ text }) {
  return <div style={S.empty}><div style={S.emptyIcon}>📭</div><div>{text}</div></div>;
}

const LOG_C = { info: "#6366f1", entry: "#0891b2", profit: "#16a34a", loss: "#dc2626", warn: "#f59e0b", error: "#ef4444" };

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  root: { minHeight: "100vh", background: "linear-gradient(135deg, #f0f9ff 0%, #faf5ff 50%, #fff7ed 100%)", fontFamily: "'Nunito', 'Segoe UI', sans-serif", display: "flex", flexDirection: "column", maxWidth: 480, margin: "0 auto", position: "relative" },
  header: { background: "white", padding: "16px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 2px 12px #6366f120", position: "sticky", top: 0, zIndex: 10 },
  logo: { display: "flex", alignItems: "center", gap: 12 },
  logoIcon: { width: 40, height: 40, borderRadius: 12, background: "linear-gradient(135deg, #6366f1, #a855f7)", color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 700, boxShadow: "0 4px 12px #6366f140" },
  logoName: { fontSize: 18, fontWeight: 800, color: "#1e293b", lineHeight: 1.2 },
  logoAi: { background: "linear-gradient(90deg, #6366f1, #a855f7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" },
  logoPaper: { fontSize: 10, color: "#94a3b8", letterSpacing: "0.05em" },
  headerRight: { display: "flex", alignItems: "center", gap: 6 },
  liveDot: { width: 8, height: 8, borderRadius: "50%" },
  liveLabel: { fontSize: 11, color: "#64748b", fontWeight: 600 },
  strip: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "12px", background: "white", borderBottom: "1px solid #f1f5f9" },
  stripCard: { background: "#fafbff", borderRadius: 10, padding: "10px 12px", border: "1px solid #e2e8f0" },
  stripLabel: { fontSize: 9, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 },
  stripValue: { fontSize: 16, fontWeight: 800, lineHeight: 1 },
  nav: { display: "flex", background: "white", borderBottom: "2px solid #f1f5f9", position: "sticky", top: 73, zIndex: 9 },
  tab: { flex: 1, padding: "11px 4px", background: "transparent", border: "none", borderBottom: "3px solid transparent", color: "#94a3b8", cursor: "pointer", fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", transition: "all 0.2s", fontFamily: "inherit" },
  tabActive: { color: "#6366f1", borderBottom: "3px solid #6366f1", background: "#fafbff" },
  main: { flex: 1, padding: "16px 12px", overflowY: "auto" },
  pairGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 },
  pairCard: { background: "white", borderRadius: 14, padding: "14px", boxShadow: "0 2px 16px #0000000a", border: "1px solid #f1f5f9" },
  pairTop: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 },
  pairIcon: { width: 34, height: 34, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, flexShrink: 0 },
  pairName: { fontSize: 12, fontWeight: 700, color: "#1e293b", lineHeight: 1.2 },
  pairSymbol: { fontSize: 9, color: "#94a3b8" },
  posBadge: { marginLeft: "auto", fontSize: 9, fontWeight: 800, padding: "2px 8px", borderRadius: 6, letterSpacing: "0.06em" },
  pairPrice: { fontSize: 20, fontWeight: 800, marginBottom: 4, transition: "color 0.3s" },
  emaRow: { display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" },
  emaChip: { fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 5 },
  upnlRow: { fontSize: 11, fontWeight: 700, marginBottom: 6 },
  warmupTrack: { height: 4, background: "#f1f5f9", borderRadius: 2, overflow: "hidden", marginBottom: 4 },
  warmupBar: { height: "100%", borderRadius: 2, transition: "width 0.6s ease" },
  warmupLabel: { fontSize: 9, color: "#94a3b8" },
  controlRow: { background: "white", borderRadius: 14, padding: "14px", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 2px 10px #0000000a", flexWrap: "wrap", gap: 8 },
  capInfo: { display: "flex", flexDirection: "column" },
  capLabel: { fontSize: 10, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em" },
  capValue: { fontSize: 18, fontWeight: 800, color: "#6366f1" },
  btnOutline: { fontSize: 11, fontWeight: 700, padding: "7px 12px", borderRadius: 8, border: "2px solid #6366f1", color: "#6366f1", background: "transparent", cursor: "pointer", fontFamily: "inherit" },
  btnDanger: { fontSize: 11, fontWeight: 700, padding: "7px 12px", borderRadius: 8, border: "2px solid #ef4444", color: "#ef4444", background: "transparent", cursor: "pointer", fontFamily: "inherit" },
  btnPrimary: { fontSize: 13, fontWeight: 700, padding: "10px 20px", borderRadius: 10, border: "none", background: "linear-gradient(135deg, #6366f1, #a855f7)", color: "white", cursor: "pointer", fontFamily: "inherit", boxShadow: "0 4px 12px #6366f140" },
  btnGhost: { fontSize: 13, fontWeight: 600, padding: "10px 20px", borderRadius: 10, border: "2px solid #e2e8f0", color: "#64748b", background: "white", cursor: "pointer", fontFamily: "inherit" },
  secTitle: { fontSize: 12, fontWeight: 800, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 },
  posCard2: { background: "white", borderRadius: 14, padding: "14px", marginBottom: 10, boxShadow: "0 2px 10px #0000000a" },
  posHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  posGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  kvBox: { background: "#f8fafc", borderRadius: 8, padding: "8px 10px" },
  kvLabel: { fontSize: 9, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 },
  kvVal: { fontSize: 12, fontWeight: 700 },
  tradeCard: { background: "white", borderRadius: 12, padding: "12px 14px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 2px 8px #0000000a" },
  tradeLeft: { display: "flex", alignItems: "center", gap: 10 },
  tradeBadge: { fontSize: 10, fontWeight: 800, padding: "3px 10px", borderRadius: 6, letterSpacing: "0.06em" },
  logRow: { background: "white", borderRadius: 8, padding: "8px 12px", marginBottom: 6, display: "flex", gap: 10, alignItems: "flex-start" },
  logTime: { fontSize: 10, color: "#94a3b8", minWidth: 65, paddingTop: 1 },
  empty: { textAlign: "center", padding: "48px 20px", color: "#94a3b8", fontSize: 13 },
  emptyIcon: { fontSize: 36, marginBottom: 10 },
  footer: { padding: "10px 18px", textAlign: "center", fontSize: 10, color: "#94a3b8", background: "white", borderTop: "1px solid #f1f5f9" },
  toast: { position: "fixed", top: 14, left: "50%", transform: "translateX(-50%)", background: "white", border: "2px solid", borderRadius: 12, padding: "10px 20px", fontSize: 13, fontWeight: 600, zIndex: 100, boxShadow: "0 8px 24px #00000015", whiteSpace: "nowrap" },
  overlay: { position: "fixed", inset: 0, background: "#00000040", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
  modal: { background: "white", borderRadius: 18, padding: 24, width: "100%", maxWidth: 320, boxShadow: "0 20px 60px #00000020" },
  modalTitle: { fontSize: 20, fontWeight: 800, color: "#1e293b", marginBottom: 6 },
  modalSub: { fontSize: 12, color: "#94a3b8", marginBottom: 16 },
  modalInput: { width: "100%", padding: "12px 14px", borderRadius: 10, border: "2px solid #e2e8f0", fontSize: 16, fontFamily: "inherit", outline: "none", marginBottom: 16, boxSizing: "border-box" },
  modalActions: { display: "flex", gap: 10 },
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #f0f9ff; }
  .card-hover { transition: transform 0.15s, box-shadow 0.15s; }
  .card-hover:hover { transform: translateY(-2px); box-shadow: 0 8px 24px #00000012 !important; }
  .blink { animation: blink 2s infinite; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.4} }
  .flash-green { animation: fg 0.4s ease; }
  .flash-red   { animation: fr 0.4s ease; }
  @keyframes fg { 0%{background:#dcfce7} 100%{background:transparent} }
  @keyframes fr { 0%{background:#fee2e2} 100%{background:transparent} }
  input:focus { border-color: #6366f1 !important; }
  button:active { opacity: 0.85; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }
`;
