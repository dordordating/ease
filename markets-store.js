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
  ["ETH/EUR", "crypto", "Ether / Euro"]
].map(([symbol, kind, name]) => {
  const [base, quote] = symbol.split("/");
  return Object.freeze({ symbol, kind, base, quote, name });
}));

export const defaultMarkets = Object.freeze({
  watchlist: Object.freeze(["EUR/USD", "USD/JPY", "BTC/USD", "ETH/USD"]),
  alerts: Object.freeze([])
});

const symbols = new Set(marketInstruments.map(({ symbol }) => symbol));
const maxAlerts = 50;

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
  return symbols.has(alert?.symbol) && (alert.direction === "above" || alert.direction === "below")
    && Number.isFinite(alert.price) && alert.price > 0 && alert.price <= 1e12;
}

function marketState(state) {
  const watchlist = Array.isArray(state?.watchlist) ? state.watchlist : defaultMarkets.watchlist;
  return {
    ...state,
    watchlist: [...new Set(watchlist.filter(symbol => symbols.has(symbol)))],
    alerts: Array.isArray(state?.alerts) ? state.alerts : defaultMarkets.alerts
  };
}

export function updateMarketWatchlist(state, { symbol, action } = {}) {
  if (!symbols.has(symbol) || !["add", "remove", "up", "down"].includes(action)) throw invalid();
  const next = marketState(state);
  const index = next.watchlist.indexOf(symbol);
  if (action === "add") {
    if (index < 0) next.watchlist.push(symbol);
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
  return next;
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
  return next;
}

export function removeMarketAlert(state, id) {
  if (typeof id !== "string" || !id) throw invalid();
  const next = marketState(state);
  next.alerts = next.alerts.filter(alert => alert.id !== id);
  return next;
}
