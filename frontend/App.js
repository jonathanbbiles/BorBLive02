

/*
 * Bullish or Bust – v1.13.0 (LIVE-ONLY)
 * What changed:
 *  - Live-only sources: Alpaca quotes/bars/trades ONLY. No synthetic quotes. No external fallbacks.
 *  - Entry requires a real Alpaca quote (bid+ask). If no live quote → skip.
 *  - Crypto momentum uses Alpaca crypto bars (1m) instead of 3rd-party bars.
 *  - New Health checker (account + stocks/crypto quotes). UI card shows status + freshness.
 *  - Freshness enforcement (configurable): quotes must be newer than N ms.
 *  - Keeps taker flip (fee floor by default) + TP timeout flip — now triggered purely by live bids.
 *
 * Still preserved:
 *  - PDT guard (equities), concurrency guard, trailing stops, daily halt rules.
 *  - Crypto location fallback order: ['us','global'].
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  SafeAreaView,
  ActivityIndicator,
  TextInput,
  Platform,
} from 'react-native';
import Constants from 'expo-constants';

/* ========================= 1) META / API CONFIG ========================= */
const VERSION = 'v1.13.0';

const EX = Constants?.expoConfig?.extra || Constants?.manifest?.extra || {};
// (per user request: do not change keys)
const ALPACA_KEY = 'AKANN0IP04IH45Z6FG3L';
const ALPACA_SECRET = 'qvaKRqP9Q3XMVMEYqVnq2BEgPGhQQQfWg1JT7bWV';
const ALPACA_BASE_URL = EX.APCA_API_BASE || 'https://api.alpaca.markets/v2';

const DATA_ROOT_CRYPTO = 'https://data.alpaca.markets/v1beta3/crypto';
const DATA_LOCATIONS = ['us', 'global']; // try US first, then global
const DATA_ROOT_STOCKS_V2 = 'https://data.alpaca.markets/v2/stocks';

const HEADERS = {
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

console.log('[Alpaca LIVE ENV]', {
  base: ALPACA_BASE_URL,
  keyPrefix: (ALPACA_KEY || '').slice(0, 4),
  hasSecret: Boolean(ALPACA_SECRET),
});

/* ================ 2) LIVE SETTINGS (MUTABLE VIA UI PANEL) ================ */
const DEFAULT_SETTINGS = {
  // Risk & selectivity
  riskLevel: 1,
  spreadMaxBps: 100,

  // Per‑trade caps
  maxPosPctEquity: 2,
  absMaxNotionalUSD: 100,

  // Engine cadence
  scanMs: 1500,
  stockPageSize: 50,

  // Entry/Exit behavior
  enableTakerFlip: true,
  takerExitOnTouch: true,
  makerCampSec: 20,
  touchTicksRequired: 1,
  touchFlipTimeoutSec: 8, // force taker exit if touching TP for this long (fee floor still enforced)

  // Profit floors
  netMinProfitUSD: 0.01,
  netMinProfitBps: 5.0,
  netMinProfitUSDBase: 0.0,
  netMinProfitPct: 0.05,
  maxHoldMin: 30,

  // Momentum gate (soft)
  enforceMomentum: true,

  // Exits / stops
  enableStops: true,
  stopLossBps: 25,
  hardStopLossPct: 1.0,
  enableTrailing: true,
  trailStartBps: 15,
  trailingStopBps: 7,
  maxTimeLossUSD: -5.0,

  // Guard for taker exit on TP touch: 'fee' (>= fee floor) or 'min' (strict meetsMinProfit)
  takerExitGuard: 'fee',

  // Dynamic concurrency
  maxConcurrentPositions: 4,

  // Daily halt rules
  haltOnDailyLoss: true,
  dailyMaxLossPct: 5.0,
  haltOnDailyProfit: false,
  dailyProfitTargetPct: 8.0,

  // --- PDT safety ---
  avoidPDT: true,
  pdtEquityThresholdUSD: 25000,

  /* === LIVE DATA ENFORCEMENT === */
  // Require a real Alpaca quote (bid+ask) to enter; trades alone are NOT sufficient.
  liveRequireQuote: true,
  // Quotes must be fresher than these windows to be considered valid:
  // CHANGED: relax crypto freshness 15s → 60s to avoid false "no_live_quote" on quiet books.
  liveFreshMsCrypto: 60000, // 60s
  liveFreshMsStock: 15000,  // 15s
};
let SETTINGS = { ...DEFAULT_SETTINGS };

/* ====================== 3) HTTP HELPER (RETRY/TIMEOUT) ====================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function f(url, opts = {}, timeoutMs = 8000, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ac.signal });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        if (i === retries) return res;
        await sleep(500 * Math.pow(2, i));
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (i === retries) throw e;
      await sleep(350 * Math.pow(2, i));
    }
  }
  if (lastErr) throw lastErr;
  return fetch(url, opts);
}

/* =================== 4) ACCOUNT MONITORING (PNL & FEES) =================== */
async function getPortfolioHistory({ period = '1M', timeframe = '1D' } = {}) {
  const url = `${ALPACA_BASE_URL}/account/portfolio/history?period=${encodeURIComponent(period)}&timeframe=${encodeURIComponent(timeframe)}&extended_hours=true`;
  const res = await f(url, { headers: HEADERS });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}
async function getActivities({ afterISO, untilISO, pageToken } = {}) {
  const params = new URLSearchParams({
    activity_types: 'FILL,FEE,CFEE,PTC',
    direction: 'desc',
    page_size: '100',
  });
  if (afterISO) params.set('after', afterISO);
  if (untilISO) params.set('until', untilISO);
  if (pageToken) params.set('page_token', pageToken);

  const url = `${ALPACA_BASE_URL}/account/activities?${params.toString()}`;
  const res = await f(url, { headers: HEADERS });
  let items = [];
  try { items = await res.json(); } catch {}
  const next = res.headers?.get?.('x-next-page-token') || null;
  return { items: Array.isArray(items) ? items : [], next };
}
const isoDaysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

async function getPnLAndFeesSnapshot() {
  const hist1M = await getPortfolioHistory({ period: '1M', timeframe: '1D' });
  let last7Sum = null, last7DownDays = null, last7UpDays = null, last30Sum = null;
  if (hist1M?.profit_loss) {
    const pl = hist1M.profit_loss.map(Number).filter(Number.isFinite);
    const last7 = pl.slice(-7), last30 = pl.slice(-30);
    last7Sum = last7.reduce((a,b)=>a+b,0);
    last30Sum = last30.reduce((a,b)=>a+b,0);
    last7UpDays = last7.filter((x)=>x>0).length;
    last7DownDays = last7.filter((x)=>x<0).length;
  }

  let fees30 = 0, fillsCount30 = 0;
  const afterISO = isoDaysAgo(30), untilISO = new Date().toISOString();
  let token = null;
  for (let i = 0; i < 10; i++) {
    const { items, next } = await getActivities({ afterISO, untilISO, pageToken: token });
    for (const it of items) {
      const t = (it?.activity_type || it?.activityType || '').toUpperCase();
      if (t === 'CFEE' || t === 'FEE' || t === 'PTC') {
        const raw = it.net_amount ?? it.amount ?? it.price ?? (Number(it.per_share_amount) * Number(it.qty) || NaN);
        const amt = Number(raw);
        if (Number.isFinite(amt)) fees30 += amt;
      } else if (t === 'FILL') fillsCount30 += 1;
    }
    if (!next) break;
    token = next;
  }
  return { last7Sum, last7UpDays, last7DownDays, last30Sum, fees30, fillsCount30 };
}

/* ====================== 5) MARKET CLOCK (STOCKS) ====================== */
async function getStockClock() {
  try {
    const r = await f(`${ALPACA_BASE_URL}/clock`, { headers: HEADERS });
    if (!r.ok) return { is_open: true };
    const j = await r.json();
    return { is_open: !!j.is_open, next_open: j.next_open, next_close: j.next_close };
  } catch {
    return { is_open: true };
  }
}
let STOCK_CLOCK_CACHE = { value: { is_open: true }, ts: 0 };
async function getStockClockCached(ttlMs = 30000) {
  const now = Date.now();
  if (now - STOCK_CLOCK_CACHE.ts < ttlMs) return STOCK_CLOCK_CACHE.value;
  const v = await getStockClock();
  STOCK_CLOCK_CACHE = { value: v, ts: now };
  return v;
}

/* ============ 6) TRANSACTION HISTORY → CSV VIEWER (UNCHANGED) ============ */
const TxnHistoryCSVViewer = () => {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [csv, setCsv] = useState('');
  const csvRef = useRef(null);

  const BASE_URL = (ALPACA_BASE_URL || 'https://api.alpaca.markets/v2').replace(/\/v2$/, '');
  const ACTIVITIES_URL = `${BASE_URL}/v2/account/activities`;

  async function fetchActivities({ days = 7, types = 'FILL,CFEE,FEE,TRANS,PTC', max = 1000 } = {}) {
    const until = new Date();
    const after = new Date(until.getTime() - days * 864e5);
    const baseParams = new URLSearchParams();
    baseParams.set('direction', 'desc');
    baseParams.set('page_size', '100');
    baseParams.set('activity_types', types);
    baseParams.set('after', after.toISOString());
    baseParams.set('until', until.toISOString());

    let pageToken = null, all = [];
    while (true) {
      const params = new URLSearchParams(baseParams);
      if (pageToken) params.set('page_token', pageToken);
      const res = await fetch(`${ACTIVITIES_URL}?${params.toString()}`, { headers: HEADERS });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Activities HTTP ${res.status}${text ? ` - ${text}` : ''}`);
      }
      const arr = await res.json();
      if (!Array.isArray(arr) || arr.length === 0) break;
      all = all.concat(arr);
      if (all.length >= max) break;
      const last = arr[arr.length - 1];
      if (!last?.id) break;
      pageToken = last.id;
    }
    return all.slice(0, max);
  }

  function toCsv(rows) {
    const header = ['DateTime', 'Type', 'Side', 'Symbol', 'Qty', 'Price', 'CashFlowUSD', 'OrderID', 'ActivityID'];
    const escape = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    for (const r of rows) {
      const dtISO = r.transaction_time || r.date || '';
      const local = dtISO ? new Date(dtISO).toLocaleString() : '';
      const side = r.side || '';
      const symbol = r.symbol || '';
      const qty = r.qty || r.cum_qty || '';
      const price = r.price || '';
      let cash = '';
      if ((r.activity_type || '').toUpperCase() === 'FILL') {
        const q = parseFloat(qty ?? '0');
        const p = parseFloat(price ?? '0');
        if (Number.isFinite(q) && Number.isFinite(p)) {
          const signed = q * p * (side === 'buy' ? -1 : 1);
          cash = signed.toFixed(2);
        }
      } else {
        const net = parseFloat(r.net_amount ?? r.amount ?? '');
        cash = Number.isFinite(net) ? net.toFixed(2) : '';
      }
      const row = [local, r.activity_type, side, symbol, qty, price, cash, r.order_id || '', r.id || ''];
      lines.push(row.map(escape).join(','));
    }
    return lines.join('\n');
  }

  const buildRange = async (days) => {
    try {
      setBusy(true);
      setStatus('Fetching…');
      setCsv('');
      const acts = await fetchActivities({ days });
      if (!acts.length) {
        setStatus('No activities found in range.');
        return;
      }
      const out = toCsv(acts);
      setCsv(out);
      setStatus(`Built ${acts.length} activities (${days}d). Tap the box → Select All → Copy.`);
      setTimeout(() => {
        try {
          csvRef.current?.focus?.();
          csvRef.current?.setNativeProps?.({ selection: { start: 0, end: out.length } });
        } catch {}
      }, 150);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.txnBox}>
      <Text style={styles.txnTitle}>Transaction History → CSV</Text>
      <View style={styles.txnBtnRow}>
        <TouchableOpacity style={styles.txnBtn} onPress={() => buildRange(1)} disabled={busy}>
          <Text style={styles.txnBtnText}>Build 24h CSV</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.txnBtn} onPress={() => buildRange(7)} disabled={busy}>
          <Text style={styles.txnBtnText}>Build 7d CSV</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.txnBtn} onPress={() => buildRange(30)} disabled={busy}>
          <Text style={styles.txnBtnText}>Build 30d CSV</Text>
        </TouchableOpacity>
      </View>
      {busy ? <ActivityIndicator /> : null}
      <Text style={styles.txnStatus}>{status}</Text>
      {csv ? (
        <View style={{ marginTop: 8 }}>
          <Text style={styles.csvHelp}>Tap the box → Select All → Copy</Text>
          <TextInput
            ref={csvRef}
            style={styles.csvBox}
            value={csv}
            editable={false}
            multiline
            selectTextOnFocus
            scrollEnabled
            textBreakStrategy="highQuality"
          />
        </View>
      ) : null}
    </View>
  );
};

/* ======================= 7) STRATEGY / CONSTANTS ======================= */
const FEE_BPS_MAKER = 15;
const FEE_BPS_TAKER = 25;

// Equity fee rails
const EQUITY_SEC_FEE_BPS = 0.35;
const EQUITY_TAF_PER_SHARE = 0.000145;
const EQUITY_TAF_CAP = 7.27;
const EQUITY_COMMISSION_PER_TRADE_USD = 0.0;

// Slip buffers by risk index (0=agg → 4=safe)
const SLIP_BUFFER_BPS_BY_RISK = [2, 4, 6, 8, 10];

// Guards & filters
const STABLES = new Set(['USDTUSD', 'USDCUSD']);
const BLACKLIST = new Set(['SHIBUSD']);
const MIN_PRICE_FOR_TICK_SANE_USD = 1;
const DUST_FLATTEN_MAX_USD = 0.75;
const DUST_SWEEP_MINUTES = 12;
const MIN_BID_SIZE_LOOSE = 1;

// Universe sizes (informational)
const MAX_EQUITIES = 400;
const MAX_CRYPTOS = 400;

const CORE_CRYPTOS = [
  'BTCUSD','ETHUSD','SOLUSD','LTCUSD','BCHUSD','AVAXUSD','ADAUSD','DOGEUSD','XRPUSD','MATICUSD',
  'LINKUSD','ATOMUSD','ETCUSD','TRXUSD','APTUSD','ARBUSD','OPUSD','NEARUSD','TONUSD','DOTUSD','FILUSD',
  'INJUSD','SUIUSD','ICPUSD','RUNEUSD','HBARUSD','ALGOUSD','VETUSD','XLMUSD','MKRUSD','AAVEUSD','UNIUSD',
  'SNXUSD','COMPUSD','LDOUSD','STXUSD','IMXUSD','PEPEUSD','BONKUSD','SEIUSD','PYTHUSD','JUPUSD','JTOUSD',
  'WIFUSD','WLDUSD','ARUSD','FETUSD','RNDRUSD','GRTUSD','SANDUSD','MANAUSD','AXSUSD','GALAUSD','ROSEUSD',
  'CELOUSD','SKLUSD','CHZUSD','ENJUSD','BATUSD','ANKRUSD','1INCHUSD','CRVUSD','BALUSD','YFIUSD','LRCUSD',
  'ZRXUSD','COTIUSD','GMTUSD','GMXUSD','DYDXUSD','FTMUSD','EGLDUSD','KAVAUSD','MINAUSD','XMRUSD','XTZUSD',
  'EOSUSD','WAXPUSD','HNTUSD','FLOWUSD','CFXUSD','KASUSD','TAOUSD','TUSD','AKTUSD','TIAUSD','STRKUSD',
  'UNIUSD','SFPUSD','ROSEUSD','OSMOUSD','DYMUSD','NTRNUSD','ONDOUSD','JASMYUSD','FLUXUSD','BEAMUSD',
  'SAGAUSD','POLUSD','BLURUSD','APEUSD','ARPAUSD','CELRUSD','DASHUSD'
];

/* ==================== 8) STATIC STOCK UNIVERSE (UNCHANGED) ==================== */
const TRAD_100 = [
  'AAPL','MSFT','NVDA','AMZN','META','GOOGL','GOOG','AVGO','TSLA','BRK.B','LLY','UNH','JPM','JNJ','V','MA','XOM','WMT','PG','HD','ORCL','COST','BAC','MRK','PEP','KO','ADBE','CSCO','CRM','NFLX','TMO','ACN','AXP','DHR','MCD','AMD','CMCSA','ABT','PFE','IBM','WFC','CAT','HON','TXN','LIN','INTU','AMAT','GE','NKE','MDT','PM','QCOM','COP','LOW','SPGI','BMY','UPS','GILD','PLD','RTX','NOW','ELV','ADP','C','DE','T','REGN','SBUX','BKNG','SHOP','MU','LMT','CHTR','PGR','USB','SO','BLK','CB','HCA','AON','EOG','MDLZ','EQIX','CI','MMC','TGT','PANW','KLAC','LRCX','MAR','SNPS','CDNS','KHC','DUK','FDX','GM','GS','MS','CVS','NEE',
];
const CRYPTO_STOCKS_100 = [
  'COIN','MSTR','MARA','RIOT','CLSK','HUT','HIVE','BITF','BTBT','CIFR','WULF','IREN','CORZ','BTDR','SDIG','GREE','ANY','MIGI','DGHI','ARBK','APLD','BKKT','BTM','IBIT','FBTC','ARKB','GBTC','BITB','HODL','BTCO','BRRR','DEFI','BTCW','EZBC','XBTF','BTF','BITO','BITI','BKCH','BLOK','BLCN','DAPP','RIGZ','WGMI','BITQ','KOIN','SATO','CME','CBOE','NDAQ','ICE','IBKR','SQ','PYPL','SOFI','HOOD','NU','MELI','BYON','BTCS','CAN','EBON','NCTY','SOS','TSM','ASML','ARM','MRVL','NXPI','ON','COHR','GFS','HPE','IRM','PAYO','AFRM','UPST','LC','NVEI','GPN','FIS','FI','FOUR','RPAY','MQ','STNE','PAGS','BK','ARKW','SPBC','CRPT','OPRA','DLO','MOGO','NET','V','MA','NVDA','AMD','GOOG',
];
const STATIC_UNIVERSE = Array.from(
  new Map([...TRAD_100, ...CRYPTO_STOCKS_100].map((s) => [s, { name: s, symbol: s, cc: null }])).values()
);

/* =========================== 9) LIVE-ONLY HELPERS =========================== */
const QUOTE_TTL_MS = 4000; // cache for network pressure (still use exchange timestamp for freshness)
const quoteCache = new Map();

const unsupportedSymbols = new Map();
const isUnsupported = (sym) => {
  const u = unsupportedSymbols.get(sym);
  if (!u) return false;
  if (Date.now() > u) { unsupportedSymbols.delete(sym); return false; }
  return true;
};
function markUnsupported(sym, mins = 120) { unsupportedSymbols.set(sym, Date.now() + mins * 60000); }

function toDataSymbol(sym) {
  if (!sym) return sym;
  if (sym.includes('/')) return sym;
  if (sym.endsWith('USD')) return sym.slice(0, -3) + '/USD';
  return sym;
}
function isCrypto(sym) { return /USD$/.test(sym); }
function isStock(sym) { return !isCrypto(sym); }

const parseTsMs = (t) => {
  if (t == null) return NaN;
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
    const n = +t;
    if (Number.isFinite(n)) {
      if (n > 1e15) return Math.floor(n / 1e6); // ns → ms
      if (n > 1e12) return Math.floor(n / 1e3); // μs → ms
      if (n > 1e10) return n;                    // already ms
      if (n > 1e9)  return n * 1000;            // s → ms
    }
    return NaN;
  }
  if (typeof t === 'number') {
    if (t > 1e15) return Math.floor(t / 1e6);
    if (t > 1e12) return Math.floor(t / 1e3);
    if (t > 1e10) return t;
    if (t > 1e9)  return t * 1000;
    return t; // assume ms
  }
  return NaN;
};
const isFresh = (tsMs, ttlMs) => {
  if (!Number.isFinite(tsMs)) return true; // if Alpaca omits t, assume live for this response
  return Date.now() - tsMs <= ttlMs;
};

/* ===== Alpaca Crypto: quotes/trades/bars (LIVE) ===== */
const buildURLCrypto = (loc, what, symbolsCSV, params = {}) => {
  const encoded = symbolsCSV.split(',').map((s) => encodeURIComponent(s)).join(',');
  const sp = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null) sp.set(k, v); });
  const qs = sp.toString();
  return `${DATA_ROOT_CRYPTO}/${loc}/latest/${what}?symbols=${encoded}${qs ? '&' + qs : ''}`;
};

async function getCryptoQuotesBatch(dsyms = []) {
  if (!dsyms.length) return new Map();
  // try us → global
  for (const loc of DATA_LOCATIONS) {
    try {
      const url = buildURLCrypto(loc, 'quotes', dsyms.join(','));
      const r = await f(url, { headers: HEADERS });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      const raw = j?.quotes || {};
      const out = new Map();
      for (const dsym of dsyms) {
        const q = Array.isArray(raw[dsym]) ? raw[dsym][0] : raw[dsym];
        if (!q) continue;
        const bid = Number(q.bp ?? q.bid_price);
        const ask = Number(q.ap ?? q.ask_price);
        const bs = Number(q.bs ?? q.bid_size);
        const as = Number(q.as ?? q.ask_size);
        const tms = parseTsMs(q.t);
        if (bid > 0 && ask > 0) {
          out.set(dsym, { bid, ask, bs: Number.isFinite(bs) ? bs : null, as: Number.isFinite(as) ? as : null, tms });
        }
      }
      if (out.size) return out;
    } catch {}
  }
  return new Map();
}
async function getCryptoTradesBatch(dsyms = []) {
  if (!dsyms.length) return new Map();
  for (const loc of DATA_LOCATIONS) {
    try {
      const url = buildURLCrypto(loc, 'trades', dsyms.join(','));
      const r = await f(url, { headers: HEADERS });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      const raw = j?.trades || {};
      const out = new Map();
      for (const dsym of dsyms) {
        const t = Array.isArray(raw[dsym]) ? raw[dsym][0] : raw[dsym];
        const p = Number(t?.p ?? t?.price);
        const tms = parseTsMs(t?.t);
        if (Number.isFinite(p) && p > 0) out.set(dsym, { price: p, tms });
      }
      if (out.size) return out;
    } catch {}
  }
  return new Map();
}
async function getCryptoBars1m(symbol, limit = 6) {
  // /crypto/{loc}/bars?timeframe=1Min&limit=6&symbols=BTC/USD
  const dsym = toDataSymbol(symbol);
  for (const loc of DATA_LOCATIONS) {
    try {
      const sp = new URLSearchParams({ timeframe: '1Min', limit: String(limit), symbols: dsym });
      const url = `${DATA_ROOT_CRYPTO}/${loc}/bars?${sp.toString()}`;
      const r = await f(url, { headers: HEADERS });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      const arr = j?.bars?.[dsym];
      if (Array.isArray(arr) && arr.length) {
        return arr.map((b) => ({
          open: Number(b.o ?? b.open),
          high: Number(b.h ?? b.high),
          low: Number(b.l ?? b.low),
          close: Number(b.c ?? b.close),
          vol: Number(b.v ?? b.volume ?? 0),
          tms: parseTsMs(b.t),
        })).filter((x) => Number.isFinite(x.close) && x.close > 0);
      }
    } catch {}
  }
  return [];
}

/* ===== Alpaca Stocks: quotes/trades/bars (LIVE) ===== */
async function stocksLatestQuotesBatch(symbols = []) {
  if (!symbols.length) return new Map();
  const csv = symbols.join(',');
  try {
    const r = await f(`${DATA_ROOT_STOCKS_V2}/quotes/latest?symbols=${encodeURIComponent(csv)}`, { headers: HEADERS });
    if (!r.ok) return new Map();
    const j = await r.json().catch(() => null);
    const out = new Map();
    for (const sym of symbols) {
      const qraw = j?.quotes?.[sym];
      const q = Array.isArray(qraw) ? qraw[0] : qraw;
      if (!q) continue;
      const bid = Number(q.bp ?? q.bid_price);
      const ask = Number(q.ap ?? q.ask_price);
      const bs = Number(q.bs ?? q.bid_size);
      const as = Number(q.as ?? q.ask_size);
      const tms = parseTsMs(q.t);
      if (bid > 0 && ask > 0) out.set(sym, { bid, ask, bs: Number.isFinite(bs) ? bs : null, as: Number.isFinite(as) ? as : null, tms });
    }
    return out;
  } catch {
    return new Map();
  }
}
async function stocksLatestTrade(symbol) {
  try {
    const r = await f(`${DATA_ROOT_STOCKS_V2}/trades/latest?symbols=${encodeURIComponent(symbol)}`, { headers: HEADERS });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const t = j?.trades?.[symbol] || j?.trades?.[symbol]?.[0] || null;
    const p = Number(t?.p ?? t?.price);
    const tms = parseTsMs(t?.t);
    return Number.isFinite(p) && p > 0 ? { price: p, tms } : null;
  } catch { return null; }
}
async function stocksBars1m(symbols = [], limit = 6) {
  if (!symbols.length) return new Map();
  const sp = new URLSearchParams({ timeframe: '1Min', limit: String(limit), symbols: symbols.join(',') });
  try {
    const r = await f(`${DATA_ROOT_STOCKS_V2}/bars?${sp.toString()}`, { headers: HEADERS });
    if (!r.ok) return new Map();
    const j = await r.json().catch(() => null);
    const raw = j?.bars || {};
    const out = new Map();
    for (const s of symbols) {
      const arr = raw[s];
      if (Array.isArray(arr) && arr.length) {
        out.set(s, arr.map((b) => ({
          open: Number(b.o ?? b.open),
          high: Number(b.h ?? b.high),
          low: Number(b.l ?? b.low),
          close: Number(b.c ?? b.close),
          vol: Number(b.v ?? b.volume ?? 0),
          tms: parseTsMs(b.t),
        })));
      }
    }
    return out;
  } catch { return new Map(); }
}

/* ========================= 10) UTILITIES ========================= */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const fmtUSD = (n) =>
  Number.isFinite(n)
    ? `$ ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
const fmtPct = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}%` : '—');
function halfFromBps(price, bps) { return (bps / 20000) * price; }
const emaArr = (arr, span) => {
  if (!arr?.length) return [];
  const k = 2 / (span + 1);
  let prev = arr[0];
  const out = [prev];
  for (let i = 1; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
};
const roundToTick = (px, tick) => Math.ceil(px / tick) * tick;
const isFractionalQty = (q) => Math.abs(q - Math.round(q)) > 1e-6;

/* ========================= 11) FEE / PNL MODEL ========================= */
function feeModelFor(symbol) {
  if (isStock(symbol)) {
    return {
      cls: 'equity',
      buyBps: 0,
      sellBps: EQUITY_SEC_FEE_BPS,
      tafPerShare: EQUITY_TAF_PER_SHARE,
      tafCap: EQUITY_TAF_CAP,
      commissionUSD: EQUITY_COMMISSION_PER_TRADE_USD,
      tick: 0.01,
    };
  }
  return {
    cls: 'crypto',
    buyBps: FEE_BPS_MAKER,
    sellBps: FEE_BPS_TAKER,
    tafPerShare: 0,
    tafCap: 0,
    commissionUSD: 0,
    tick: 1e-5,
  };
}
function perShareFeeOnBuy(entryPx, model) { return entryPx * (model.buyBps / 10000); }
function perShareFixedOnSell(qty, model) {
  if (model.cls !== 'equity') return 0;
  const fixed = Math.min(model.tafPerShare * qty, model.tafCap) + model.commissionUSD;
  return fixed / Math.max(1, qty);
}
function minExitPriceFeeAware({ symbol, entryPx, qty }) {
  const model = feeModelFor(symbol);
  const notional = qty * entryPx;
  const dynUsd = Math.max(SETTINGS.netMinProfitUSDBase, (SETTINGS.netMinProfitPct / 100) * notional);
  const usdMinPerShare = dynUsd / Math.max(1, qty);
  const bpsMinPerShare = (SETTINGS.netMinProfitBps / 10000) * entryPx;
  const minNetPerShare = Math.max(SETTINGS.netMinProfitUSD, usdMinPerShare, bpsMinPerShare);
  const buyFeePS = perShareFeeOnBuy(entryPx, model);
  const fixedSellPS = perShareFixedOnSell(qty, model);
  const sellBpsFrac = model.sellBps / 10000;
  const raw = (entryPx + buyFeePS + fixedSellPS + minNetPerShare) / Math.max(1e-9, 1 - sellBpsFrac);
  return roundToTick(raw, model.tick);
}
function projectedNetPnlUSD({ symbol, entryPx, qty, sellPx }) {
  const m = feeModelFor(symbol);
  const buyFeesUSD = qty * perShareFeeOnBuy(entryPx, m);
  const sellFeesUSD =
    qty * sellPx * (m.sellBps / 10000) +
    (m.cls === 'equity'
      ? Math.min(m.tafPerShare * qty, m.tafCap) + m.commissionUSD
      : 0);
  return sellPx * qty - sellFeesUSD - entryPx * qty - buyFeesUSD;
}
function meetsMinProfit({ symbol, entryPx, qty, sellPx }) {
  if (!(entryPx > 0) || !(qty > 0) || !(sellPx > 0)) return false;
  const net = projectedNetPnlUSD({ symbol, entryPx, qty, sellPx });
  const notional = qty * entryPx;
  const dynUsd = Math.max(SETTINGS.netMinProfitUSDBase, (SETTINGS.netMinProfitPct / 100) * notional);
  const minUsd = Math.max(SETTINGS.netMinProfitUSD, dynUsd);
  const feeFloor = minExitPriceFeeAware({ symbol, entryPx, qty });
  return net >= minUsd && sellPx >= feeFloor * (1 - 1e-6);
}

/* ============================ 12) LOGGING ============================ */
let logSubscriber = null, logBuffer = [];
const MAX_LOGS = 200;
export const registerLogSubscriber = (fn) => { logSubscriber = fn; };
const logTradeAction = async (type, symbol, details = {}) => {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, type, symbol, ...details };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  if (typeof logSubscriber === 'function') {
    try { logSubscriber(entry); } catch {}
  }
};
const FRIENDLY = {
  quote_ok: { sev: 'info', msg: (d) => `Quote OK (${(d.spreadBps ?? 0).toFixed(1)} bps)` },
  quote_http_error: { sev: 'warn', msg: (d) => `Alpaca quotes ${d.status}${d.loc ? ' • ' + d.loc : ''}${d.body ? ' • ' + d.body : ''}` },
  trade_http_error: { sev: 'warn', msg: (d) => `Alpaca trades ${d.status}${d.loc ? ' • ' + d.loc : ''}` },
  unsupported_symbol: { sev: 'warn', msg: (d) => `Unsupported symbol: ${d.sym}` },
  buy_camped: { sev: 'info', msg: (d) => `Camping bid @ ${d.limit}` },
  buy_replaced: { sev: 'info', msg: (d) => `Replaced bid → ${d.limit}` },
  buy_success: { sev: 'success', msg: (d) => `BUY filled qty ${d.qty} @≤${d.limit}` },
  buy_unfilled_canceled: { sev: 'warn', msg: () => `BUY unfilled — canceled bid` },
  tp_limit_set: { sev: 'success', msg: (d) => `TP set @ ${d.limit}` },
  tp_limit_error: { sev: 'error', msg: (d) => `TP set error: ${d.error}` },
  scan_start: { sev: 'info', msg: (d) => `Scan start (batch ${d.batch})` },
  scan_summary: { sev: 'info', msg: (d) => `Scan: ready ${d.readyCount} / attempts ${d.attemptCount} / fills ${d.successCount}` },
  scan_error: { sev: 'error', msg: (d) => `Scan error: ${d.error}` },
  skip_wide_spread: { sev: 'warn', msg: (d) => `Skip: spread ${d.spreadBps} bps > max` },
  skip_small_order: { sev: 'warn', msg: () => `Skip: below min notional or funding` },
  entry_skipped: { sev: 'info', msg: (d) => `Entry ${d.entryReady ? 'ready' : 'not ready'}${d.reason ? ' — ' + d.reason : ''}` },
  risk_changed: { sev: 'info', msg: (d) => `Risk→${d.level} (spread≤${d.spreadMax}bps)` },
  concurrency_guard: { sev: 'warn', msg: (d) => `Concurrency guard: cap ${d.cap} @ avg ${d.avg?.toFixed?.(1) ?? d.avg} bps` },
  skip_blacklist: { sev: 'warn', msg: () => `Skip: blacklisted` },
  coarse_tick_skip: { sev: 'warn', msg: () => `Skip: coarse-tick/sub-$0.05` },
  dust_flattened: { sev: 'info', msg: (d) => `Dust flattened (${d.usd?.toFixed?.(2) ?? d.usd} USD)` },
  tp_touch_tick: { sev: 'info', msg: (d) => `Touch tick ${d.count}/${SETTINGS.touchTicksRequired} @bid≈${d.bid?.toFixed?.(5) ?? d.bid}` },
  tp_fee_floor: { sev: 'info', msg: (d) => `FeeGuard raised TP → ${d.limit}` },
  taker_blocked_fee: { sev: 'warn', msg: () => `Blocked taker exit (profit floor unmet)` },
  stop_arm: { sev: 'info', msg: (d) => `Stop armed @ ${d.stopPx.toFixed?.(5) ?? d.stopPx}${d.hard ? ' (HARD)' : ''}` },
  stop_update: { sev: 'info', msg: (d) => `Stop update → ${d.stopPx.toFixed?.(5) ?? d.stopPx}` },
  stop_exit: { sev: 'warn', msg: (d) => `STOP EXIT @~${d.atPx?.toFixed?.(5) ?? d.atPx}` },
  trail_start: { sev: 'info', msg: (d) => `Trail start ≥ ${d.startPx.toFixed?.(5) ?? d.startPx}` },
  trail_peak: { sev: 'info', msg: (d) => `Trail peak → ${d.peakPx.toFixed?.(5) ?? d.peakPx}` },
  trail_exit: { sev: 'success', msg: (d) => `TRAIL EXIT @~${d.atPx?.toFixed?.(5) ?? d.atPx}` },
  daily_halt: { sev: 'error', msg: (d) => `TRADING HALTED — ${d.reason}` },
  pdt_guard: { sev: 'warn', msg: (d) => `PDT guard: ${d.reason || 'equity_scan_disabled'} (eq=${d.eq ?? '?'}, trades=${d.dt ?? '?'})` },

  // Health
  health_ok: { sev: 'success', msg: (d) => `Health OK (${d.section})` },
  health_warn: { sev: 'warn', msg: (d) => `Health WARN (${d.section}) — ${d.note || ''}` },
  health_err: { sev: 'error', msg: (d) => `Health ERROR (${d.section}) — ${d.note || ''}` },
};
function friendlyLog(entry) {
  const meta = FRIENDLY[entry.type];
  if (!meta)
    return { sev: 'info', text: `${entry.type}${entry.symbol ? ' ' + entry.symbol : ''}`, hint: null };
  const text = typeof meta.msg === 'function' ? meta.msg(entry) : meta.msg;
  return { sev: meta.sev, text: `${entry.symbol ? entry.symbol + ' — ' : ''}${text}`, hint: null };
}

/* ====================== 13) QUOTES/BARS BATCH (LIVE ONLY) ====================== */
const PRICE_HIST = new Map();
function pushPriceHist(sym, mid, max = 6) {
  if (!Number.isFinite(mid)) return;
  const arr = PRICE_HIST.get(sym) || [];
  arr.push(mid);
  if (arr.length > max) arr.shift();
  PRICE_HIST.set(sym, arr);
}

async function getQuotesBatch(symbols) {
  const cryptos = symbols.filter((s) => isCrypto(s));
  const stocks = symbols.filter((s) => isStock(s));
  const out = new Map();
  const now = Date.now();

  // Crypto (LIVE quotes only)
  if (cryptos.length) {
    const dsyms = Array.from(new Set(cryptos.map((s) => toDataSymbol(s)))).filter((dsym) => !isUnsupported(dsym.replace('/', '')));
    for (let i = 0; i < dsyms.length; i += 6) {
      const slice = dsyms.slice(i, i + 6);
      let qmap = await getCryptoQuotesBatch(slice);
      for (const dsym of slice) {
        const q = qmap.get(dsym);
        if (!q) continue;
        const fresh = isFresh(q.tms, SETTINGS.liveFreshMsCrypto);
        if (!fresh) continue;
        const sym = dsym.replace('/', '');
        out.set(sym, { bid: q.bid, ask: q.ask, bs: q.bs, as: q.as, tms: q.tms });
        quoteCache.set(sym, { ts: now, q: { bid: q.bid, ask: q.ask, bs: q.bs, as: q.as } });
      }
    }
  }

  // Stocks (LIVE quotes only)
  if (stocks.length) {
    const qmap = await stocksLatestQuotesBatch(stocks);
    for (const s of stocks) {
      const q = qmap.get(s);
      if (!q) continue;
      const fresh = isFresh(q.tms, SETTINGS.liveFreshMsStock);
      if (!fresh) continue;
      out.set(s, { bid: q.bid, ask: q.ask, bs: q.bs, as: q.as, tms: q.tms });
      quoteCache.set(s, { ts: now, q: { bid: q.bid, ask: q.ask, bs: q.bs, as: q.as } });
    }
  }
  return out;
}

/* ======================= 14) SMART QUOTE (LIVE ONLY) ======================= */
async function getQuoteSmart(symbol, preloadedMap = null) {
  try {
    if (isUnsupported(symbol)) return null;
    if (preloadedMap && preloadedMap.has(symbol)) return preloadedMap.get(symbol);
    const c = quoteCache.get(symbol);
    if (c && Date.now() - c.ts < QUOTE_TTL_MS) return c.q;

    if (isStock(symbol)) {
      const m = await stocksLatestQuotesBatch([symbol]);
      const q = m.get(symbol);
      if (q && isFresh(q.tms, SETTINGS.liveFreshMsStock)) {
        quoteCache.set(symbol, { ts: Date.now(), q });
        return q;
      }
      return null;
    }

    // crypto
    const dsym = toDataSymbol(symbol);
    const m = await getCryptoQuotesBatch([dsym]);
    const q = m.get(dsym);
    if (q && isFresh(q.tms, SETTINGS.liveFreshMsCrypto)) {
      const qObj = { bid: q.bid, ask: q.ask, bs: q.bs, as: q.as };
      quoteCache.set(symbol, { ts: Date.now(), q: qObj });
      return qObj;
    }
    return null;
  } catch {
    return null;
  }
}

/* ===================== 15) ENTRY MATH / SIGNALS ===================== */
const SPREAD_EPS_BPS = 0.3;
const exitFloorBps = (symbol) => (isStock(symbol) ? 1.0 : FEE_BPS_MAKER + FEE_BPS_TAKER);
function requiredProfitBpsForSymbol(symbol, riskLevel) {
  const slip = SLIP_BUFFER_BPS_BY_RISK[riskLevel] ?? SLIP_BUFFER_BPS_BY_RISK[0];
  return exitFloorBps(symbol) + 0.5 + slip;
}

/* ======================== 16) ACCOUNT / ORDERS ======================== */
const getPositionInfo = async (symbol) => {
  try {
    const res = await f(`${ALPACA_BASE_URL}/positions/${symbol}`, { headers: HEADERS });
    if (!res.ok) return null;
    const info = await res.json();
    const qty = parseFloat(info.qty ?? '0');
    const available = parseFloat(info.qty_available ?? info.available ?? info.qty ?? '0');
    const marketValue = parseFloat(info.market_value ?? info.marketValue ?? 'NaN');
    const markFromMV = Number.isFinite(marketValue) && qty > 0 ? marketValue / qty : NaN;
    const markFallback = parseFloat(info.current_price ?? info.asset_current_price ?? 'NaN');
    const mark = Number.isFinite(markFromMV) ? markFromMV : Number.isFinite(markFallback) ? markFallback : NaN;
    const basis = parseFloat(info.avg_entry_price ?? 'NaN');
    return {
      qty: +(qty || 0),
      available: +(available || 0),
      basis: Number.isFinite(basis) ? basis : null,
      mark: Number.isFinite(mark) ? mark : null,
      marketValue: Number.isFinite(marketValue) ? marketValue : 0,
    };
  } catch { return null; }
};
const getAllPositions = async () => {
  try {
    const r = await f(`${ALPACA_BASE_URL}/positions`, { headers: HEADERS });
    if (!r.ok) return [];
    const arr = await r.json();
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
};
const getOpenOrders = async () => {
  try {
    const r = await f(`${ALPACA_BASE_URL}/orders?status=open&nested=true&limit=100`, { headers: HEADERS });
    if (!r.ok) return [];
    const arr = await r.json();
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
};
const cancelOpenOrdersForSymbol = async (symbol, side = null) => {
  try {
    const open = await getOpenOrders();
    const targets = (open || []).filter(
      (o) => o.symbol === symbol && (!side || (o.side || '').toLowerCase() === String(side).toLowerCase())
    );
    await Promise.all(
      targets.map((o) =>
        f(`${ALPACA_BASE_URL}/orders/${o.id}`, { method: 'DELETE', headers: HEADERS }).catch(() => null)
      )
    );
  } catch {}
};
const cancelAllOrders = async () => {
  try {
    const orders = await getOpenOrders();
    await Promise.all((orders || []).map((o) => f(`${ALPACA_BASE_URL}/orders/${o.id}`, { method: 'DELETE', headers: HEADERS }).catch(() => null)));
  } catch {}
};

async function getAccountSummaryRaw() {
  const res = await f(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Account ${res.status}`);
  const a = await res.json();
  const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : NaN; };

  const equity = num(a.equity ?? a.portfolio_value);
  const candidates = [num(a.buying_power), num(a.crypto_buying_power), num(a.non_marginable_buying_power), num(a.cash)];
  const firstPositive = candidates.find((v) => Number.isFinite(v) && v > 0);
  const buyingPower = Number.isFinite(firstPositive) ? firstPositive : candidates.find(Number.isFinite) ?? NaN;

  const prevClose = num(a.equity_previous_close);
  const lastEq = num(a.last_equity);
  const ref = Number.isFinite(prevClose) ? prevClose : lastEq;
  const changeUsd = Number.isFinite(equity) && Number.isFinite(ref) ? equity - ref : NaN;
  const changePct = Number.isFinite(changeUsd) && ref > 0 ? (changeUsd / ref) * 100 : NaN;

  const patternDayTrader = !!a.pattern_day_trader;
  const daytradeCount = Number.isFinite(+a.daytrade_count) ? +a.daytrade_count : null;

  return { equity, buyingPower, changeUsd, changePct, patternDayTrader, daytradeCount };
}

function capNotional(symbol, proposed, equity) {
  const hardCap = SETTINGS.absMaxNotionalUSD;
  const perSymbolDynCap = (SETTINGS.maxPosPctEquity / 100) * equity;
  return Math.max(0, Math.min(proposed, hardCap, perSymbolDynCap));
}
async function cleanupStaleBuyOrders(maxAgeSec = 30) {
  try {
    const [open, positions] = await Promise.all([getOpenOrders(), getAllPositions()]);
    const held = new Set((positions || []).map((p) => p.symbol));
    const now = Date.now();
    const tooOld = (o) => {
      const t = Date.parse(o.submitted_at || o.created_at || o.updated_at || '');
      if (!Number.isFinite(t)) return false;
      return (now - t) / 1000 > maxAgeSec;
    };
    const stale = (open || []).filter(
      (o) => (o.side || '').toLowerCase() === 'buy' && !held.has(o.symbol) && tooOld(o)
    );
    await Promise.all(
      stale.map(async (o) => {
        await f(`${ALPACA_BASE_URL}/orders/${o.id}`, { method: 'DELETE', headers: HEADERS }).catch(() => null);
      })
    );
  } catch {}
}

/* ============= 17) STATS / HALT STATE ============= */
const symStats = {};
const ewma = (prev, x, a = 0.2) => (Number.isFinite(prev) ? a * x + (1 - a) * prev : x);
function pushMFE(sym, mfe, maxKeep = 120) {
  const s = symStats[sym] || (symStats[sym] = { mfeHist: [], hitByHour: Array.from({ length: 24 }, () => ({ h: 0, t: 0 })) });
  s.mfeHist.push(mfe);
  if (s.mfeHist.length > maxKeep) s.mfeHist.shift();
}
let TRADING_HALTED = false;
let HALT_REASON = '';
function shouldHaltTrading(changePct) {
  if (!Number.isFinite(changePct)) return false;
  if (SETTINGS.haltOnDailyLoss && changePct <= -Math.abs(SETTINGS.dailyMaxLossPct)) {
    HALT_REASON = `Daily loss ${changePct.toFixed(2)}% ≤ -${Math.abs(SETTINGS.dailyMaxLossPct)}%`;
    return true;
  }
  if (SETTINGS.haltOnDailyProfit && changePct >= Math.abs(SETTINGS.dailyProfitTargetPct)) {
    HALT_REASON = `Daily profit ${changePct.toFixed(2)}% ≥ ${Math.abs(SETTINGS.dailyProfitTargetPct)}%`;
    return true;
  }
  return false;
}

/* ====== Dynamic crypto universe from Alpaca assets (+ core fallback) ====== */
async function fetchCryptoUniverseFromAssets() {
  const core = CORE_CRYPTOS
    .filter((s) => !STABLES.has(s) && !BLACKLIST.has(s))
    .map((s) => ({ name: s, symbol: s, cc: s.replace('USD', '') }));
  try {
    const url = `${ALPACA_BASE_URL}/assets?asset_class=crypto&status=active`;
    const res = await f(url, { headers: HEADERS });
    let arr = [];
    if (res.ok) arr = await res.json().catch(() => []);
    else {
      logTradeAction('scan_error', 'UNIVERSE', { error: `assets ${res.status} → using core (${core.length})` });
      const uniq = new Map(core.map((x) => [x.symbol, x]));
      return Array.from(uniq.values());
    }
    const fromAssets = (Array.isArray(arr) ? arr : [])
      .filter((a) => typeof a?.symbol === 'string')
      .map((a) => {
        const raw = a.symbol.toUpperCase();
        const norm = raw.includes('/') ? raw.replace('/', '') : raw;
        return { name: norm, symbol: norm, cc: norm.replace('USD', '') };
      })
      .filter((x) => x.symbol.endsWith('USD'))
      .filter((x) => !STABLES.has(x.symbol) && !BLACKLIST.has(x.symbol));

    // CHANGED: Use ONLY Alpaca's active assets when the API succeeds.
    const out = fromAssets;
    logTradeAction('scan_start', 'CRYPTO_UNIVERSE', { count: out.length, fromAssets: fromAssets.length, fromCore: 0 });
    return out;
  } catch (e) {
    logTradeAction('scan_error', 'UNIVERSE', { error: `Assets error → using core (${core.length})` });
    const uniq = new Map(core.map((x) => [x.symbol, x]));
    return Array.from(uniq.values());
  }
}

/* ============================ 18) APP ROOT ============================ */
export default function App() {
  // state
  const [tracked, setTracked] = useState(STATIC_UNIVERSE);
  const [univUpdatedAt, setUnivUpdatedAt] = useState(new Date().toISOString());
  const [data, setData] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [darkMode] = useState(true);
  const autoTrade = true;
  const [notification, setNotification] = useState(null);
  const [logHistory, setLogHistory] = useState([]);

  const [isUpdatingAcct, setIsUpdatingAcct] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [acctSummary, setAcctSummary] = useState({
    portfolioValue: null, buyingPower: null, dailyChangeUsd: null, dailyChangePct: null,
    patternDayTrader: null, daytradeCount: null, updatedAt: null
  });
  const [pnlSnap, setPnlSnap] = useState({ last7Sum: null, last7UpDays: null, last7DownDays: null, last30Sum: null, fees30: null, fillsCount30: null, updatedAt: null, error: null });

  const [lastScanAt, setLastScanAt] = useState(null);
  const [openMeta, setOpenMeta] = useState({ positions: 0, orders: 0, allowed: STATIC_UNIVERSE.length, universe: STATIC_UNIVERSE.length });
  const [scanStats, setScanStats] = useState({ ready: 0, attempted: 0, filled: 0, watch: 0, skipped: 0, reasons: {} });

  const [settings, setSettings] = useState({ ...SETTINGS });
  useEffect(() => {
    SETTINGS = { ...settings };
    logTradeAction('risk_changed', 'SETTINGS', { level: SETTINGS.riskLevel, spreadMax: SETTINGS.spreadMaxBps });
  }, [settings]);
  const [showSettings, setShowSettings] = useState(false);

  const [health, setHealth] = useState({ checkedAt: null, sections: {} });

  const scanningRef = useRef(false);
  const tradeStateRef = useRef({});
  const globalSpreadAvgRef = useRef(18);
  const touchMemoRef = useRef({});
  const stockPageRef = useRef(0);
  const cryptoPageRef = useRef(0);

  const lastAcctFetchRef = useRef(0);
  const getAccountSummaryThrottled = async (minMs = 30000) => {
    const now = Date.now();
    if (now - lastAcctFetchRef.current < minMs) return;
    lastAcctFetchRef.current = now;
    await getAccountSummary();
  };

  // logging hookup
  useEffect(() => {
    registerLogSubscriber((entry) => {
      const f = friendlyLog(entry);
      setLogHistory((prev) => [{ ts: entry.timestamp, sev: f.sev, text: f.text, hint: null }, ...prev].slice(0, 22));
    });
    const seed = logBuffer
      .slice(-14)
      .reverse()
      .map((e) => {
        const f = friendlyLog(e);
        return { ts: e.timestamp, sev: f.sev, text: f.text, hint: null };
      });
    if (seed.length) setLogHistory(seed);
  }, []);
  const showNotification = (msg) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 5000);
  };

  // On mount: dynamic crypto universe + static equities
  useEffect(() => {
    (async () => {
      const stockSide = STATIC_UNIVERSE.filter((t) => isStock(t.symbol));
      const cryptoSide = await fetchCryptoUniverseFromAssets();
      const combined = [...stockSide, ...cryptoSide];
      setTracked(combined);
      setUnivUpdatedAt(new Date().toISOString());
      setOpenMeta((m) => ({ ...m, universe: combined.length, allowed: combined.length }));
      logTradeAction('scan_start', 'UNIVERSE', { batch: combined.length, stocks: stockSide.length, cryptos: combined.length - stockSide.length });
    })();
  }, []);

  const getAccountSummary = async () => {
    setIsUpdatingAcct(true);
    try {
      const a = await getAccountSummaryRaw();
      setAcctSummary({
        portfolioValue: a.equity, buyingPower: a.buyingPower, dailyChangeUsd: a.changeUsd, dailyChangePct: a.changePct,
        patternDayTrader: a.patternDayTrader, daytradeCount: a.daytradeCount, updatedAt: new Date().toISOString()
      });
      if (shouldHaltTrading(a.changePct, a.equity)) {
        TRADING_HALTED = true;
        logTradeAction('daily_halt', 'SYSTEM', { reason: HALT_REASON });
        showNotification(`⛔ Trading halted: ${HALT_REASON}`);
      } else {
        TRADING_HALTED = false;
      }
    } catch (e) {
      logTradeAction('quote_exception', 'ACCOUNT', { error: e.message });
    } finally { setIsUpdatingAcct(false); }
  };

  /* -------------------- Health check (account + quotes) -------------------- */
  async function checkAlpacaHealth() {
    const report = { checkedAt: new Date().toISOString(), sections: {} };
    try {
      const accRes = await f(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
      if (accRes.ok) {
        report.sections.account = { ok: true };
        logTradeAction('health_ok', 'SYSTEM', { section: 'account' });
      } else {
        const body = await accRes.text().catch(() => '');
        report.sections.account = { ok: false, code: accRes.status, note: body?.slice(0, 120) };
        logTradeAction('health_err', 'SYSTEM', { section: 'account', note: `${accRes.status}` });
      }
    } catch (e) {
      report.sections.account = { ok: false, note: e.message };
      logTradeAction('health_err', 'SYSTEM', { section: 'account', note: e.message });
    }

    // Stocks quotes test
    try {
      const m = await stocksLatestQuotesBatch(['AAPL','MSFT']);
      const a = m.get('AAPL'), b = m.get('MSFT');
      const freshA = !!a && isFresh(a.tms, SETTINGS.liveFreshMsStock);
      const freshB = !!b && isFresh(b.tms, SETTINGS.liveFreshMsStock);
      report.sections.stocks = { ok: !!(freshA || freshB), detail: { AAPL: !!freshA, MSFT: !!freshB } };
      logTradeAction(freshA || freshB ? 'health_ok' : 'health_warn', 'SYSTEM', { section: 'stocks', note: freshA || freshB ? '' : 'no fresh quotes' });
    } catch (e) {
      report.sections.stocks = { ok: false, note: e.message };
      logTradeAction('health_err', 'SYSTEM', { section: 'stocks', note: e.message });
    }

    // Crypto quotes test (us→global)
    try {
      const m = await getCryptoQuotesBatch(['BTC/USD','ETH/USD']);
      const bt = m.get('BTC/USD'), et = m.get('ETH/USD');
      const freshB = !!bt && isFresh(bt.tms, SETTINGS.liveFreshMsCrypto);
      const freshE = !!et && isFresh(et.tms, SETTINGS.liveFreshMsCrypto);
      report.sections.crypto = { ok: !!(freshB || freshE), detail: { 'BTC/USD': !!freshB, 'ETH/USD': !!freshE } };
      logTradeAction(freshB || freshE ? 'health_ok' : 'health_warn', 'SYSTEM', { section: 'crypto', note: freshB || freshE ? '' : 'no fresh quotes' });
    } catch (e) {
      report.sections.crypto = { ok: false, note: e.message };
      logTradeAction('health_err', 'SYSTEM', { section: 'crypto', note: e.message });
    }

    setHealth(report);
  }

  /* -------------------- Outcome monitor (LIVE trades) -------------------- */
  async function monitorOutcome(symbol, entryPx, v0) {
    const HORIZ_MIN = 3, STEP_MS = 10000;
    let t0 = Date.now(), best = 0;
    while (Date.now() - t0 < HORIZ_MIN * 60 * 1000) {
      let price = null;
      if (isStock(symbol)) {
        const t = await stocksLatestTrade(symbol);
        price = Number.isFinite(t?.price) ? t.price : null;
      } else {
        const m = await getCryptoTradesBatch([toDataSymbol(symbol)]);
        const one = m.get(toDataSymbol(symbol));
        price = Number.isFinite(one?.price) ? one.price : null;
      }
      if (Number.isFinite(price)) best = Math.max(best, price - entryPx);
      await sleep(STEP_MS);
    }
    if (v0 > 0 && best > 0) {
      const g_hat = (v0 * v0) / (2 * best);
      const s = (symStats[symbol] ||= { mfeHist: [], hitByHour: Array.from({ length: 24 }, () => ({ h: 0, t: 0 })) });
      s.drag_g = ewma(s.drag_g, g_hat, 0.2);
      pushMFE(symbol, best);
      const hr = new Date().getUTCHours();
      const need = (requiredProfitBpsForSymbol(symbol, SETTINGS.riskLevel) / 10000) * entryPx;
      const hb = s.hitByHour[hr] || (s.hitByHour[hr] = { h: 0, t: 0 });
      hb.t += 1;
      if (best >= need) hb.h += 1;
    }
  }

  /* -------------------- Entry signal (LIVE ONLY) -------------------- */
  async function computeEntrySignal(asset, d, riskLvl, preQuoteMap = null) {
    // Bars for momentum
    let closes = [];
    if (isStock(asset.symbol)) {
      const hist = PRICE_HIST.get(asset.symbol) || [];
      closes = hist.length ? hist.slice(-6) : [];
      if (!closes.length) {
        // ask for bars to seed momentum if needed
        const m = await stocksBars1m([asset.symbol], 6);
        const arr = m.get(asset.symbol) || [];
        closes = arr.map((b) => b.close);
      }
    } else {
      const bars1 = await getCryptoBars1m(asset.symbol, 6);
      closes = bars1.map((b) => b.close);
    }

    // Must have a real quote (no synth allowed)
    const q = await getQuoteSmart(asset.symbol, preQuoteMap);
    if (SETTINGS.liveRequireQuote && !(q && q.bid > 0 && q.ask > 0)) {
      return { entryReady: false, why: 'no_live_quote' };
    }

    const mid = 0.5 * (q.bid + q.ask);

    if (isStock(asset.symbol)) {
      const clk = await getStockClockCached();
      if (!clk.is_open) return { entryReady: false, why: 'market_closed' };
    }

    if (!isStock(asset.symbol)) {
      if (BLACKLIST.has(asset.symbol)) return { entryReady: false, why: 'blacklist' };
      if (mid < MIN_PRICE_FOR_TICK_SANE_USD) return { entryReady: false, why: 'coarse_tick' };
    }

    const spreadBps = ((q.ask - q.bid) / mid) * 10000;
    logTradeAction('quote_ok', asset.symbol, { spreadBps: +spreadBps.toFixed(1) });
    if (spreadBps > d.spreadMax + SPREAD_EPS_BPS) {
      logTradeAction('skip_wide_spread', asset.symbol, { spreadBps: +spreadBps.toFixed(1) });
      return { entryReady: false, why: 'spread' };
    }

    // Soft momentum: EMA slope up OR last step >= 0
    const ema5 = emaArr(closes.slice(-6), 5);
    const slopeUp = ema5.length >= 2 ? ema5.at(-1) > ema5.at(-2) : true;
    const v0 = closes.length >= 2 ? closes.at(-1) - closes.at(-2) : 0;
    const v1 = closes.length >= 3 ? closes.at(-2) - closes.at(-3) : 0;
    const accelOk = v0 >= 0 || (slopeUp && v0 >= v1);
    if (SETTINGS.enforceMomentum && !accelOk) {
      return { entryReady: false, why: 'nomomo', spreadBps, quote: q };
    }

    // Liquidity: equities only
    if (isStock(asset.symbol) && q.bs != null && q.bs < MIN_BID_SIZE_LOOSE) {
      return { entryReady: false, why: 'illiquid', spreadBps, quote: q };
    }

    const sst = symStats[asset.symbol] || {};
    const slipEw = Number.isFinite(sst.slipEwmaBps) ? sst.slipEwmaBps : SLIP_BUFFER_BPS_BY_RISK[riskLvl];
    const needBps = Math.max(
      requiredProfitBpsForSymbol(asset.symbol, riskLvl),
      exitFloorBps(asset.symbol) + 0.5 + slipEw,
      SETTINGS.netMinProfitBps
    );
    const tpBase = q.bid * (1 + needBps / 10000);
    const ok = tpBase > q.bid * 1.00005;
    if (!ok) {
      return { entryReady: false, why: 'edge_negative', spreadBps, quote: q, v0, tpBps: needBps, tp: tpBase };
    }

    (symStats[asset.symbol] ||= {}).spreadEwmaBps = ewma(symStats[asset.symbol].spreadEwmaBps, spreadBps, 0.2);
    const drag_g = Math.max(1e-6, sst.drag_g ?? 8);
    const runway = v0 > 0 ? (v0 * v0) / (2 * drag_g) : 0;

    return { entryReady: true, spreadBps, quote: q, tpBps: needBps, tp: tpBase, v0, runway };
  }

  /* -------------------- Buy (maker-first, optional taker) -------------------- */
  async function fetchAssetMeta(symbol) {
    try {
      const r = await f(`${ALPACA_BASE_URL}/assets/${encodeURIComponent(symbol)}`, { headers: HEADERS });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }
  async function placeMakerThenMaybeTakerBuy(symbol, qty, preQuoteMap = null) {
    await cancelOpenOrdersForSymbol(symbol, 'buy');
    let lastOrderId = null, placedLimit = null;
    const t0 = Date.now(), CAMP_SEC = SETTINGS.makerCampSec;

    while ((Date.now() - t0) / 1000 < CAMP_SEC) {
      const q = await getQuoteSmart(symbol, preQuoteMap);
      if (!q) { await sleep(500); continue; }
      const bidNow = q.bid, askNow = q.ask;
      if (!Number.isFinite(bidNow) || bidNow <= 0) { await sleep(250); continue; }

      const TICK = isStock(symbol) ? 0.01 : 1e-5;
      const join = Number.isFinite(askNow) && askNow > 0 ? Math.min(askNow - TICK, bidNow + TICK) : bidNow + TICK;

      if (isStock(symbol)) {
        const meta = await fetchAssetMeta(symbol);
        if (meta && meta.fractionable === false) {
          const px = bidNow || askNow || 0;
          const whole = Math.floor(qty);
          if (whole <= 0 || whole * px < 5) return { filled: false };
          qty = whole;
        }
      }

      if (!lastOrderId || Math.abs(join - placedLimit) / Math.max(1, join) > 0.0001) {
        if (lastOrderId) {
          try { await f(`${ALPACA_BASE_URL}/orders/${lastOrderId}`, { method: 'DELETE', headers: HEADERS }); } catch {}
        }
        const order = {
          symbol, qty, side: 'buy', type: 'limit', time_in_force: 'gtc',
          limit_price: join.toFixed(isStock(symbol) ? 2 : 5),
        };
        try {
          const res = await f(`${ALPACA_BASE_URL}/orders`, { method: 'POST', headers: HEADERS, body: JSON.stringify(order) });
          const raw = await res.text(); let data; try { data = JSON.parse(raw); } catch { data = { raw }; }
          if (res.ok && data.id) {
            lastOrderId = data.id; placedLimit = join;
            logTradeAction(placedLimit ? 'buy_replaced' : 'buy_camped', symbol, { limit: order.limit_price });
          }
        } catch (e) {
          logTradeAction('quote_exception', symbol, { error: e.message });
        }
      }

      const pos = await getPositionInfo(symbol);
      if (pos && pos.qty > 0) {
        if (lastOrderId) {
          try { await f(`${ALPACA_BASE_URL}/orders/${lastOrderId}`, { method: 'DELETE', headers: HEADERS }); } catch {}
        }
        logTradeAction('buy_success', symbol, {
          qty: pos.qty, limit: placedLimit?.toFixed ? placedLimit.toFixed(isStock(symbol) ? 2 : 5) : placedLimit,
        });
        return { filled: true, entry: pos.basis ?? placedLimit, qty: pos.qty };
      }
      await sleep(1200);
    }

    if (lastOrderId) {
      try { await f(`${ALPACA_BASE_URL}/orders/${lastOrderId}`, { method: 'DELETE', headers: HEADERS }); } catch {}
      logTradeAction('buy_unfilled_canceled', symbol, {});
    }

    if (SETTINGS.enableTakerFlip) {
      const q = await getQuoteSmart(symbol, preQuoteMap);
      if (q && q.ask > 0) {
        let mQty = qty;
        if (isStock(symbol)) {
          const meta = await fetchAssetMeta(symbol);
          if (meta && meta.fractionable === false) mQty = Math.floor(qty);
          if (mQty <= 0) return { filled: false };
        }
        const tif = isStock(symbol) ? 'day' : 'gtc'; // equity market orders require 'day'
        const order = { symbol, qty: mQty, side: 'buy', type: 'market', time_in_force: tif };
        try {
          const res = await f(`${ALPACA_BASE_URL}/orders`, { method: 'POST', headers: HEADERS, body: JSON.stringify(order) });
          const raw = await res.text(); let data; try { data = JSON.parse(raw); } catch { data = { raw }; }
          if (res.ok && data.id) {
            logTradeAction('buy_success', symbol, { qty: mQty, limit: 'mkt' });
            return { filled: true, entry: q.ask, qty: mQty };
          } else {
            logTradeAction('quote_exception', symbol, { error: `BUY mkt ${res.status} ${data?.message || data?.raw?.slice?.(0, 80) || ''}` });
          }
        } catch (e) {
          logTradeAction('quote_exception', symbol, { error: e.message });
        }
      }
    }
    return { filled: false };
  }

  /* -------------------- Risk exits + market sell -------------------- */
  async function marketSell(symbol, qty) {
    try { await cancelOpenOrdersForSymbol(symbol, 'sell'); } catch {}
    const tif = isStock(symbol) ? 'day' : 'gtc';
    const mkt = { symbol, qty, side: 'sell', type: 'market', time_in_force: tif };
    try {
      const res = await f(`${ALPACA_BASE_URL}/orders`, { method: 'POST', headers: HEADERS, body: JSON.stringify(mkt) });
      const raw = await res.text(); let data; try { data = JSON.parse(raw); } catch { data = { raw }; }
      if (res.ok && data.id) return data;
      logTradeAction('tp_limit_error', symbol, { error: `SELL mkt ${res.status} ${data?.message || data?.raw?.slice?.(0, 120) || ''}` });
      return null;
    } catch (e) {
      logTradeAction('tp_limit_error', symbol, { error: `SELL mkt exception ${e.message}` });
      return null;
    }
  }

  const ensureRiskExits = async (symbol) => {
    if (!SETTINGS.enableStops) return false;
    const state = tradeStateRef.current[symbol];
    if (!state) return false;

    const pos = await getPositionInfo(symbol);
    const qty = Number(pos?.available ?? pos?.qty ?? state.qty ?? 0);
    const entryPx = state.entry ?? pos?.basis ?? pos?.mark ?? 0;
    if (!(qty > 0) || !(entryPx > 0)) return false;

    const q = await getQuoteSmart(symbol);
    if (!q || !(q.bid > 0)) return false;
    const bid = q.bid;

    if (!state.stopPx) {
      const soft = entryPx * (1 - SETTINGS.stopLossBps / 10000);
      const hard = entryPx * (1 - SETTINGS.hardStopLossPct / 100);
      state.stopPx = soft; state.hardStopPx = hard;
      logTradeAction('stop_arm', symbol, { stopPx: soft, hard: false });
      logTradeAction('stop_arm', symbol, { stopPx: hard, hard: true });
    }

    if (bid <= state.hardStopPx) {
      const res = await marketSell(symbol, qty);
      if (res) return true;
    }

    if (SETTINGS.enableTrailing) {
      const armPx = entryPx * (1 + SETTINGS.trailStartBps / 10000);
      if (!state.trailArmed && bid >= armPx) {
        state.trailArmed = true;
        state.trailPeak = bid;
        logTradeAction('trail_start', symbol, { startPx: armPx });
      }
      if (state.trailArmed) {
        if (bid > (state.trailPeak ?? 0)) {
          state.trailPeak = bid;
          logTradeAction('trail_peak', symbol, { peakPx: bid });
        }
        const trailStop = (state.trailPeak ?? armPx) * (1 - SETTINGS.trailingStopBps / 10000);
        state.stopPx = Math.max(state.stopPx ?? 0, trailStop);
        logTradeAction('stop_update', symbol, { stopPx: state.stopPx });
        if (bid <= trailStop) {
          const res = await marketSell(symbol, qty);
          if (res) return true;
        }
      }
    }

    if (bid <= (state.stopPx ?? 0)) {
      const res = await marketSell(symbol, qty);
      if (res) return true;
    }
    return false;
  };

  /* -------------------- Take-profit maintenance (live flip) -------------------- */
  const SELL_EPS_BPS = 0.2;

  const ensureLimitTP = async (symbol, limitPrice) => {
    const pos = await getPositionInfo(symbol);
    if (!pos || pos.available <= 0) return;

    const state = tradeStateRef.current[symbol] || {};
    const entryPx = state.entry ?? pos.basis ?? pos.mark ?? 0;
    const qty = Number(pos.available ?? pos.qty ?? state.qty ?? 0);
    if (!(entryPx > 0) || !(qty > 0)) return;

    const riskExited = await ensureRiskExits(symbol);
    if (riskExited) return;

    const heldMinutes = (Date.now() - (state.entryTs || 0)) / 60000;
    if (Number.isFinite(heldMinutes) && heldMinutes >= SETTINGS.maxHoldMin) {
      try {
        const q = await getQuoteSmart(symbol);
        if (q && q.bid > 0) {
          const net = projectedNetPnlUSD({ symbol, entryPx, qty, sellPx: q.bid });
          if (net >= 0 || net >= -Math.abs(SETTINGS.maxTimeLossUSD)) {
            try {
              const open = await getOpenOrders();
              const ex = open.find((o) => (o.side || '').toLowerCase() === 'sell' && (o.type || '').toLowerCase() === 'limit' && o.symbol === symbol);
              if (ex) { await f(`${ALPACA_BASE_URL}/orders/${ex.id}`, { method: 'DELETE', headers: HEADERS }).catch(() => null); }
            } catch {}
            const mkt = await marketSell(symbol, qty);
            if (mkt) {
              logTradeAction('tp_limit_set', symbol, { limit: `TIME_EXIT@~${q.bid.toFixed(isStock(symbol) ? 2 : 5)}` });
              return;
            }
          }
        }
      } catch {}
    }

    const feeFloor = minExitPriceFeeAware({ symbol, entryPx, qty });
    let finalLimit = Math.max(limitPrice, feeFloor);
    if (finalLimit > limitPrice + 1e-12) {
      logTradeAction('tp_fee_floor', symbol, { limit: finalLimit.toFixed(isStock(symbol) ? 2 : 5) });
    }

    if (SETTINGS.takerExitOnTouch) {
      const q = await getQuoteSmart(symbol);
      const memo = touchMemoRef.current[symbol] || (touchMemoRef.current[symbol] = { count: 0, lastTs: 0, firstTouchTs: 0 });
      if (q && q.bid > 0) {
        const touchPx = finalLimit * (1 - SELL_EPS_BPS / 10000);
        const touching = q.bid >= touchPx;

        if (touching) {
          const now = Date.now();
          memo.count = now - memo.lastTs > 2000 * 5 ? 1 : memo.count + 1;
          memo.lastTs = now;
          if (!memo.firstTouchTs) memo.firstTouchTs = now;
          const ageSec = (now - memo.firstTouchTs) / 1000;
          logTradeAction('tp_touch_tick', symbol, { count: memo.count, bid: q.bid });

          const guard = String(SETTINGS.takerExitGuard || 'fee').toLowerCase();
          const okByFee = q.bid >= feeFloor * (1 - 1e-6);
          const okByMin = meetsMinProfit({ symbol, entryPx, qty, sellPx: q.bid });
          const okProfit = guard === 'min' ? okByMin : okByFee;
          const sizeOk = isStock(symbol) ? (q.bs == null ? true : q.bs >= MIN_BID_SIZE_LOOSE) : true;

          const timedForce = ageSec >= Math.max(2, SETTINGS.touchFlipTimeoutSec) && okByFee;
          if ((memo.count >= SETTINGS.touchTicksRequired && sizeOk && okProfit) || timedForce) {
            try {
              const open = await getOpenOrders();
              const ex = open.find((o) => (o.side || '').toLowerCase() === 'sell' && (o.type || '').toLowerCase() === 'limit' && o.symbol === symbol);
              if (ex) { await f(`${ALPACA_BASE_URL}/orders/${ex.id}`, { method: 'DELETE', headers: HEADERS }).catch(() => null); }
            } catch {}
            const mkt = await marketSell(symbol, qty);
            if (mkt) {
              touchMemoRef.current[symbol] = { count: 0, lastTs: 0, firstTouchTs: 0 };
              logTradeAction(timedForce ? 'taker_force_flip' : 'tp_limit_set', symbol, { limit: timedForce ? `FORCE@~${q.bid.toFixed?.(isStock(symbol) ? 2 : 5) ?? q.bid}` : `TAKER@~${q.bid.toFixed?.(isStock(symbol) ? 2 : 5) ?? q.bid}` });
              return;
            }
          } else if (memo.count >= SETTINGS.touchTicksRequired && !okProfit) {
            logTradeAction('taker_blocked_fee', symbol, {});
          }
        } else {
          memo.count = 0;
          memo.lastTs = Date.now();
          memo.firstTouchTs = 0;
        }
      }
    }

    // Equities: let TP limit rest (day). Crypto: gtc.
    const limitTIF = isStock(symbol) ? 'day' : 'gtc';

    const open = await getOpenOrders();
    const existing = open.find(
      (o) => (o.side || '').toLowerCase() === 'sell' && (o.type || '').toLowerCase() === 'limit' && o.symbol === symbol
    );
    const now = Date.now();
    const lastTs = state.lastLimitPostTs || 0;
    const needsPost = !existing ||
      Math.abs(parseFloat(existing.limit_price) - finalLimit) / Math.max(1, finalLimit) > 0.001 ||
      now - lastTs > 1000 * 10;
    if (!needsPost) return;

    try {
      if (existing) { await f(`${ALPACA_BASE_URL}/orders/${existing.id}`, { method: 'DELETE', headers: HEADERS }).catch(() => null); }
      const order = { symbol, qty, side: 'sell', type: 'limit', time_in_force: limitTIF, limit_price: finalLimit.toFixed(isStock(symbol) ? 2 : 5) };
      const res = await f(`${ALPACA_BASE_URL}/orders`, { method: 'POST', headers: HEADERS, body: JSON.stringify(order) });
      const raw = await res.text(); let data; try { data = JSON.parse(raw); } catch { data = { raw }; }
      if (res.ok && data.id) {
        tradeStateRef.current[symbol] = { ...(state || {}), lastLimitPostTs: now };
        logTradeAction('tp_limit_set', symbol, { id: data.id, limit: order.limit_price });
      } else {
        const msg = data?.message || data?.raw?.slice?.(0, 160) || '';
        logTradeAction('tp_limit_error', symbol, { error: `POST ${res.status} ${msg} (TIF=${limitTIF}, qty=${qty})` });
      }
    } catch (e) {
      logTradeAction('tp_limit_error', symbol, { error: e.message });
    }
  };

  const concurrencyCapBySpread = (avgBps) => {
    const base = SETTINGS.maxConcurrentPositions;
    if (!Number.isFinite(avgBps)) return base;
    if (avgBps < 6) return base + 4;
    if (avgBps < 10) return base + 2;
    if (avgBps < 16) return base;
    return Math.max(2, base - 2);
  };

  /* -------------------- PDT gate + place order -------------------- */
  function pdtBlockedForEquities(eq, flagged, dt) {
    if (!SETTINGS.avoidPDT) return false;
    if (flagged) return true;
    if (!Number.isFinite(eq) || eq < SETTINGS.pdtEquityThresholdUSD) return true;
    if (Number.isFinite(dt) && dt >= 3) return true; // conservative
    return false;
  }

  const placeOrder = async (symbol, ccSymbol = symbol, d, sigPre = null, preQuoteMap = null) => {
    if (TRADING_HALTED) {
      logTradeAction('daily_halt', symbol, { reason: HALT_REASON || 'Rule' });
      return false;
    }

    // PDT safety: skip NEW equity entries if blocked
    const eqNow = acctSummary?.portfolioValue;
    const flagNow = !!acctSummary?.patternDayTrader;
    const dtNow = acctSummary?.daytradeCount;
    if (isStock(symbol) && pdtBlockedForEquities(eqNow, flagNow, dtNow)) {
      logTradeAction('pdt_guard', symbol, { eq: eqNow, dt: dtNow });
      return false;
    }

    if (!isStock(symbol) && STABLES.has(symbol)) return false;
    if (!isStock(symbol) && BLACKLIST.has(symbol)) {
      logTradeAction('skip_blacklist', symbol, {});
      return false;
    }

    await cleanupStaleBuyOrders(30);

    try {
      const allPos = await getAllPositions();
      const nonStableOpen = (allPos || []).filter((p) => Number(p.qty) > 0 && Number(p.market_value || p.marketValue || 0) > 1).length;
      const cap = concurrencyCapBySpread(globalSpreadAvgRef.current);
      if (nonStableOpen >= cap) {
        logTradeAction('concurrency_guard', symbol, { cap, avg: globalSpreadAvgRef.current });
        return false;
      }
    } catch {}

    const held = await getPositionInfo(symbol);
    if (held && Number(held.qty) > 0) {
      logTradeAction('entry_skipped', symbol, { entryReady: false, reason: 'held' });
      return false;
    }

    const sig = sigPre || (await computeEntrySignal({ symbol, cc: ccSymbol }, d, SETTINGS.riskLevel, preQuoteMap));
    if (!sig.entryReady) return false;

    let equity = acctSummary.portfolioValue, buyingPower = acctSummary.buyingPower;
    if (!Number.isFinite(equity) || !Number.isFinite(buyingPower)) {
      try {
        const a = await getAccountSummaryRaw();
        equity = a.equity; buyingPower = a.buyingPower;
        setAcctSummary((s) => ({
          portfolioValue: a.equity, buyingPower: a.buyingPower, dailyChangeUsd: a.changeUsd, dailyChangePct: a.changePct,
          patternDayTrader: a.patternDayTrader, daytradeCount: a.daytradeCount, updatedAt: new Date().toISOString()
        }));
      } catch {}
    }
    if (!Number.isFinite(equity) || equity <= 0) equity = 1000;
    if (!Number.isFinite(buyingPower) || buyingPower <= 0) return false;

    const desired = Math.min(buyingPower, (SETTINGS.maxPosPctEquity / 100) * equity);
    const notional = capNotional(symbol, desired, equity);

    let entryPx = sig?.quote?.bid;
    if (!Number.isFinite(entryPx) || entryPx <= 0) entryPx = sig?.quote?.ask;
    let preMeta = null;
    if (isStock(symbol)) {
      preMeta = await fetchAssetMeta(symbol);
      if (preMeta && preMeta.fractionable === false && Number.isFinite(entryPx) && entryPx > notional) {
        logTradeAction('skip_small_order', symbol);
        return false;
      }
    }
    if (!Number.isFinite(notional) || notional < 5) {
      logTradeAction('skip_small_order', symbol);
      return false;
    }

    if (!Number.isFinite(entryPx) || entryPx <= 0) entryPx = sig.quote.bid;
    let qty = +(notional / entryPx).toFixed(isStock(symbol) ? 4 : 6);
    if (isStock(symbol)) {
      const meta = preMeta || (await fetchAssetMeta(symbol));
      if (meta && meta.fractionable === false) qty = Math.floor(qty);
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      logTradeAction('skip_small_order', symbol);
      return false;
    }

    const result = await placeMakerThenMaybeTakerBuy(symbol, qty, preQuoteMap);
    if (!result.filled) return false;

    const actualEntry = result.entry ?? entryPx;
    const actualQty = result.qty ?? qty;

    const approxMid = sig && sig.quote ? 0.5 * (sig.quote.bid + sig.quote.ask) : actualEntry;
    const slipBps = Number.isFinite(approxMid) && approxMid > 0 ? ((actualEntry - (sig?.quote?.bid ?? entryPx)) / approxMid) * 10000 : 0;
    const s = (symStats[symbol] ||= { hitByHour: Array.from({ length: 24 }, () => ({ h: 0, t: 0 })), mfeHist: [] });
    s.slipEwmaBps = ewma(s.slipEwmaBps, Math.max(0, slipBps), 0.2);

    const slipEw = s.slipEwmaBps ?? SLIP_BUFFER_BPS_BY_RISK[SETTINGS.riskLevel];
    const needBps0 = requiredProfitBpsForSymbol(symbol, SETTINGS.riskLevel);
    const needBpsAdj = Math.max(needBps0, exitFloorBps(symbol) + 0.5 + slipEw, SETTINGS.netMinProfitBps);
    const tpBase = actualEntry * (1 + needBpsAdj / 10000);
    const feeFloor = minExitPriceFeeAware({ symbol, entryPx: actualEntry, qty: actualQty });
    const tpCapped = Math.max(Math.min(tpBase, actualEntry + (sig?.runway ?? 0)), feeFloor);

    tradeStateRef.current[symbol] = {
      entry: actualEntry, qty: actualQty, tp: tpCapped, feeFloor,
      runway: sig?.runway ?? 0, entryTs: Date.now(), lastLimitPostTs: 0,
      wasHolding: true, stopPx: null, hardStopPx: null, trailArmed: false, trailPeak: null,
    };
    await ensureLimitTP(symbol, tpCapped);

    monitorOutcome(symbol, actualEntry, sig?.v0 ?? 0).catch(() => {});
    return true;
  };

  /* -------------------- TP upkeep loop -------------------- */
  useEffect(() => {
    let timer = null;
    const run = async () => {
      try {
        const positions = await getAllPositions();
        for (const p of positions || []) {
          const symbol = p.symbol;
          const qty = Number(p.qty || 0);
          if (qty <= 0) continue;

          const s = tradeStateRef.current[symbol] || {
            entry: Number(p.avg_entry_price || p.basis || 0),
            qty: Number(p.qty || 0),
            entryTs: Date.now(), lastLimitPostTs: 0, runway: 0, wasHolding: true, feeFloor: null,
          };
          tradeStateRef.current[symbol] = s;

          const slipEw = symStats[symbol]?.slipEwmaBps ?? SLIP_BUFFER_BPS_BY_RISK[SETTINGS.riskLevel];
          const needAdj = Math.max(requiredProfitBpsForSymbol(symbol, SETTINGS.riskLevel), exitFloorBps(symbol) + 0.5 + slipEw, SETTINGS.netMinProfitBps);
          const entryBase = Number(s.entry || p.avg_entry_price || p.mark || 0);
          const tpBase = entryBase * (1 + needAdj / 10000);
          const feeFloor = minExitPriceFeeAware({ symbol, entryPx: entryBase, qty: Number(p.available ?? p.qty ?? 0) });
          const tp = Math.max(Math.min(tpBase, entryBase + (s.runway ?? 0)), feeFloor);
          s.tp = tp; s.feeFloor = feeFloor;

          await ensureLimitTP(symbol, tp);
        }
      } finally {
        timer = setTimeout(run, 1000 * 5);
      }
    };
    run();
    return () => { if (timer) clearTimeout(timer); };
  }, []);

  /* -------------------- Dust sweep -------------------- */
  useEffect(() => {
    let stopped = false;
    const sweep = async () => {
      try {
        const [positions, openOrders] = await Promise.all([getAllPositions(), getOpenOrders()]);
        const openSellBySym = new Set((openOrders || []).filter((o) => (o.side || '').toLowerCase() === 'sell').map((o) => o.symbol));
        for (const p of positions || []) {
          const sym = p.symbol;
          if (!isStock(sym) && (STABLES.has(sym) || BLACKLIST.has(sym))) continue;
          const mv = Number(p.market_value ?? p.marketValue ?? 0);
          const avail = Number(p.qty_available ?? p.available ?? p.qty ?? 0);
          if (mv > 0 && mv < DUST_FLATTEN_MAX_USD && avail > 0 && !openSellBySym.has(sym)) {
            const mkt = { symbol: sym, qty: avail, side: 'sell', type: 'market', time_in_force: isStock(sym) ? 'day' : 'gtc' };
            try {
              const res = await f(`${ALPACA_BASE_URL}/orders`, { method: 'POST', headers: HEADERS, body: JSON.stringify(mkt) });
              if (res.ok) logTradeAction('dust_flattened', sym, { usd: mv });
            } catch {}
          }
        }
      } catch {}
      if (!stopped) setTimeout(sweep, DUST_SWEEP_MINUTES * 60 * 1000);
    };
    sweep();
    return () => { stopped = true; };
  }, []);

  /* -------------------- Scanner (stocks & crypto pages) -------------------- */
  const loadData = async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setIsLoading(true);

    const effectiveTracked = tracked && tracked.length ? tracked : STATIC_UNIVERSE;
    setData((prev) =>
      prev && prev.length
        ? prev
        : effectiveTracked.map((t) => ({ ...t, price: null, entryReady: false, error: null, time: new Date().toLocaleTimeString(), spreadBps: null, tpBps: null }))
    );

    let results = [];
    try {
      await getAccountSummaryThrottled();

      // PDT info snapshot
      let eq = acctSummary?.portfolioValue;
      let flagged = !!acctSummary?.patternDayTrader;
      let dt = acctSummary?.daytradeCount;
      if (!Number.isFinite(eq)) {
        try {
          const a = await getAccountSummaryRaw();
          eq = a.equity; flagged = a.patternDayTrader; dt = a.daytradeCount;
          setAcctSummary({
            portfolioValue: a.equity, buyingPower: a.buyingPower, dailyChangeUsd: a.changeUsd, dailyChangePct: a.changePct,
            patternDayTrader: a.patternDayTrader, daytradeCount: a.daytradeCount, updatedAt: new Date().toISOString()
          });
        } catch {}
      }
      const PDT_SCAN_BLOCK = SETTINGS.avoidPDT && (flagged || !Number.isFinite(eq) || eq < SETTINGS.pdtEquityThresholdUSD || (Number.isFinite(dt) && dt >= 3));
      if (PDT_SCAN_BLOCK) {
        logTradeAction('pdt_guard', 'SYSTEM', { reason: 'equity_scan_disabled', eq, dt });
      }

      // positions/open orders
      const [positions, allOpenOrders] = await Promise.all([getAllPositions(), getOpenOrders()]);
      const posBySym = new Map((positions || []).map((p) => [p.symbol, p]));
      const openCount = (positions || []).filter((p) => {
        const sym = p.symbol;
        if (STABLES.has(sym)) return false;
        const mv = parseFloat(p.market_value ?? p.marketValue ?? '0');
        const qty = parseFloat(p.qty ?? '0');
        return Number.isFinite(mv) && mv > 1 && Number.isFinite(qty) && qty > 0;
      }).length;

      // Build slices
      const equitiesAll = PDT_SCAN_BLOCK ? [] : effectiveTracked.filter((t) => isStock(t.symbol));
      let cryptosAll = effectiveTracked.filter((t) => !isStock(t.symbol));
      if (!cryptosAll.length) {
        cryptosAll = CORE_CRYPTOS
          .filter((s) => !STABLES.has(s) && !BLACKLIST.has(s))
          .map((s) => ({ name: s, symbol: s, cc: s.replace('USD', '') }));
        logTradeAction('scan_error', 'UNIVERSE', { error: `no_crypto_in_universe → using core (${cryptosAll.length})` });
      }

      const stockPages = Math.max(1, Math.ceil(Math.max(0, equitiesAll.length) / SETTINGS.stockPageSize));
      const sIdx = stockPageRef.current % stockPages;
      const sStart = sIdx * SETTINGS.stockPageSize;
      const stockSlice = equitiesAll.slice(sStart, Math.min(sStart + SETTINGS.stockPageSize, equitiesAll.length));
      stockPageRef.current += 1;

      const cryptoPages = Math.max(1, Math.ceil(Math.max(0, cryptosAll.length) / SETTINGS.stockPageSize));
      const cIdx = cryptoPageRef.current % cryptoPages;
      const cStart = cIdx * SETTINGS.stockPageSize;
      const cryptoSlice = cryptosAll.slice(cStart, Math.min(cStart + SETTINGS.stockPageSize, cryptosAll.length));
      cryptoPageRef.current += 1;

      setOpenMeta({ positions: openCount, orders: (allOpenOrders || []).length, allowed: equitiesAll.length + cryptosAll.length, universe: equitiesAll.length + cryptosAll.length });

      logTradeAction('scan_start', 'STATIC', { batch: stockSlice.length + cryptoSlice.length });

      const mixedSymbols = [...stockSlice.map((t) => t.symbol), ...cryptoSlice.map((t) => t.symbol)];
      const batchMap = await getQuotesBatch(mixedSymbols);

      // Push to PRICE_HIST only when we actually have live quotes
      for (const asset of [...stockSlice, ...cryptoSlice]) {
        const qDisplay = batchMap.get(asset.symbol);
        if (qDisplay && qDisplay.bid > 0 && qDisplay.ask > 0) {
          const mid = 0.5 * (qDisplay.bid + qDisplay.ask);
          pushPriceHist(asset.symbol, mid);
        }
      }

      let readyCount = 0, attemptCount = 0, successCount = 0, watchCount = 0, skippedCount = 0;
      const reasonCounts = {};
      const spreadSamples = [];
      const d = { spreadMax: SETTINGS.spreadMaxBps };

      for (const asset of [...stockSlice, ...cryptoSlice]) {
        const token = { ...asset, price: null, entryReady: false, error: null, time: new Date().toLocaleTimeString(), spreadBps: null, tpBps: null };
        try {
          const qDisplay = batchMap.get(asset.symbol);
          if (qDisplay && qDisplay.bid > 0 && qDisplay.ask > 0) token.price = 0.5 * (qDisplay.bid + qDisplay.ask);

          const prevState = tradeStateRef.current[asset.symbol] || {};
          const posNow = posBySym.get(asset.symbol);
          const isHolding = !!(posNow && Number(posNow.qty) > 0);
          tradeStateRef.current[asset.symbol] = { ...prevState, wasHolding: isHolding };

          const sig = await computeEntrySignal(asset, d, SETTINGS.riskLevel, batchMap);
          token.entryReady = sig.entryReady;

          if (sig?.quote && sig.quote.bid > 0 && sig.quote.ask > 0) {
            const mid2 = 0.5 * (sig.quote.bid + sig.quote.ask);
            spreadSamples.push(((sig.quote.ask - sig.quote.bid) / mid2) * 10000);
          }

          if (sig.entryReady) {
            token.spreadBps = sig.spreadBps ?? null;
            token.tpBps = sig.tpBps ?? null;
            readyCount++;
            attemptCount++;
            if (autoTrade) {
              const ok = await placeOrder(asset.symbol, asset.cc, d, sig, batchMap);
              if (ok) successCount++;
            } else {
              logTradeAction('entry_skipped', asset.symbol, { entryReady: true, reason: 'auto_off' });
            }
          } else {
            watchCount++;
            skippedCount++;
            if (sig?.why) reasonCounts[sig.why] = (reasonCounts[sig.why] || 0) + 1;
            logTradeAction('entry_skipped', asset.symbol, { entryReady: false, reason: sig.why });
          }
        } catch (err) {
          token.error = err?.message || String(err);
          logTradeAction('scan_error', asset.symbol, { error: token.error });
          watchCount++;
          skippedCount++;
        }
        results.push(token);
      }

      const avg = spreadSamples.length ? spreadSamples.reduce((a, b) => a + b, 0) / spreadSamples.length : globalSpreadAvgRef.current;
      globalSpreadAvgRef.current = avg;

      setScanStats({ ready: readyCount, attempted: attemptCount, filled: successCount, watch: watchCount, skipped: skippedCount, reasons: reasonCounts });
      logTradeAction('scan_summary', 'STATIC', { readyCount, attemptCount, successCount });
    } catch (e) {
      logTradeAction('scan_error', 'ALL', { error: e?.message || String(e) });
    } finally {
      const bySym = new Map(results.map((r) => [r.symbol, r]));
      const display = (tracked && tracked.length ? tracked : STATIC_UNIVERSE).map(
        (t) =>
          bySym.get(t.symbol) || {
            ...t,
            price: null,
            entryReady: false,
            error: null,
            time: new Date().toLocaleTimeString(),
            spreadBps: null,
            tpBps: null,
          }
      );
      setData(display);
      setLastScanAt(Date.now());
      setRefreshing(false);
      setIsLoading(false);
      scanningRef.current = false;
    }
  };

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (!stopped) await loadData();
      if (!stopped) setTimeout(tick, SETTINGS.scanMs);
    };
    (async () => {
      await getAccountSummary();
      try {
        const res = await f(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
        const account = await res.json();
        console.log('[ALPACA CONNECTED]', account.account_number, 'Equity:', account.equity);
        showNotification('✅ Connected to Alpaca');
      } catch (err) {
        console.error('[ALPACA CONNECTION FAILED]', err);
        showNotification('❌ Alpaca API Error');
      }
      await checkAlpacaHealth();
      await loadData();
      setTimeout(tick, SETTINGS.scanMs);
    })();
    return () => { stopped = true; };
  }, []);

  const onRefresh = () => {
    setRefreshing(true);
    loadData();
  };
  const bp = acctSummary.buyingPower, chPct = acctSummary.dailyChangePct;

  const okWindowMs = Math.max(SETTINGS.scanMs * 3, 6000);
  const statusColor = isLoading ? '#57e389' : !lastScanAt ? '#666' : Date.now() - lastScanAt < okWindowMs ? '#57e389' : '#ffd166';

  const bump = (key, delta, opts = {}) => {
    setSettings((s) => ({ ...s, [key]: clamp((s[key] ?? 0) + delta, opts.min ?? -1e9, opts.max ?? 1e9) }));
  };

  const applyPreset = (name) => {
    const presets = {
      Safer:  { riskLevel: 3, spreadMaxBps: 50,  maxPosPctEquity: 10, absMaxNotionalUSD: 100, makerCampSec: 30, enableTakerFlip: true, takerExitOnTouch: true, takerExitGuard: 'min', touchFlipTimeoutSec: 10, liveRequireQuote: true, liveFreshMsCrypto: 10000, liveFreshMsStock: 10000, enforceMomentum: true,  enableStops: true, stopLossBps: 30, hardStopLossPct: 1.0, enableTrailing: true, trailStartBps: 20, trailingStopBps: 10, maxConcurrentPositions: 6, haltOnDailyLoss: true,  dailyMaxLossPct: 3.0 },
      Neutral:{ riskLevel: 2, spreadMaxBps: 70,  maxPosPctEquity: 15, absMaxNotionalUSD: 150, makerCampSec: 25, enableTakerFlip: true, takerExitOnTouch: true, takerExitGuard: 'fee', touchFlipTimeoutSec: 9,  liveRequireQuote: true, liveFreshMsCrypto: 15000, liveFreshMsStock: 15000, enforceMomentum: true,  enableStops: true, stopLossBps: 25, hardStopLossPct: 1.0, enableTrailing: true, trailStartBps: 15, trailingStopBps: 8,  maxConcurrentPositions: 8, haltOnDailyLoss: true,  dailyMaxLossPct: 4.0 },
      Faster: { riskLevel: 1, spreadMaxBps: 100, maxPosPctEquity: 20, absMaxNotionalUSD: 200, makerCampSec: 20, enableTakerFlip: true, takerExitOnTouch: true, takerExitGuard: 'fee', touchFlipTimeoutSec: 8,  liveRequireQuote: true, liveFreshMsCrypto: 15000, liveFreshMsStock: 15000, enforceMomentum: true,  enableStops: true, stopLossBps: 25, hardStopLossPct: 1.0, enableTrailing: true, trailStartBps: 15, trailingStopBps: 7,  maxConcurrentPositions: 8, haltOnDailyLoss: true,  dailyMaxLossPct: 5.0 },
      Aggro:  { riskLevel: 0, spreadMaxBps: 120, maxPosPctEquity: 25, absMaxNotionalUSD: 300, makerCampSec: 15, enableTakerFlip: true, takerExitOnTouch: true, takerExitGuard: 'fee', touchFlipTimeoutSec: 7,  liveRequireQuote: true, liveFreshMsCrypto: 15000, liveFreshMsStock: 15000, enforceMomentum: false, enableStops: true, stopLossBps: 25, hardStopLossPct: 1.5, enableTrailing: true, trailStartBps: 12, trailingStopBps: 6,  maxConcurrentPositions: 10,haltOnDailyLoss: true,  dailyMaxLossPct: 6.0 },
      Max:    { riskLevel: 0, spreadMaxBps: 150, maxPosPctEquity: 30, absMaxNotionalUSD: 500, makerCampSec: 10, enableTakerFlip: true, takerExitOnTouch: true, takerExitGuard: 'fee', touchFlipTimeoutSec: 6,  liveRequireQuote: true, liveFreshMsCrypto: 15000, liveFreshMsStock: 15000, enforceMomentum: false, enableStops: true, stopLossBps: 20, hardStopLossPct: 2.0, enableTrailing: true, trailStartBps: 10, trailingStopBps: 5,  maxConcurrentPositions: 12,haltOnDailyLoss: false, dailyMaxLossPct: 8.0 },
    };
    const p = presets[name];
    if (!p) return;
    setSettings((s) => ({ ...s, ...p }));
  };

  /* ------------------------------ 19) UI ------------------------------ */
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={[styles.container, darkMode && styles.containerDark]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerTopRow}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.appTitle, darkMode && styles.titleDark]}>Bullish or Bust</Text>
            <Text style={styles.versionTag}>{VERSION}</Text>
            <TouchableOpacity onPress={() => setShowSettings((v) => !v)} style={[styles.pillToggle, { marginLeft: 8 }]}>
              <Text style={styles.pillText}>⚙️ Settings</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.subTitle}>
            Open {openMeta.positions}/{openMeta.universe}
            <Text style={styles.dot}> • </Text>
            Orders {openMeta.orders}
            <Text style={styles.dot}> • </Text>
            Universe {openMeta.universe}
            {univUpdatedAt ? ` • U↑ ${new Date(univUpdatedAt).toLocaleTimeString()}` : ''}
          </Text>

          {notification && (
            <View style={styles.topBanner}>
              <Text style={styles.topBannerText}>{notification}</Text>
            </View>
          )}
        </View>

        {/* Live Data Health */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Connection / Live Data Health</Text>
          <View style={styles.rowSpace}>
            <Text style={styles.label}>Account</Text>
            <Text style={styles.value}>
              {health.sections?.account?.ok ? 'OK' : '—'}
              {!health.sections?.account?.ok && health.sections?.account?.code ? ` (HTTP ${health.sections.account.code})` : ''}
            </Text>
          </View>
          <View style={styles.rowSpace}>
            <Text style={styles.label}>Stocks quotes</Text>
            <Text style={styles.value}>
              {health.sections?.stocks?.ok ? 'OK' : '—'}
            </Text>
          </View>
          <View style={styles.rowSpace}>
            <Text style={styles.label}>Crypto quotes</Text>
            <Text style={styles.value}>
              {health.sections?.crypto?.ok ? 'OK' : '—'}
            </Text>
          </View>
          <Text style={styles.smallNote}>
            {health.checkedAt ? `Checked ${new Date(health.checkedAt).toLocaleTimeString()}` : 'Not checked yet'}
          </Text>
          <View style={{ marginTop: 8, flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity onPress={checkAlpacaHealth} style={styles.chip}>
              <Text style={styles.chipText}>Re-check</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Settings Panel */}
        {showSettings && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Settings</Text>

            <View style={styles.rowSpace}>
              {['Safer', 'Neutral', 'Faster', 'Aggro', 'Max'].map((p) => (
                <TouchableOpacity key={p} style={styles.chip} onPress={() => applyPreset(p)}>
                  <Text style={styles.chipText}>{p}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.line} />

            <View style={styles.rowSpace}>
              <Text style={styles.label}>Risk level</Text>
              <View style={styles.bumpGroup}>
                <TouchableOpacity style={styles.bumpBtn} onPress={() => bump('riskLevel', -1, { min: 0 })}>
                  <Text style={styles.bumpBtnText}>-</Text>
                </TouchableOpacity>
                <Text style={styles.value}>{settings.riskLevel}</Text>
                <TouchableOpacity style={styles.bumpBtn} onPress={() => bump('riskLevel', +1, { max: 4 })}>
                  <Text style={styles.bumpBtnText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.rowSpace}>
              <Text style={styles.label}>Spread max (bps)</Text>
              <View style={styles.bumpGroup}>
                <TouchableOpacity style={styles.bumpBtn} onPress={() => bump('spreadMaxBps', -5, { min: 3 })}>
                  <Text style={styles.bumpBtnText}>-5</Text>
                </TouchableOpacity>
                <Text style={styles.value}>{settings.spreadMaxBps}</Text>
                <TouchableOpacity style={styles.bumpBtn} onPress={() => bump('spreadMaxBps', +5, { max: 200 })}>
                  <Text style={styles.bumpBtnText}>+5</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.rowSpace}>
              <Text style={styles.label}>Touch flip timeout (s)</Text>
              <View style={styles.bumpGroup}>
                <TouchableOpacity style={styles.bumpBtn} onPress={() => bump('touchFlipTimeoutSec', -1, { min: 2 })}>
                  <Text style={styles.bumpBtnText}>-</Text>
                </TouchableOpacity>
                <Text style={styles.value}>{settings.touchFlipTimeoutSec}</Text>
                <TouchableOpacity style={styles.bumpBtn} onPress={() => bump('touchFlipTimeoutSec', +1, { max: 30 })}>
                  <Text style={styles.bumpBtnText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.rowSpace}>
              <Text style={styles.label}>Require live quote to enter</Text>
              <View style={styles.bumpGroup}>
                <TouchableOpacity
                  style={[styles.chip, { backgroundColor: settings.liveRequireQuote ? '#4caf50' : '#2b2b2b' }]}
                  onPress={() => setSettings((s)=>({ ...s, liveRequireQuote: !s.liveRequireQuote }))}
                >
                  <Text style={styles.chipText}>{settings.liveRequireQuote ? 'ON' : 'OFF'}</Text>
                </TouchableOpacity>
              </View>
            </View>

          </View>
        )}

        {/* Controls + Buying Power */}
        <View style={[styles.toolbar, darkMode && styles.toolbarDark]}>
          <View style={styles.topControlRow}>
            <TouchableOpacity onPress={onRefresh} style={[styles.pillToggle, styles.pillNeutral]}>
              <Text style={styles.pillText}>Refresh</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={cancelAllOrders} style={[styles.pillToggle, styles.btnWarn]}>
              <Text style={styles.pillText}>Cancel Orders</Text>
            </TouchableOpacity>
            <View style={styles.inlineBP}>
              <Text style={styles.bpLabel}>Buying Power</Text>
              <Text style={styles.bpValue}>
                {fmtUSD(bp)} {isUpdatingAcct && <Text style={styles.badgeUpdating}>↻</Text>}
                <Text style={styles.dot}> • </Text>
                <Text style={styles.dayBadge}>Day {fmtPct(chPct)}</Text>
              </Text>
            </View>
          </View>
        </View>

        {/* Transaction CSV viewer */}
        <TxnHistoryCSVViewer />

        {/* PnL & Fees */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>PnL & Fees snapshot</Text>
          <View style={styles.grid2}>
            <View style={styles.statBox}>
              <Text style={styles.label}>Last 7d PnL</Text>
              <Text style={styles.value}>{fmtUSD(pnlSnap.last7Sum)}</Text>
              <Text style={styles.subtle}>{pnlSnap.last7UpDays ?? '—'} up / {pnlSnap.last7DownDays ?? '—'} down</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.label}>Last 30d PnL</Text>
              <Text style={styles.value}>{fmtUSD(pnlSnap.last30Sum)}</Text>
              <Text style={styles.subtle}>Fees 30d: {fmtUSD(pnlSnap.fees30)}</Text>
            </View>
          </View>
          <Text style={styles.smallNote}>
            {pnlSnap.updatedAt ? `Updated ${new Date(pnlSnap.updatedAt).toLocaleTimeString()}` : '—'}
            {pnlSnap.error ? ` • Error: ${pnlSnap.error}` : ''}
          </Text>
        </View>

        {/* Scan Summary */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Scan summary</Text>
          <View style={styles.rowSpace}><Text style={styles.label}>Ready</Text><Text style={styles.value}>{scanStats.ready}</Text></View>
          <View style={styles.rowSpace}><Text style={styles.label}>Attempted</Text><Text style={styles.value}>{scanStats.attempted}</Text></View>
          <View style={styles.rowSpace}><Text style={styles.label}>Filled</Text><Text style={styles.value}>{scanStats.filled}</Text></View>
          <View style={styles.rowSpace}><Text style={styles.label}>Watch</Text><Text style={styles.value}>{scanStats.watch}</Text></View>
          {!!scanStats?.reasons && Object.keys(scanStats.reasons).length > 0 && (
            <>
              <View style={styles.line} />
              <Text style={styles.subtle}>Skipped by reason:</Text>
              {Object.entries(scanStats.reasons).map(([k, v]) => (
                <Text key={k} style={styles.subtle}>• {k}: {v}</Text>
              ))}
            </>
          )}
        </View>

        {/* Live Logs */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Live logs</Text>
          {logHistory.slice(0, 30).map((l, i) => (
            <Text
              key={i}
              style={[
                styles.logLine,
                l.sev === 'success' ? styles.sevSuccess :
                l.sev === 'warn'    ? styles.sevWarn :
                l.sev === 'error'   ? styles.sevError : styles.sevInfo
              ]}
            >
              {new Date(l.ts).toLocaleTimeString()} • {l.text}
            </Text>
          ))}
        </View>

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

/* =============================== 20) STYLES =============================== */
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#121212' },
  container: { flexGrow: 1, paddingTop: 8, paddingHorizontal: 10, backgroundColor: '#fff' },
  containerDark: { backgroundColor: '#121212' },

  header: { alignItems: 'center', justifyContent: 'center', marginBottom: 6, marginTop: 6 },
  headerTopRow: { flexDirection: 'row', alignItems: 'center' },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  appTitle: { fontSize: 16, fontWeight: '800', color: '#000' },
  versionTag: { marginLeft: 8, color: '#90caf9', fontWeight: '800', fontSize: 10 },
  subTitle: { marginTop: 2, fontSize: 11, color: '#9aa0a6' },
  titleDark: { color: '#fff' },
  dot: { color: '#999', fontWeight: '800' },
  topBanner: { marginTop: 6, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#243b55', borderRadius: 8, width: '100%' },
  topBannerText: { color: '#fff', textAlign: 'center', fontWeight: '700', fontSize: 12 },

  toolbar: { backgroundColor: '#f2f2f2', padding: 6, borderRadius: 8, marginBottom: 8 },
  toolbarDark: { backgroundColor: '#1b1b1b' },
  topControlRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' },
  pillToggle: { backgroundColor: '#2b2b2b', paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8 },
  pillNeutral: { backgroundColor: '#3a3a3a' },
  btnWarn: { backgroundColor: '#6b5e23' },
  pillText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  inlineBP: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
  bpLabel: { fontSize: 11, fontWeight: '600', color: '#bbb' },
  bpValue: { fontSize: 13, fontWeight: '800', color: '#e6f0ff' },
  dayBadge: { fontWeight: '800', color: '#e6f0ff' },
  badgeUpdating: { fontSize: 10, color: '#bbb', fontWeight: '600' },

  card: { backgroundColor: '#1b1b1b', borderRadius: 10, padding: 10, marginBottom: 8 },
  cardTitle: { color: '#fff', fontWeight: '800', fontSize: 12, marginBottom: 6 },
  rowSpace: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap' },
  label: { color: '#bbb', fontSize: 11, fontWeight: '600' },
  value: { color: '#e6f0ff', fontSize: 13, fontWeight: '800' },
  subtle: { color: '#9aa0a6', fontSize: 11 },
  smallNote: { color: '#9aa0a6', fontSize: 10, marginTop: 6 },
  line: { height: 1, backgroundColor: '#2a2a2a', marginVertical: 6, borderRadius: 999 },

  chip: { backgroundColor: '#2b2b2b', paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, marginRight: 6, marginBottom: 6 },
  chipText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  bumpGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bumpBtn: { backgroundColor: '#2e2e2e', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  bumpBtnText: { color: '#fff', fontWeight: '800' },

  grid2: { flexDirection: 'row', gap: 8 },
  statBox: { flex: 1, backgroundColor: '#121212', borderRadius: 8, padding: 10 },

  logLine: { fontSize: 11, marginBottom: 2 },
  sevInfo: { color: '#9aa0a6' },
  sevSuccess: { color: '#74f2a8' },
  sevWarn: { color: '#ffd166' },
  sevError: { color: '#ff6b6b' },

  txnBox: { backgroundColor: '#1b1b1b', borderRadius: 10, padding: 10, marginBottom: 8 },
  txnTitle: { color: '#fff', fontWeight: '800', fontSize: 12, marginBottom: 6 },
  txnBtnRow: { flexDirection: 'row', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  txnBtn: { backgroundColor: '#2b2b2b', paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8 },
  txnBtnText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  txnStatus: { color: '#9aa0a6', marginTop: 4, fontSize: 11 },
  csvHelp: { color: '#bbb', fontSize: 11 },
  csvBox: {
    backgroundColor: '#0e0e0e',
    color: '#fff',
    borderRadius: 8,
    padding: 8,
    height: 240,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
