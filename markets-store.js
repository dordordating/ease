export const marketInstruments = Object.freeze([
  ["EUR/USD", "fx", "Euro / US dollar"],
  ["USD/JPY", "fx", "US dollar / Japanese yen"],
  ["GBP/USD", "fx", "British pound / US dollar"],
  ["EUR/GBP", "fx", "Euro / British pound"],
  ["USD/CHF", "fx", "US dollar / Swiss franc"],
  ["USD/CAD", "fx", "US dollar / Canadian dollar"],
  ["AUD/USD", "fx", "Australian dollar / US dollar"],
  ["EUR/JPY", "fx", "Euro / Japanese yen"],
  ["BTC/USD", "crypto", "Bitcoin / US dollar"],
  ["ETH/USD", "crypto", "Ether / US dollar"],
  ["SOL/USD", "crypto", "Solana / US dollar"],
  ["XRP/USD", "crypto", "XRP / US dollar"],
  ["BTC/EUR", "crypto", "Bitcoin / Euro"],
  ["ETH/EUR", "crypto", "Ether / Euro"],
  ["wlx:BTC/TMN", "wallex", "Bitcoin"],
  ["wlx:ETH/TMN", "wallex", "Ether"],
  ["wlx:USDT/TMN", "wallex", "Tether"]
].map(([symbol, kind, name]) => {
  const [base, quote] = symbol.replace(/^wlx:/u, "").split("/");
  return Object.freeze({ symbol, kind, base, quote, name });
}));

export const defaultMarkets = Object.freeze({
  watchlist: Object.freeze(["EUR/USD", "USD/JPY", "BTC/USD", "ETH/USD"]),
  alerts: Object.freeze([])
});

const instruments = new Map(marketInstruments.map(item => [item.symbol, item]));
const fxCode = "[A-Z]{3}";
const coinId = "[a-z0-9][a-z0-9_-]{0,119}";
const cryptoPair = new RegExp(`^cg:(${coinId})/(cg:${coinId}|[a-z0-9]{2,5})$`, "u");
const localPair = /^wlx:([A-Z0-9][A-Z0-9._-]{0,19})\/(TMN|USDT)$/u;
const fxPair = new RegExp(`^(${fxCode})/(${fxCode})$`, "u");
const maxAlerts = 50;
const maxWatchlist = 50;

export function marketInstrument(symbol, saved) {
  if (typeof symbol !== "string" || symbol.length > 245) return undefined;
  const featured = instruments.get(symbol);
  if (featured) return featured;
  const pair = fxPair.exec(symbol) ?? localPair.exec(symbol) ?? cryptoPair.exec(symbol);
  if (!pair || pair[1] === pair[2] || `cg:${pair[1]}` === pair[2]) return undefined;
  const kind = symbol.startsWith("cg:") ? "crypto" : symbol.startsWith("wlx:") ? "wallex" : "fx";
  const base = pair[1].toUpperCase();
  const quote = pair[2].replace(/^cg:/u, "").toUpperCase();
  const fallback = { symbol, kind, base, quote, name: base };
  const validName = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit;
  if (saved?.symbol !== symbol || saved.kind !== kind
    || !validName(saved.base, 24) || !validName(saved.quote, 24) || !validName(saved.name, 100)) return fallback;
  if (kind !== "crypto" && (saved.base !== base || saved.quote !== quote)) return fallback;
  return {
    symbol, kind, base: saved.base, quote: saved.quote, name: saved.name,
    ...(validName(saved.quoteName, 100) ? { quoteName: saved.quoteName } : {})
  };
}

export function marketLabel({ base, quote }) {
  return `${base}/${quote}`;
}

export function workspaceMarketInstruments(state) {
  const saved = state?.instruments ?? {};
  const watchlist = Array.isArray(state?.watchlist) ? state.watchlist : [];
  const alerts = Array.isArray(state?.alerts) ? state.alerts : [];
  const ids = new Set([
    ...instruments.keys(), ...watchlist, ...alerts.map(alert => alert?.symbol)
  ]);
  return [...ids].map(symbol => marketInstrument(symbol, saved[symbol])).filter(Boolean);
}

export class MarketPreferenceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function invalid() {
  return new MarketPreferenceError("marketsInvalidPreference");
}

export function validMarketAlert(alert) {
  return Boolean(marketInstrument(alert?.symbol)) && (alert.direction === "above" || alert.direction === "below")
    && Number.isFinite(alert.price) && alert.price > 0 && alert.price <= 1e12;
}

function marketState(state) {
  const watchlist = Array.isArray(state?.watchlist) ? state.watchlist : defaultMarkets.watchlist;
  return {
    ...state,
    watchlist: [...new Set(watchlist.filter(symbol => marketInstrument(symbol)))].slice(0, maxWatchlist),
    alerts: Array.isArray(state?.alerts) ? state.alerts : defaultMarkets.alerts
  };
}

function withInstrument(state, symbol, saved) {
  const known = { ...state.instruments };
  if (saved && !instruments.has(symbol)) known[symbol] = marketInstrument(symbol, saved);
  const used = new Set([...state.watchlist, ...state.alerts.map(item => item.symbol)]);
  state.instruments = Object.fromEntries(Object.entries(known).filter(([key]) => used.has(key)));
  return state;
}

export function updateMarketWatchlist(state, { symbol, action, instrument } = {}) {
  if (!marketInstrument(symbol) || !["add", "remove", "up", "down"].includes(action)) throw invalid();
  const next = marketState(state);
  const index = next.watchlist.indexOf(symbol);
  if (action === "add") {
    if (index < 0) {
      if (next.watchlist.length >= maxWatchlist) throw invalid();
      next.watchlist.push(symbol);
    }
  } else if (index >= 0) {
    if (action === "remove") {
      next.watchlist.splice(index, 1);
    } else {
      const destination = index + (action === "up" ? -1 : 1);
      if (destination >= 0 && destination < next.watchlist.length) {
        [next.watchlist[index], next.watchlist[destination]] = [next.watchlist[destination], symbol];
      }
    }
  }
  return withInstrument(next, symbol, instrument);
}

export function addMarketAlert(state, data) {
  if (!validMarketAlert(data)) throw invalid();
  const next = marketState(state);
  const { symbol, direction, price } = data;
  if (next.alerts.some(alert => alert.symbol === symbol && alert.direction === direction && alert.price === price)) {
    throw new MarketPreferenceError("marketsAlertDuplicate");
  }
  if (next.alerts.length >= maxAlerts) throw new MarketPreferenceError("marketsAlertLimit");
  next.alerts = [...next.alerts, { id: crypto.randomUUID(), symbol, direction, price, createdAt: Date.now() }];
  return withInstrument(next, symbol, data.instrument);
}

export function removeMarketAlert(state, id) {
  if (typeof id !== "string" || !id) throw invalid();
  const next = marketState(state);
  next.alerts = next.alerts.filter(alert => alert.id !== id);
  return withInstrument(next);
}
