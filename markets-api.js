import { marketInstrument } from "./markets-store.js";

const marketsUrl = "https://ease-api.144.76.164.115.sslip.io/v1/markets/";
const maxResponseBytes = 64 * 1024;
const maxQuotes = 64;
const maxTrendPoints = 30;
const iconMimes = new Set(["image/png", "image/jpeg", "image/webp"]);
const fxDate = /^\d{4}-\d{2}-\d{2}$/;
const cryptoTime = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/;

function unavailable() {
  return Object.assign(new Error("Market data is unavailable"), { code: "marketsUnavailable" });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPrice(value) {
  return Number.isFinite(value) && value > 0;
}

function parseTimestamp(value, kind) {
  const pattern = kind === "fx" ? fxDate : cryptoTime;
  if (typeof value !== "string" || !pattern.test(value)) return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
  return time;
}

async function readResponse(response) {
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw unavailable();
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function request(url, signal) {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(12_000);
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    const result = await readResponse(response);
    signal?.throwIfAborted();
    return result;
  } catch {
    signal?.throwIfAborted();
    throw unavailable();
  }
}

export async function getMarketQuotes({ symbols, signal } = {}) {
  const url = new URL("quotes", marketsUrl);
  if (symbols) {
    const keys = [...new Set(symbols)].filter(symbol => marketInstrument(symbol));
    if (!keys.length) return { quotes: [] };
    url.searchParams.set("symbols", keys.slice(0, 50).join(","));
  }
  const data = await request(url, signal);
  if (!isObject(data) || !Array.isArray(data.quotes) || data.quotes.length > maxQuotes) throw unavailable();

  const seen = new Set();
  const quotes = [];
  for (const quote of data.quotes) {
    if (!isObject(quote) || typeof quote.symbol !== "string") throw unavailable();
    const instrument = marketInstrument(quote.symbol);
    if (!instrument) continue;
    const { symbol, price, changePercent, asOf, stale, trend } = quote;
    if (seen.has(symbol)
      || (price !== null && !isPrice(price))
      || (changePercent !== null && (!Number.isFinite(changePercent) || changePercent < -100))
      || (asOf !== null && !Number.isFinite(parseTimestamp(asOf, instrument.kind)))
      || typeof stale !== "boolean"
      || !Array.isArray(trend) || trend.length > maxTrendPoints || !trend.every(isPrice)) {
      throw unavailable();
    }
    seen.add(symbol);
    quotes.push({ symbol, price, changePercent, asOf, stale, trend });
  }
  return { quotes };
}

export async function searchMarkets(query, kind, { signal } = {}) {
  const url = new URL("catalogue", marketsUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("kind", kind);
  const data = await request(url, signal);
  if (!isObject(data) || !Array.isArray(data.instruments) || data.instruments.length > 24) throw unavailable();
  return data.instruments.map(item => marketInstrument(item?.symbol, item)).filter(Boolean);
}

export async function getMarketIcon(symbol) {
  const url = new URL("icon", marketsUrl);
  url.searchParams.set("symbol", symbol);
  const response = await fetch(url, {
    credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(14_000)
  });
  const type = response.headers.get("content-type");
  if (!response.ok || !iconMimes.has(type) || !response.body) return null;
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
    return size ? new Blob(parts, { type }) : null;
  } finally {
    reader.releaseLock();
  }
}

export async function getMarketHistory(symbol, { signal } = {}) {
  const instrument = marketInstrument(symbol);
  if (!instrument) throw unavailable();
  const url = new URL("history", marketsUrl);
  url.searchParams.set("symbol", symbol);
  const data = await request(url, signal);
  if (!isObject(data) || data.symbol !== symbol || typeof data.stale !== "boolean"
    || !Array.isArray(data.points) || data.points.length > (instrument.kind === "fx" ? 30 : 180)) {
    throw unavailable();
  }

  let previousTime = -Infinity;
  const points = data.points.map((point) => {
    if (!isObject(point) || !isPrice(point.value)) throw unavailable();
    const time = parseTimestamp(point.at, instrument.kind);
    if (!Number.isFinite(time) || time <= previousTime) throw unavailable();
    previousTime = time;
    return { at: point.at, value: point.value };
  });
  return { symbol, points, stale: data.stale };
}
