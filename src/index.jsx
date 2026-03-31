import { useState, useEffect, useRef, useCallback } from "react";

// ─── Config ───────────────────────────────────────────────────────────────────
const PAIRS = [
  { symbol: "BTCINR", label: "BTC", full: "Bitcoin",  dcxPair: "BTCINR",  candlePair: "B-BTC_INR", color: "#f7931a", bg: "#fff8f0", icon: "₿" },
  { symbol: "ETHINR", label: "ETH", full: "Ethereum", dcxPair: "ETHINR",  candlePair: "B-ETH_INR", color: "#627eea", bg: "#f0f2ff", icon: "Ξ" },
  { symbol: "SOLINR", label: "SOL", full: "Solana",   dcxPair: "SOLINR",  candlePair: "B-SOL_INR", color: "#9945ff", bg: "#f8f0ff", icon: "◎" },
];

const EMA_FAST    = 9;
const EMA_SLOW    = 21;
const CANDLE_MS   = 5 * 60 * 1000;
const TICKER_MS   = 10 * 1000;
const STOP_LOSS   = 0.02;   // 2%
const TAKE_PROFIT = 0.04;   // 4%
const MAX_LOSSES  = 3;      // circuit breaker
const STORAGE_KEY = "cryptoedge_v4";

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
    capital, startCapital: capital,
    positions: {}, trades: [],
    realizedPnl: 0, wins: 0, losses: 0,
    consecutiveLosses: 0, isRunning: false,
  };
}
const initState = () => load() || freshState(1000);

// ─── Formatters ───────────────────────────────────────────────────────────────
const fmt     = (n, d = 2) => n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtSign = (n) => (n >= 0 ? "+" : "") + fmt(n);
const ts      = () => new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const tsISO   = () => new Date().toISOString();

// ─── App ──────────────────────────────────────────────────────────────────────
export default function CryptoEdge() {
  const [state, setState]         = useState(initState);
  const [prices, setPrices]       = useState({});
  const [prevPrices, setPrev]     = useState({});
  const [candles, setCandles]     = useState({});
  const [emas, setEmas]           = useState({});
  const [logs, setLogs]           = useState([]);
  const [tab, setTab]             = useState("dashboard");
  const [apiStatus, setApiStatus] = useState({ ticker: "…", candles: "…" });
  const [showCapModal, setShowCap]= useState(false);
  const [capInput, setCapInput]   = useState("");
  const [flashPnl, setFlashPnl]   = useState(null);
  const [lastScan, setLastScan]   = useState(null);
  const [scanning, setScanning]   = useState(false);
  const [circuitOpen, setCircuit] = useState(false);

  const stateRef    = useRef(state);
  const pricesRef   = useRef(prices);
  const candlesRef  = useRef(candles);
  stateRef.current  = state;
  pricesRef.current = prices;
  candlesRef.current= candles;

  useEffect(() => { save(state); }, [state]);

  const addLog = useCallback((msg, type = "info") => {
    const entry = { msg, type, time: ts(), iso: tsISO() };
    setLogs(p => [entry, ...p].slice(0, 200));
  }, []);

  // ─── Fetch Ticker ─────────────────────────────────────────────────────────
  const fetchTicker = useCallback(async () => {
    try {
      const res  = await fetch("/api/ticker");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const map  = {};
      data.forEach(t => { map[t.market] = parseFloat(t.last_price); });
      const newP = {};
      PAIRS.forEach(p => { if (map[p.dcxPair]) newP[p.symbol] = map[p.dcxPair]; });
      setPrev(prev => ({ ...prev, ...pricesRef.current }));
      setPrices(pp => ({ ...pp, ...newP }));
      setApiStatus(s => ({ ...s, ticker: "live" }));
    } catch (e) {
      setApiStatus(s => ({ ...s, ticker: "error" }));
      addLog("Ticker error: " + e.message, "error");
    }
  }, [addLog]);

  // ─── Fetch Candles ────────────────────────────────────────────────────────
  const fetchCandles = useCallback(async () => {
    let anyOk = false;
    for (const p of PAIRS) {
      try {
        const res  = await fetch(`/api/candles?pair=${p.candlePair}`);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const sorted = Array.isArray(data) ? [...data].sort((a, b) => a.time - b.time) : [];
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

  // ─── Tick loops ───────────────────────────────────────────────────────────
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

  // ─── Main Scanner ─────────────────────────────────────────────────────────
  const runScan = useCallback(() => {
    const cur = stateRef.current;
    if (!cur.isRunning) return;

    const prices  = pricesRef.current;
    const candles = candlesRef.current;

    setScanning(true);
    setLastScan(ts());

    const newEmas = {};
    let stateChanged = false;
    let updates = {};

    // Work on a mutable copy
    let capital          = cur.capital;
    let positions        = { ...cur.positions };
    let trades           = [...cur.trades];
    let realizedPnl      = cur.realizedPnl;
    let wins             = cur.wins;
    let losses           = cur.losses;
    let consLosses       = cur.consecutiveLosses;

    PAIRS.forEach(p => {
      const closes = candles[p.symbol] || [];
      const fast   = calcEMA(closes, EMA_FAST);
      const slow   = calcEMA(closes, EMA_SLOW);
      newEmas[p.symbol] = { fast, slow, candles: closes.length };

      const price = prices[p.symbol];
      if (!price) return;

      const pos = positions[p.symbol];

      // ── Check Stop-Loss / Take-Profit on open position ──
      if (pos) {
        const pnlPct = pos.side === "BUY"
          ? (price - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - price) / pos.entryPrice;

        let exitReason = null;
        if (pnlPct <= -STOP_LOSS)   exitReason = "SL";
        if (pnlPct >= TAKE_PROFIT)  exitReason = "TP";

        if (exitReason) {
          const pnl       = pnlPct * pos.entryPrice * pos.qty;
          const recovered = pos.qty * pos.entryPrice + pnl;
          capital     += recovered;
          realizedPnl += pnl;
          if (pnl >= 0) { wins++; consLosses = 0; }
          else          { losses++; consLosses++; }

          trades = [{ symbol: p.symbol, side: "EXIT", exitReason, price, qty: pos.qty, pnl, pnlPct: pnlPct * 100, time: ts() }, ...trades].slice(0, 100);
          delete positions[p.symbol];
          stateChanged = true;

          setFlashPnl({ val: pnl, label: p.label, reason: exitReason });
          setTimeout(() => setFlashPnl(null), 3000);
          addLog(`${exitReason === "SL" ? "🛑" : "🎯"} ${exitReason} ${p.label} @ ₹${fmt(price, 0)} | P&L: ₹${fmtSign(pnl)} (${fmtSign(pnlPct * 100)}%)`, pnl >= 0 ? "profit" : "loss");

          // Circuit breaker
          if (consLosses >= MAX_LOSSES) {
            setCircuit(true);
            setState(s => ({ ...s, isRunning: false }));
            addLog(`⚡ Circuit breaker: ${MAX_LOSSES} consecutive losses. Trading paused.`, "warn");
          }
          return;
        }
      }

      // ── EMA Signal ──
      const signal = getSignal(closes);
      if (!signal) return;

      // Exit on opposite signal
      if (pos && pos.side !== signal) {
        const pnl       = (pos.side === "BUY" ? price - pos.entryPrice : pos.entryPrice - price) * pos.qty;
        const pnlPct    = pnl / (pos.entryPrice * pos.qty);
        const recovered = pos.qty * pos.entryPrice + pnl;
        capital     += recovered;
        realizedPnl += pnl;
        if (pnl >= 0) { wins++; consLosses = 0; }
        else          { losses++; consLosses++; }

        trades = [{ symbol: p.symbol, side: "EXIT", exitReason: "SIGNAL", price, qty: pos.qty, pnl, pnlPct: pnlPct * 100, time: ts() }, ...trades].slice(0, 100);
        delete positions[p.symbol];
        stateChanged = true;

        setFlashPnl({ val: pnl, label: p.label, reason: "SIGNAL" });
        setTimeout(() => setFlashPnl(null), 3000);
        addLog(`🔄 EXIT ${p.label} @ ₹${fmt(price, 0)} | P&L: ₹${fmtSign(pnl)}`, pnl >= 0 ? "profit" : "loss");

        if (consLosses >= MAX_LOSSES) {
          setCircuit(true);
          setState(s => ({ ...s, isRunning: false }));
          addLog(`⚡ Circuit breaker triggered. Trading paused.`, "warn");
          return;
        }
      }

      // Enter new position
      if (!positions[p.symbol] && !circuitOpen) {
        const usable = capital * 0.9;
        if (usable < 1) { addLog("⚠️ Insufficient capital", "warn"); return; }
        const qty = usable / price;
        capital -= qty * price;
        positions[p.symbol] = { entryPrice: price, qty, side: signal };
        trades = [{ symbol: p.symbol, side: signal, price, qty, pnl: null, pnlPct: null, time: ts() }, ...trades].slice(0, 100);
        stateChanged = true;
        addLog(`${signal === "BUY" ? "🟢" : "🔴"} ${signal} ${p.label} @ ₹${fmt(price, 0)} | Qty: ${qty.toFixed(6)}`, "entry");
      }
    });

    if (stateChanged) {
      setState(s => ({
        ...s, capital, positions, trades, realizedPnl,
        wins, losses, consecutiveLosses: consLosses,
      }));
    }

    setEmas(newEmas);
    setTimeout(() => setScanning(false), 600);
  }, [addLog, circuitOpen]);

  // ─── Scanner interval ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!state.isRunning) return;
    runScan(); // immediate scan on start
    const id = setInterval(runScan, TICKER_MS);
    return () => clearInterval(id);
  }, [state.isRunning, runScan]);

  // ─── Toggle Trading ───────────────────────────────────────────────────────
  const toggleTrading = () => {
    if (circuitOpen) {
      setCircuit(false);
      setState(s => ({ ...s, isRunning: true, consecutiveLosses: 0 }));
      addLog("⚡ Circuit breaker reset. Trading resumed.", "info");
      return;
    }
    setState(s => {
      const next = !s.isRunning;
      addLog(next ? "▶️ Trading STARTED" : "⏹️ Trading STOPPED", "info");
      return { ...s, isRunning: next };
    });
  };

  // ─── Derived ──────────────────────────────────────────────────────────────
  const unrealized = Object.entries(state.positions).reduce((sum, [sym, pos]) => {
    const p = prices[sym];
    if (!p) return sum;
    return sum + (pos.side === "BUY" ? p - pos.entryPrice : pos.entryPrice - p) * pos.qty;
  }, 0);
  const totalValue = state.capital + Object.entries(state.positions).reduce((sum, [sym, pos]) => {
    return sum + (prices[sym] || pos.entryPrice) * pos.qty;
  }, 0);
  const totalPct   = state.startCapital > 0 ? ((totalValue - state.startCapital) / state.startCapital * 100) : 0;
  const winRate    = (state.wins + state.losses) > 0 ? ((state.wins / (state.wins + state.losses)) * 100).toFixed(0) : "—";
  const bothLive   = apiStatus.ticker === "live" && apiStatus.candles === "live";
  const anyError   = apiStatus.ticker === "error" || apiStatus.candles === "error";

  // ─── Export Logs ──────────────────────────────────────────────────────────
  const exportLogs = () => {
    const header = "Time,Type,Message\n";
    const rows   = logs.map(l => `"${l.iso}","${l.type}","${l.msg.replace(/"/g, "'")}"`).join("\n");
    const blob   = new Blob([header + rows], { type: "text/csv" });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement("a");
    a.href       = url;
    a.download   = `cryptoedge-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportTrades = () => {
    const header = "Time,Symbol,Side,Exit Reason,Price,Qty,PnL,PnL%\n";
    const rows   = state.trades.map(t =>
      `"${t.time}","${t.symbol}","${t.side}","${t.exitReason || ""}","${t.price}","${t.qty}","${t.pnl ?? ""}","${t.pnlPct != null ? t.pnlPct.toFixed(2) : ""}"`
    ).join("\n");
    const blob   = new Blob([header + rows], { type: "text/csv" });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement("a");
    a.href       = url;
    a.download   = `cryptoedge-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ─── Capital modal ────────────────────────────────────────────────────────
  const handleSetCapital = () => {
    const val = parseFloat(capInput);
    if (!val || val < 1) return;
    setState(freshState(val));
    setLogs([]);
    setCircuit(false);
    setShowCap(false);
    setCapInput("");
    addLog(`💰 Capital set to ₹${fmt(val)}`, "info");
  };

  const handleReset = () => {
    if (!window.confirm("Reset all paper trading data?")) return;
    setState(freshState(state.startCapital));
    setLogs([]);
    setCircuit(false);
    addLog("🔄 Reset complete.", "info");
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>
      <style>{CSS}</style>

      {/* Flash Toast */}
      {flashPnl && (
        <div style={{ ...S.toast, background: flashPnl.val >= 0 ? "#f0fdf4" : "#fff1f2", borderColor: flashPnl.val >= 0 ? "#22c55e" : "#ef4444", color: flashPnl.val >= 0 ? "#16a34a" : "#dc2626" }}>
          {flashPnl.val >= 0 ? "🎯" : "🛑"} {flashPnl.label} {flashPnl.reason} — ₹{fmtSign(flashPnl.val)}
        </div>
      )}

      {/* Capital Modal */}
      {showCapModal && (
        <div style={S.overlay} onClick={() => setShowCap(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalTitle}>Set Paper Capital</div>
            <div style={S.modalSub}>Positions and history will be cleared.</div>
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
            <div style={S.logoSub}>Paper Trading · CoinDCX · EMA {EMA_FAST}/{EMA_SLOW}</div>
          </div>
        </div>
        <div style={S.headerRight}>
          <div style={{ ...S.dot, background: bothLive ? "#22c55e" : anyError ? "#ef4444" : "#f59e0b" }} className="blink" />
          <span style={{ fontSize: 10, color: bothLive ? "#16a34a" : "#dc2626", fontWeight: 700 }}>
            {bothLive ? "Live" : anyError ? "Error" : "…"}
          </span>
        </div>
      </header>

      {/* Circuit Breaker Banner */}
      {circuitOpen && (
        <div style={S.circuitBanner}>
          ⚡ Circuit Breaker Active — {MAX_LOSSES} consecutive losses. Tap START to resume.
        </div>
      )}

      {/* START/STOP + Scan Status */}
      <div style={S.controlBar}>
        <button
          style={{ ...S.startBtn, background: state.isRunning ? "#ef4444" : "linear-gradient(135deg,#22c55e,#16a34a)", boxShadow: state.isRunning ? "0 4px 14px #ef444440" : "0 4px 14px #22c55e40" }}
          onClick={toggleTrading}
        >
          {state.isRunning ? "⏹ STOP TRADING" : circuitOpen ? "⚡ RESET & START" : "▶ START TRADING"}
        </button>

        <div style={S.scanStatus}>
          {state.isRunning ? (
            <>
              <div style={S.scanDot} className={scanning ? "scanning" : "idle"} />
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: scanning ? "#6366f1" : "#22c55e" }}>
                  {scanning ? "Scanning…" : "Watching"}
                </div>
                <div style={{ fontSize: 9, color: "#94a3b8" }}>
                  {lastScan ? `Last: ${lastScan}` : "Starting…"}
                </div>
              </div>
            </>
          ) : (
            <>
              <div style={{ ...S.scanDot, background: "#94a3b8" }} />
              <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600 }}>Paused</div>
            </>
          )}
        </div>
      </div>

      {/* Summary */}
      <div style={S.summary}>
        <SCard label="Portfolio"     value={`₹${fmt(totalValue)}`} sub={`${fmtSign(totalPct)}%`} subColor={totalPct >= 0 ? "#16a34a" : "#dc2626"} color="#6366f1" />
        <SCard label="Realized P&L"  value={`₹${fmtSign(state.realizedPnl)}`} color={state.realizedPnl >= 0 ? "#16a34a" : "#dc2626"} />
        <SCard label="Unrealized"    value={`₹${fmtSign(unrealized)}`}  color={unrealized >= 0 ? "#0891b2" : "#ea580c"} />
        <SCard label="Win Rate"      value={winRate === "—" ? "—" : `${winRate}%`} sub={`${state.wins}W · ${state.losses}L`} color="#7c3aed" />
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

        {/* ── DASHBOARD ── */}
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
              const upnlPct= pos && price ? ((pos.side === "BUY" ? price - pos.entryPrice : pos.entryPrice - price) / pos.entryPrice) * 100 : null;

              // SL/TP proximity
              let slPrice = null, tpPrice = null;
              if (pos) {
                slPrice = pos.side === "BUY" ? pos.entryPrice * (1 - STOP_LOSS) : pos.entryPrice * (1 + STOP_LOSS);
                tpPrice = pos.side === "BUY" ? pos.entryPrice * (1 + TAKE_PROFIT) : pos.entryPrice * (1 - TAKE_PROFIT);
              }

              return (
                <div key={p.symbol} style={{ ...S.pCard, borderTop: `4px solid ${p.color}`, opacity: (!state.isRunning && !pos) ? 0.75 : 1 }} className="card">
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

                  <div style={{ fontSize: 11, fontWeight: 700, color: tColor, marginBottom: 6 }}>{trend}</div>

                  <div style={S.emaRow}>
                    <span style={{ ...S.chip, background: "#eff6ff", color: "#3b82f6" }}>EMA{EMA_FAST}: {em.fast ? fmt(em.fast, 0) : "—"}</span>
                    <span style={{ ...S.chip, background: "#fdf4ff", color: "#a855f7" }}>EMA{EMA_SLOW}: {em.slow ? fmt(em.slow, 0) : "—"}</span>
                  </div>

                  {pos && upnl != null && (
                    <div style={{ fontSize: 11, fontWeight: 700, color: upnl >= 0 ? "#16a34a" : "#dc2626", marginBottom: 4 }}>
                      P&L: ₹{fmtSign(upnl)} ({fmtSign(upnlPct)}%)
                    </div>
                  )}

                  {pos && (
                    <div style={S.sltp}>
                      <span style={{ color: "#dc2626" }}>SL ₹{fmt(slPrice, 0)}</span>
                      <span style={{ color: "#16a34a" }}>TP ₹{fmt(tpPrice, 0)}</span>
                    </div>
                  )}

                  <div style={S.track}><div style={{ ...S.bar, width: `${warmPct}%`, background: warmPct >= 100 ? p.color : "#94a3b8" }} /></div>
                  <div style={S.trackLabel}>{warmPct >= 100 ? "✓ Signals active" : `${em.candles || 0}/${EMA_SLOW} candles`}</div>
                </div>
              );
            })}
          </div>

          {/* Stats Row */}
          <div style={S.statsRow}>
            <Stat label="Total Trades" val={state.wins + state.losses} />
            <Stat label="Wins" val={state.wins} color="#16a34a" />
            <Stat label="Losses" val={state.losses} color="#dc2626" />
            <Stat label="Consec. L" val={state.consecutiveLosses} color={state.consecutiveLosses >= 2 ? "#f59e0b" : "#64748b"} />
          </div>

          {/* Config Box */}
          <div style={S.configBox}>
            <div style={S.configTitle}>Strategy Config</div>
            <div style={S.configGrid}>
              <Kv label="EMA Fast"    val={`${EMA_FAST} periods`} />
              <Kv label="EMA Slow"    val={`${EMA_SLOW} periods`} />
              <Kv label="Stop Loss"   val={`${STOP_LOSS * 100}%`} color="#dc2626" />
              <Kv label="Take Profit" val={`${TAKE_PROFIT * 100}%`} color="#16a34a" />
              <Kv label="Circuit Breaker" val={`${MAX_LOSSES} losses`} color="#f59e0b" />
              <Kv label="Candle TF"   val="5 minutes" />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <button style={S.btnSm} onClick={() => setShowCap(true)}>✏️ Change Capital</button>
              <button style={{ ...S.btnSm, borderColor: "#ef4444", color: "#ef4444" }} onClick={handleReset}>🔄 Reset All</button>
            </div>
          </div>

          {/* API Status */}
          <div style={S.apiBox}>
            {[
              ["Ticker (live price)", apiStatus.ticker],
              ["5m Candles (EMA data)", apiStatus.candles],
            ].map(([label, status]) => (
              <div key={label} style={S.apiRow}>
                <span style={{ fontSize: 12, color: "#64748b" }}>{label}</span>
                <span style={{ fontWeight: 700, color: status === "live" ? "#16a34a" : status === "error" ? "#dc2626" : "#f59e0b", fontSize: 12 }}>
                  {status === "live" ? "✓ Live" : status === "error" ? "✗ Error" : "…"}
                </span>
              </div>
            ))}
            <div style={S.apiRow}>
              <span style={{ fontSize: 12, color: "#64748b" }}>Free Cash</span>
              <span style={{ fontWeight: 700, color: "#6366f1", fontSize: 12 }}>₹{fmt(state.capital)}</span>
            </div>
            <div style={S.apiRow}>
              <span style={{ fontSize: 12, color: "#64748b" }}>Starting Capital</span>
              <span style={{ fontWeight: 700, color: "#1e293b", fontSize: 12 }}>₹{fmt(state.startCapital)}</span>
            </div>
          </div>
        </>}

        {/* ── POSITIONS ── */}
        {tab === "positions" && <>
          <div style={S.secTitle}>Open Positions ({Object.keys(state.positions).length})</div>
          {Object.keys(state.positions).length === 0
            ? <Empty icon="📭" text="No open positions. Start trading to open positions automatically." />
            : Object.entries(state.positions).map(([sym, pos]) => {
              const pair   = PAIRS.find(p => p.symbol === sym);
              const price  = prices[sym] || pos.entryPrice;
              const upnl   = (pos.side === "BUY" ? price - pos.entryPrice : pos.entryPrice - price) * pos.qty;
              const upnlPct= (upnl / (pos.entryPrice * pos.qty)) * 100;
              const slPrice= pos.side === "BUY" ? pos.entryPrice * (1 - STOP_LOSS) : pos.entryPrice * (1 + STOP_LOSS);
              const tpPrice= pos.side === "BUY" ? pos.entryPrice * (1 + TAKE_PROFIT) : pos.entryPrice * (1 - TAKE_PROFIT);
              return (
                <div key={sym} style={{ ...S.posCard, borderLeft: `4px solid ${pair?.color}` }}>
                  <div style={S.posHead}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ ...S.pIcon, background: pair?.bg, color: pair?.color, width: 38, height: 38, fontSize: 18 }}>{pair?.icon}</span>
                      <div>
                        <div style={{ fontWeight: 700, color: "#1e293b" }}>{pair?.full}</div>
                        <div style={{ fontSize: 10, color: "#94a3b8" }}>{pair?.label}/INR · Entered {pos.time || "—"}</div>
                      </div>
                    </div>
                    <div style={{ ...S.badge, background: pos.side === "BUY" ? "#dcfce7" : "#fee2e2", color: pos.side === "BUY" ? "#16a34a" : "#dc2626", fontSize: 13, padding: "5px 14px" }}>{pos.side}</div>
                  </div>
                  <div style={S.kvGrid}>
                    <Kv label="Entry"       val={`₹${fmt(pos.entryPrice, 0)}`} />
                    <Kv label="Current"     val={`₹${fmt(price, 0)}`} />
                    <Kv label="Stop Loss"   val={`₹${fmt(slPrice, 0)}`} color="#dc2626" />
                    <Kv label="Take Profit" val={`₹${fmt(tpPrice, 0)}`} color="#16a34a" />
                    <Kv label="Quantity"    val={pos.qty.toFixed(6)} />
                    <Kv label="Unrealized"  val={`₹${fmtSign(upnl)} (${fmtSign(upnlPct)}%)`} color={upnl >= 0 ? "#16a34a" : "#dc2626"} />
                  </div>
                </div>
              );
            })
          }
        </>}

        {/* ── TRADES ── */}
        {tab === "trades" && <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={S.secTitle}>Trade History ({state.trades.length})</div>
            {state.trades.length > 0 && (
              <button style={{ ...S.btnSm, fontSize: 10 }} onClick={exportTrades}>⬇️ Export CSV</button>
            )}
          </div>
          {state.trades.length === 0
            ? <Empty icon="📋" text="No trades yet. Start trading to see history here." />
            : state.trades.map((t, i) => {
              const pair   = PAIRS.find(p => p.symbol === t.symbol);
              const isExit = t.side === "EXIT";
              const win    = isExit && t.pnl >= 0;
              const reasonColor = { SL: "#dc2626", TP: "#16a34a", SIGNAL: "#6366f1" };
              return (
                <div key={i} style={{ ...S.tCard, borderLeft: `4px solid ${isExit ? (win ? "#22c55e" : "#ef4444") : (pair?.color || "#6366f1")}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 20 }}>{pair?.icon}</span>
                    <div>
                      <div style={{ fontWeight: 600, color: "#1e293b", fontSize: 13 }}>{pair?.label}/INR</div>
                      <div style={{ fontSize: 10, color: "#94a3b8" }}>{t.time}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ ...S.badge, background: t.side === "BUY" ? "#dbeafe" : isExit ? (win ? "#dcfce7" : "#fee2e2") : "#fce7f3", color: t.side === "BUY" ? "#2563eb" : isExit ? (win ? "#16a34a" : "#dc2626") : "#db2777" }}>
                      {t.side}
                    </div>
                    {t.exitReason && <div style={{ fontSize: 9, fontWeight: 700, color: reasonColor[t.exitReason] || "#6366f1", marginTop: 2 }}>{t.exitReason}</div>}
                    <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>₹{fmt(t.price, 0)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {t.pnl != null
                      ? <>
                        <div style={{ fontWeight: 700, color: t.pnl >= 0 ? "#16a34a" : "#dc2626" }}>₹{fmtSign(t.pnl)}</div>
                        <div style={{ fontSize: 10, color: t.pnl >= 0 ? "#16a34a" : "#dc2626" }}>{fmtSign(t.pnlPct?.toFixed(1))}%</div>
                      </>
                      : <div style={{ color: "#94a3b8", fontSize: 12 }}>Open</div>
                    }
                    <div style={{ fontSize: 10, color: "#94a3b8" }}>qty {t.qty.toFixed(4)}</div>
                  </div>
                </div>
              );
            })
          }
        </>}

        {/* ── LOGS ── */}
        {tab === "logs" && <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={S.secTitle}>System Logs ({logs.length})</div>
            <div style={{ display: "flex", gap: 6 }}>
              {logs.length > 0 && <button style={{ ...S.btnSm, fontSize: 10 }} onClick={exportLogs}>⬇️ Export CSV</button>}
              {logs.length > 0 && <button style={{ ...S.btnSm, fontSize: 10, borderColor: "#ef4444", color: "#ef4444" }} onClick={() => setLogs([])}>Clear</button>}
            </div>
          </div>
          {logs.length === 0
            ? <Empty icon="🔔" text="Logs will appear here when trading starts." />
            : logs.map((l, i) => (
              <div key={i} style={{ ...S.logRow, borderLeft: `3px solid ${LC[l.type] || "#94a3b8"}` }}>
                <span style={S.logTime}>{l.time}</span>
                <span style={{ ...S.logIcon }}>{LI[l.type] || "•"}</span>
                <span style={{ color: LC[l.type] || "#475569", flex: 1, fontSize: 12 }}>{l.msg}</span>
              </div>
            ))
          }
        </>}

      </main>

      <footer style={S.footer}>
        SL {STOP_LOSS * 100}% · TP {TAKE_PROFIT * 100}% · Circuit {MAX_LOSSES}L · EMA {EMA_FAST}/{EMA_SLOW} · 5m
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
      {sub && <div style={{ fontSize: 11, color: subColor || "#64748b", fontWeight: 600 }}>{sub}</div>}
    </div>
  );
}
function Kv({ label, val, color }) {
  return (
    <div style={S.kv}>
      <div style={S.kvL}>{label}</div>
      <div style={{ ...S.kvV, color: color || "#1e293b" }}>{val}</div>
    </div>
  );
}
function Stat({ label, val, color }) {
  return (
    <div style={S.statBox}>
      <div style={{ fontSize: 9, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: color || "#1e293b" }}>{val}</div>
    </div>
  );
}
function Empty({ icon, text }) {
  return <div style={{ textAlign: "center", padding: "48px 20px", color: "#94a3b8" }}><div style={{ fontSize: 36, marginBottom: 10 }}>{icon}</div><div style={{ fontSize: 13 }}>{text}</div></div>;
}

const LC = { info: "#6366f1", entry: "#0891b2", profit: "#16a34a", loss: "#dc2626", warn: "#f59e0b", error: "#ef4444" };
const LI = { info: "ℹ️", entry: "📈", profit: "✅", loss: "❌", warn: "⚠️", error: "🔴" };

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  root:        { minHeight: "100vh", background: "linear-gradient(135deg,#f0f9ff 0%,#faf5ff 50%,#fff7ed 100%)", fontFamily: "'Nunito','Segoe UI',sans-serif", display: "flex", flexDirection: "column", maxWidth: 480, margin: "0 auto" },
  header:      { background: "white", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 2px 12px #6366f115", position: "sticky", top: 0, zIndex: 10 },
  logo:        { display: "flex", alignItems: "center", gap: 10 },
  logoIcon:    { width: 38, height: 38, borderRadius: 11, background: "linear-gradient(135deg,#6366f1,#a855f7)", color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, fontWeight: 700 },
  logoName:    { fontSize: 16, fontWeight: 800, color: "#1e293b", lineHeight: 1.2 },
  ai:          { background: "linear-gradient(90deg,#6366f1,#a855f7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" },
  logoSub:     { fontSize: 9, color: "#94a3b8" },
  headerRight: { display: "flex", alignItems: "center", gap: 5 },
  dot:         { width: 8, height: 8, borderRadius: "50%" },
  circuitBanner:{ background: "#fef3c7", color: "#92400e", fontSize: 11, fontWeight: 700, padding: "8px 16px", textAlign: "center", borderBottom: "1px solid #fcd34d" },
  controlBar:  { background: "white", padding: "12px 14px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid #f1f5f9" },
  startBtn:    { flex: 1, padding: "12px 0", borderRadius: 12, border: "none", color: "white", fontWeight: 800, fontSize: 13, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.04em", transition: "all 0.2s" },
  scanStatus:  { display: "flex", alignItems: "center", gap: 8 },
  scanDot:     { width: 10, height: 10, borderRadius: "50%", background: "#22c55e" },
  summary:     { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "10px 12px", background: "white", borderBottom: "1px solid #f1f5f9" },
  sc:          { background: "#fafbff", borderRadius: 10, padding: "9px 11px", border: "1px solid #e2e8f0" },
  scLabel:     { fontSize: 9, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 3 },
  scVal:       { fontSize: 15, fontWeight: 800, lineHeight: 1.1 },
  nav:         { display: "flex", background: "white", borderBottom: "2px solid #f1f5f9", position: "sticky", top: 62, zIndex: 9 },
  tab:         { flex: 1, padding: "10px 4px", background: "transparent", border: "none", borderBottom: "3px solid transparent", color: "#94a3b8", cursor: "pointer", fontSize: 10, fontWeight: 700, transition: "all 0.2s", fontFamily: "inherit" },
  tabOn:       { color: "#6366f1", borderBottom: "3px solid #6366f1", background: "#fafbff" },
  main:        { flex: 1, padding: "14px 12px", overflowY: "auto" },
  grid:        { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 },
  pCard:       { background: "white", borderRadius: 14, padding: "12px", boxShadow: "0 2px 12px #0000000a", border: "1px solid #f1f5f9", transition: "opacity 0.3s" },
  pTop:        { display: "flex", alignItems: "center", gap: 7, marginBottom: 7 },
  pIcon:       { width: 30, height: 30, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, flexShrink: 0 },
  pName:       { fontSize: 11, fontWeight: 700, color: "#1e293b" },
  pSym:        { fontSize: 9, color: "#94a3b8" },
  badge:       { fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 6 },
  price:       { fontSize: 17, fontWeight: 800, marginBottom: 3 },
  emaRow:      { display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 5 },
  chip:        { fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 4 },
  sltp:        { display: "flex", justifyContent: "space-between", fontSize: 9, fontWeight: 700, background: "#f8fafc", borderRadius: 5, padding: "3px 7px", marginBottom: 5 },
  track:       { height: 3, background: "#f1f5f9", borderRadius: 2, overflow: "hidden", marginBottom: 3 },
  bar:         { height: "100%", borderRadius: 2, transition: "width 0.6s" },
  trackLabel:  { fontSize: 9, color: "#94a3b8" },
  statsRow:    { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 10 },
  statBox:     { background: "white", borderRadius: 10, padding: "8px 10px", textAlign: "center", boxShadow: "0 1px 6px #0000000a" },
  configBox:   { background: "white", borderRadius: 14, padding: "13px 14px", marginBottom: 10, boxShadow: "0 2px 8px #0000000a" },
  configTitle: { fontSize: 10, fontWeight: 800, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 },
  configGrid:  { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 },
  apiBox:      { background: "white", borderRadius: 12, padding: "11px 14px", boxShadow: "0 2px 8px #0000000a" },
  apiRow:      { display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #f8fafc" },
  secTitle:    { fontSize: 11, fontWeight: 800, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 },
  posCard:     { background: "white", borderRadius: 14, padding: "14px", marginBottom: 10, boxShadow: "0 2px 10px #0000000a" },
  posHead:     { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  kvGrid:      { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  kv:          { background: "#f8fafc", borderRadius: 8, padding: "7px 9px" },
  kvL:         { fontSize: 9, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 2 },
  kvV:         { fontSize: 12, fontWeight: 700 },
  tCard:       { background: "white", borderRadius: 12, padding: "11px 13px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 2px 8px #0000000a" },
  logRow:      { background: "white", borderRadius: 8, padding: "6px 10px", marginBottom: 4, display: "flex", gap: 8, alignItems: "flex-start" },
  logTime:     { fontSize: 10, color: "#94a3b8", minWidth: 64 },
  logIcon:     { fontSize: 11, minWidth: 16 },
  btnSm:       { fontSize: 11, fontWeight: 700, padding: "6px 11px", borderRadius: 8, border: "2px solid #6366f1", color: "#6366f1", background: "transparent", cursor: "pointer", fontFamily: "inherit" },
  btnGhost:    { flex: 1, fontSize: 13, fontWeight: 600, padding: "10px", borderRadius: 10, border: "2px solid #e2e8f0", color: "#64748b", background: "white", cursor: "pointer", fontFamily: "inherit" },
  btnPrimary:  { flex: 1, fontSize: 13, fontWeight: 700, padding: "10px", borderRadius: 10, border: "none", background: "linear-gradient(135deg,#6366f1,#a855f7)", color: "white", cursor: "pointer", fontFamily: "inherit" },
  footer:      { padding: "9px", textAlign: "center", fontSize: 10, color: "#94a3b8", background: "white", borderTop: "1px solid #f1f5f9" },
  toast:       { position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)", border: "2px solid", borderRadius: 12, padding: "10px 18px", fontSize: 13, fontWeight: 600, zIndex: 100, boxShadow: "0 8px 24px #00000015", whiteSpace: "nowrap" },
  overlay:     { position: "fixed", inset: 0, background: "#00000040", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
  modal:       { background: "white", borderRadius: 18, padding: 24, width: "100%", maxWidth: 320, boxShadow: "0 20px 60px #00000020" },
  modalTitle:  { fontSize: 20, fontWeight: 800, color: "#1e293b", marginBottom: 6 },
  modalSub:    { fontSize: 12, color: "#94a3b8", marginBottom: 16 },
  modalInput:  { width: "100%", padding: "12px 14px", borderRadius: 10, border: "2px solid #e2e8f0", fontSize: 16, fontFamily: "inherit", outline: "none", marginBottom: 16, boxSizing: "border-box" },
  modalBtns:   { display: "flex", gap: 10 },
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
  .scanning{animation:scan 0.6s infinite;background:#6366f1!important;}
  .idle{background:#22c55e!important;}
  @keyframes scan{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(1.4)}}
  input:focus{border-color:#6366f1!important;outline:none;}
  button:active{opacity:0.8;}
  ::-webkit-scrollbar{width:4px;}
  ::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:2px;}
`;
