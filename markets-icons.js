import { getMarketIcon } from "./markets-api.js";
import { marketInstrument } from "./markets-store.js";
import { readWorkspace } from "./workspace-data.js";

export const marketIconMessage = "ease-market-icon";

const storeName = "icons";
const maxIcons = 128;
const fetched = new Map();
const pending = new Map();
const legacyCoinIds = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple" };
let opening;

export function marketIconKey(symbol) {
  const instrument = marketInstrument(symbol);
  if (instrument?.kind === "wallex") return `wallex:${instrument.base}`;
  if (instrument?.kind !== "crypto") return undefined;
  const coin = symbol.startsWith("cg:") ? symbol.slice(3, symbol.indexOf("/")) : legacyCoinIds[instrument.base];
  return coin ? `coin:${coin}` : undefined;
}

function openIconStore() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("ease-market-icons", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: "id" }).createIndex("savedAt", "savedAt");
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        opening = undefined;
        database.close();
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

export async function readCachedMarketIcon(key) {
  if (!key) return null;
  try {
    const database = await openIconStore();
    return await new Promise((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result?.blob ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function writeCachedMarketIcon(key, blob) {
  const [database, { markets }] = await Promise.all([openIconStore(), readWorkspace()]);
  const kept = new Set((markets?.watchlist ?? []).map(marketIconKey));
  kept.add(key);
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    store.put({ id: key, blob, savedAt: Date.now() });
    const count = store.count();
    count.onsuccess = () => {
      let excess = count.result - maxIcons;
      if (excess <= 0) return;
      const cursor = store.index("savedAt").openKeyCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry || excess <= 0) return;
        if (!kept.has(entry.primaryKey)) {
          store.delete(entry.primaryKey);
          excess--;
        }
        entry.continue();
      };
    };
  });
}

export function cacheMarketIcon(symbol) {
  const key = marketIconKey(symbol);
  if (!key) return Promise.resolve(false);
  if (pending.has(key)) return pending.get(key);
  const request = (async () => {
    if (await readCachedMarketIcon(key)) return true;
    if ((fetched.get(key) ?? 0) > Date.now()) return false;
    try {
      const blob = await getMarketIcon(symbol);
      if (blob) {
        await writeCachedMarketIcon(key, blob);
        return true;
      }
    } catch {
      // Icons are optional, and the row can still show the asset's symbol.
    }
    fetched.delete(key);
    fetched.set(key, Date.now() + 5 * 60_000);
    if (fetched.size > maxIcons) fetched.delete(fetched.keys().next().value);
    return false;
  })().finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
