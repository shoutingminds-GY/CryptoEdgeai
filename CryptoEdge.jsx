import { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const PAIRS = [
  { symbol: "BTCINR", label: "BTC/INR", dcxPair: "B-BTC_INR" },
  { symbol: "ETHINR", label: "ETH/INR", dcxPair: "B-ETH_INR" },
];
const INITIAL_CAPITAL = 1000;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const TICK_INTERVAL = 8000; // 8 seconds
const STORAGE_KEY = "cryptoedge_v1";

// ─── EMA Calculation ──────────────────────────────────────────────────────────
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function getSignal(prices) {
  if (prices.length < EMA_SLOW + 2) return null;
  const fast = calcEMA(prices, EMA_FAST);
  const slowNow = calcEMA(prices, EMA_SLOW);
  const fastPrev = calcEMA(prices.slice(0, -1), EMA_FAST);
  const slowPrev = calcEMA(prices.slice(0, -1), EMA_SLOW);
  if (!fast || !slowNow || !fastPrev || !slowPrev) return null;
  if (fastPrev <= slowPrev && fast > slowNow) return "BUY";
  if (fastPrev >= slowPrev && fast < slowNow) return "SELL";
  return null;
}

// ─── Storage ──────────────────────────────────────────────────────────────────
function loadState() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}
function saveState(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

// ─── Initial State ────────────────────────────────────────────────────────────
function initState() {
  const saved = loadState();
  if (saved) return saved;
  return {
    capital: INITIAL_CAPITAL,
    positions: {},   // { symbol: { entryPrice, qty, side } }
    trades: [],
    pnl: 0,
  };
}

// ─── Formatters ───────────────────────────────────────────────────────────────
const fmt = (n, d = 2) => n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtPnl = (n) => (n >= 0 ? "+" : "") + fmt(n);
const timeStr = () => new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function CryptoEdge() {
  const [state, setState] = useState(initState);
  const [prices, setPrices] = useState({});         // { symbol: number }
  const [history, setHistory] = useState({});       // { symbol: number[] }
  const [logs, setLogs] = useState([]);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [status, setStatus] = useState("Connecting…");
  const [fastEMA, setFastEMA] = useState({});
  const [slowEMA, setSlowEMA] = useState({});
  const stateRef = useRef(state);
  stateRef.current = state;

  // ─── Persist ────────────────────────────────────────────────────────────────
  useEffect(() => { saveState(state); }, [state]);

  // ─── Log helper ─────────────────────────────────────────────────────────────
  const addLog = useCallback((msg, type = "info") => {
    setLogs(prev => [{ msg, type, time: timeStr() }, ...prev].slice(0, 80));
  }, []);

  // ─── Fetch Prices ────────────────────────────────────────────────────────────
  const fetchPrices = useCallback(async () => {
    try {
      const res = await fetch("https://api.coindcx.com/exchange/ticker");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const map = {};
      data.forEach(t => { map[t.market] = parseFloat(t.last_price); });

      const newPrices = {};
      PAIRS.forEach(p => {
        const price = map[p.dcxPair];
        if (price) newPrices[p.symbol] = price;
      });

      setPrices(prev => ({ ...prev, ...newPrices }));
      setHistory(prev => {
        const next = { ...prev };
        PAIRS.forEach(p => {
          if (newPrices[p.symbol]) {
            const arr = [...(prev[p.symbol] || []), newPrices[p.symbol]];
            next[p.symbol] = arr.slice(-60); // keep last 60 ticks
          }
        });
        return next;
      });
      setStatus("Live ●");
    } catch (e) {
      setStatus("Error — retrying");
      addLog("Price fetch failed: " + e.message, "error");
    }
  }, [addLog]);

  // ─── Signal Engine ────────────────────────────────────────────────────────────
  useEffect(() => {
    const newFast = {};
    const newSlow = {};
    PAIRS.forEach(p => {
      const h = history[p.symbol] || [];
      newFast[p.symbol] = calcEMA(h, EMA_FAST);
      newSlow[p.symbol] = calcEMA(h, EMA_SLOW);

      const signal = getSignal(h);
      if (!signal) return;

      const cur = stateRef.current;
      const price = prices[p.symbol];
      if (!price) return;

      const pos = cur.positions[p.symbol];

      // Exit existing position if opposite signal
      if (pos && pos.side !== signal) {
        const pnlTrade = (signal === "SELL")
          ? (price - pos.entryPrice) * pos.qty
          : (pos.entryPrice - price) * pos.qty;
        const recovered = pos.qty * pos.entryPrice + pnlTrade;
        setState(s => ({
          ...s,
          capital: s.capital + recovered,
          pnl: s.pnl + pnlTrade,
          positions: Object.fromEntries(Object.entries(s.positions).filter(([k]) => k !== p.symbol)),
          trades: [{
            symbol: p.symbol, side: "EXIT", price, qty: pos.qty,
            pnl: pnlTrade, time: timeStr()
          }, ...s.trades].slice(0, 50),
        }));
        addLog(`EXIT ${p.label} @ ₹${fmt(price)} | PnL: ${fmtPnl(pnlTrade)}`, pnlTrade >= 0 ? "profit" : "loss");
        return;
      }

      // Enter new position
      if (!pos && signal) {
        const cap = stateRef.current.capital;
        const usable = cap * 0.95; // use 95% of capital per trade
        if (usable < 10) { addLog("Insufficient capital", "warn"); return; }
        const qty = usable / price;
        setState(s => ({
          ...s,
          capital: s.capital - qty * price,
          positions: { ...s.positions, [p.symbol]: { entryPrice: price, qty, side: signal } },
          trades: [{
            symbol: p.symbol, side: signal, price, qty, pnl: null, time: timeStr()
          }, ...s.trades].slice(0, 50),
        }));
        addLog(`${signal} ${p.label} @ ₹${fmt(price)} | Qty: ${qty.toFixed(6)}`, "entry");
      }
    });
    setFastEMA(newFast);
    setSlowEMA(newSlow);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history]);

  // ─── Tick Loop ────────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchPrices();
    const id = setInterval(fetchPrices, TICK_INTERVAL);
    return () => clearInterval(id);
  }, [fetchPrices]);

  // ─── Derived ─────────────────────────────────────────────────────────────────
  const unrealized = Object.entries(state.positions).reduce((sum, [sym, pos]) => {
    const p = prices[sym];
    if (!p) return sum;
    return sum + (pos.side === "BUY" ? (p - pos.entryPrice) : (pos.entryPrice - p)) * pos.qty;
  }, 0);
  const totalValue = state.capital + Object.entries(state.positions).reduce((sum, [sym, pos]) => {
    return sum + (prices[sym] || pos.entryPrice) * pos.qty;
  }, 0);
  const totalPnl = state.pnl + unrealized;

  // ─── Reset ───────────────────────────────────────────────────────────────────
  const handleReset = () => {
    if (!window.confirm("Reset all paper trading data?")) return;
    const fresh = initState();
    const reset = { capital: INITIAL_CAPITAL, positions: {}, trades: [], pnl: 0 };
    setState(reset);
    setLogs([]);
    saveState(reset);
    addLog("Paper trading reset.", "info");
  };

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>
      <style>{CSS}</style>

      {/* Header */}
      <header style={S.header}>
        <div style={S.logo}>
          <span style={S.logoMark}>◈</span>
          <span style={S.logoText}>CryptoEdge <span style={S.logoSub}>AI</span></span>
        </div>
        <div style={S.statusPill} className={status.startsWith("Live") ? "pulse" : ""}>
          {status}
        </div>
      </header>

      {/* Tabs */}
      <nav style={S.nav}>
        {["dashboard", "positions", "trades", "logs"].map(t => (
          <button key={t} style={{ ...S.tab, ...(activeTab === t ? S.tabActive : {}) }}
            onClick={() => setActiveTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      <main style={S.main}>

        {/* ── DASHBOARD ── */}
        {activeTab === "dashboard" && (
          <div>
            {/* Summary Cards */}
            <div style={S.cards}>
              <Card label="Portfolio Value" value={`₹${fmt(totalValue)}`} sub={`Started ₹${fmt(INITIAL_CAPITAL)}`} />
              <Card label="Realized P&L" value={`₹${fmtPnl(state.pnl)}`} color={state.pnl >= 0 ? "#00e5a0" : "#ff4e6a"} />
              <Card label="Unrealized P&L" value={`₹${fmtPnl(unrealized)}`} color={unrealized >= 0 ? "#00e5a0" : "#ff4e6a"} />
              <Card label="Free Capital" value={`₹${fmt(state.capital)}`} />
            </div>

            {/* Live Pairs */}
            <div style={S.section}>
              <div style={S.sectionTitle}>Live Markets</div>
              <div style={S.pairGrid}>
                {PAIRS.map(p => {
                  const price = prices[p.symbol];
                  const pos = state.positions[p.symbol];
                  const fast = fastEMA[p.symbol];
                  const slow = slowEMA[p.symbol];
                  const trend = fast && slow ? (fast > slow ? "▲ Bullish" : "▼ Bearish") : "—";
                  const trendColor = fast && slow ? (fast > slow ? "#00e5a0" : "#ff4e6a") : "#888";
                  return (
                    <div key={p.symbol} style={S.pairCard}>
                      <div style={S.pairHeader}>
                        <span style={S.pairLabel}>{p.label}</span>
                        {pos && <span style={{ ...S.badge, background: pos.side === "BUY" ? "#00e5a020" : "#ff4e6a20", color: pos.side === "BUY" ? "#00e5a0" : "#ff4e6a", border: `1px solid ${pos.side === "BUY" ? "#00e5a0" : "#ff4e6a"}` }}>{pos.side}</span>}
                      </div>
                      <div style={S.pairPrice}>{price ? `₹${fmt(price, 0)}` : "—"}</div>
                      <div style={{ ...S.pairTrend, color: trendColor }}>{trend}</div>
                      <div style={S.pairEma}>
                        <span>EMA{EMA_FAST}: {fast ? fmt(fast, 0) : "—"}</span>
                        <span>EMA{EMA_SLOW}: {slow ? fmt(slow, 0) : "—"}</span>
                      </div>
                      <div style={S.pairBar}>
                        <div style={{ ...S.pairBarInner, width: `${Math.min(100, (history[p.symbol]?.length || 0) / EMA_SLOW * 100)}%` }} />
                      </div>
                      <div style={S.pairBarLabel}>
                        {history[p.symbol]?.length || 0}/{EMA_SLOW} ticks for signal
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── POSITIONS ── */}
        {activeTab === "positions" && (
          <div style={S.section}>
            <div style={S.sectionTitle}>Open Positions</div>
            {Object.keys(state.positions).length === 0
              ? <div style={S.empty}>No open positions</div>
              : Object.entries(state.positions).map(([sym, pos]) => {
                const price = prices[sym] || pos.entryPrice;
                const upnl = (pos.side === "BUY" ? price - pos.entryPrice : pos.entryPrice - price) * pos.qty;
                const upnlPct = (upnl / (pos.entryPrice * pos.qty)) * 100;
                return (
                  <div key={sym} style={S.posCard}>
                    <div style={S.posTop}>
                      <span style={S.posLabel}>{PAIRS.find(p => p.symbol === sym)?.label || sym}</span>
                      <span style={{ color: pos.side === "BUY" ? "#00e5a0" : "#ff4e6a", fontWeight: 700 }}>{pos.side}</span>
                    </div>
                    <div style={S.posRow}>
                      <Kv label="Entry" val={`₹${fmt(pos.entryPrice, 0)}`} />
                      <Kv label="Current" val={`₹${fmt(price, 0)}`} />
                      <Kv label="Qty" val={pos.qty.toFixed(6)} />
                      <Kv label="Unrealized" val={`${fmtPnl(upnl)} (${fmtPnl(upnlPct)}%)`} color={upnl >= 0 ? "#00e5a0" : "#ff4e6a"} />
                    </div>
                  </div>
                );
              })}
          </div>
        )}

        {/* ── TRADES ── */}
        {activeTab === "trades" && (
          <div style={S.section}>
            <div style={S.sectionTitle}>Trade History</div>
            {state.trades.length === 0
              ? <div style={S.empty}>No trades yet</div>
              : <div style={S.tradeList}>
                {state.trades.map((t, i) => (
                  <div key={i} style={S.tradeRow}>
                    <span style={S.tradeTime}>{t.time}</span>
                    <span style={{ ...S.tradeSide, color: t.side === "BUY" || t.side === "EXIT" && t.pnl >= 0 ? "#00e5a0" : "#ff4e6a" }}>{t.side}</span>
                    <span style={S.tradePair}>{PAIRS.find(p => p.symbol === t.symbol)?.label || t.symbol}</span>
                    <span style={S.tradePrice}>₹{fmt(t.price, 0)}</span>
                    <span style={{ ...S.tradePnl, color: t.pnl == null ? "#888" : t.pnl >= 0 ? "#00e5a0" : "#ff4e6a" }}>
                      {t.pnl == null ? "Open" : `₹${fmtPnl(t.pnl)}`}
                    </span>
                  </div>
                ))}
              </div>
            }
          </div>
        )}

        {/* ── LOGS ── */}
        {activeTab === "logs" && (
          <div style={S.section}>
            <div style={S.sectionTitle}>System Logs</div>
            {logs.length === 0
              ? <div style={S.empty}>No logs yet</div>
              : <div style={S.logList}>
                {logs.map((l, i) => (
                  <div key={i} style={{ ...S.logRow, color: LOG_COLORS[l.type] || "#aaa" }}>
                    <span style={S.logTime}>{l.time}</span>
                    <span>{l.msg}</span>
                  </div>
                ))}
              </div>
            }
          </div>
        )}

      </main>

      {/* Footer */}
      <footer style={S.footer}>
        <span style={S.footerNote}>Paper Trading — EMA {EMA_FAST}/{EMA_SLOW} · CoinDCX</span>
        <button style={S.resetBtn} onClick={handleReset}>Reset</button>
      </footer>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function Card({ label, value, sub, color }) {
  return (
    <div style={S.card}>
      <div style={S.cardLabel}>{label}</div>
      <div style={{ ...S.cardValue, color: color || "#f0f0f0" }}>{value}</div>
      {sub && <div style={S.cardSub}>{sub}</div>}
    </div>
  );
}
function Kv({ label, val, color }) {
  return (
    <div style={S.kv}>
      <div style={S.kvLabel}>{label}</div>
      <div style={{ ...S.kvVal, color: color || "#e0e0e0" }}>{val}</div>
    </div>
  );
}

const LOG_COLORS = { info: "#888", entry: "#60c0ff", profit: "#00e5a0", loss: "#ff4e6a", warn: "#f5a623", error: "#ff4e6a" };

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  root: { minHeight: "100vh", background: "#080c12", color: "#e0e0e0", fontFamily: "'DM Mono', 'Fira Mono', monospace", display: "flex", flexDirection: "column" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #1a2030", background: "#080c12" },
  logo: { display: "flex", alignItems: "center", gap: 10 },
  logoMark: { fontSize: 22, color: "#00e5a0" },
  logoText: { fontSize: 18, fontWeight: 700, letterSpacing: "0.05em", color: "#f0f0f0" },
  logoSub: { color: "#00e5a0", fontWeight: 400 },
  statusPill: { fontSize: 11, padding: "4px 12px", borderRadius: 20, background: "#0d1520", border: "1px solid #1e3040", color: "#00e5a0", letterSpacing: "0.05em" },
  nav: { display: "flex", gap: 0, borderBottom: "1px solid #1a2030", background: "#080c12" },
  tab: { flex: 1, padding: "12px 0", background: "transparent", border: "none", borderBottom: "2px solid transparent", color: "#666", cursor: "pointer", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", transition: "all 0.2s" },
  tabActive: { color: "#00e5a0", borderBottom: "2px solid #00e5a0" },
  main: { flex: 1, padding: "20px 16px", overflowY: "auto" },
  cards: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 },
  card: { background: "#0d1520", border: "1px solid #1a2a3a", borderRadius: 8, padding: "14px 16px" },
  cardLabel: { fontSize: 10, color: "#667", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 },
  cardValue: { fontSize: 18, fontWeight: 700, marginBottom: 2 },
  cardSub: { fontSize: 10, color: "#556" },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 10, color: "#667", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 12 },
  pairGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  pairCard: { background: "#0d1520", border: "1px solid #1a2a3a", borderRadius: 8, padding: "14px" },
  pairHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  pairLabel: { fontSize: 11, fontWeight: 700, color: "#a0b0c0", letterSpacing: "0.06em" },
  badge: { fontSize: 9, padding: "2px 7px", borderRadius: 4, fontWeight: 700 },
  pairPrice: { fontSize: 20, fontWeight: 700, color: "#f0f0f0", marginBottom: 4 },
  pairTrend: { fontSize: 11, fontWeight: 600, marginBottom: 8 },
  pairEma: { display: "flex", justifyContent: "space-between", fontSize: 10, color: "#556", marginBottom: 8 },
  pairBar: { height: 3, background: "#1a2a3a", borderRadius: 2, overflow: "hidden", marginBottom: 4 },
  pairBarInner: { height: "100%", background: "#00e5a0", transition: "width 0.5s", borderRadius: 2 },
  pairBarLabel: { fontSize: 9, color: "#445" },
  posCard: { background: "#0d1520", border: "1px solid #1a2a3a", borderRadius: 8, padding: "14px", marginBottom: 10 },
  posTop: { display: "flex", justifyContent: "space-between", marginBottom: 12 },
  posLabel: { fontWeight: 700, fontSize: 13 },
  posRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  kv: { background: "#080c12", borderRadius: 6, padding: "8px 10px" },
  kvLabel: { fontSize: 9, color: "#556", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 3 },
  kvVal: { fontSize: 13, fontWeight: 600 },
  tradeList: { display: "flex", flexDirection: "column", gap: 1 },
  tradeRow: { display: "grid", gridTemplateColumns: "70px 48px 80px 1fr 80px", gap: 8, padding: "8px 12px", background: "#0d1520", borderRadius: 4, fontSize: 11, alignItems: "center" },
  tradeTime: { color: "#556" },
  tradeSide: { fontWeight: 700 },
  tradePair: { color: "#aaa" },
  tradePrice: { color: "#ddd" },
  tradePnl: { textAlign: "right", fontWeight: 600 },
  logList: { display: "flex", flexDirection: "column", gap: 4 },
  logRow: { display: "flex", gap: 12, fontSize: 11, padding: "6px 0", borderBottom: "1px solid #0d1520" },
  logTime: { color: "#445", minWidth: 70 },
  empty: { color: "#445", fontSize: 12, textAlign: "center", padding: "40px 0" },
  footer: { padding: "12px 20px", borderTop: "1px solid #1a2030", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#080c12" },
  footerNote: { fontSize: 10, color: "#445" },
  resetBtn: { fontSize: 10, color: "#ff4e6a", background: "transparent", border: "1px solid #ff4e6a40", padding: "4px 12px", borderRadius: 4, cursor: "pointer", letterSpacing: "0.06em" },
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080c12; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: #080c12; }
  ::-webkit-scrollbar-thumb { background: #1a2a3a; border-radius: 2px; }
  .pulse { animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
`;
