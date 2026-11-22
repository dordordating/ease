import { translate } from "./locales.js";
import { getMarketQuotes } from "./markets-api.js";
import { marketInstrument, marketLabel, validMarketAlert } from "./markets-store.js";
import { readWorkspace, storageKey } from "./workspace-data.js";

export const marketAlertStateKey = "easeMarketAlertState";
const alertAlarm = "ease-market-alerts";
const pollInterval = 5;
const notificationPermission = { permissions: ["notifications"] };

export async function readMarketAlertState() {
  const result = await chrome.storage.local.get(marketAlertStateKey);
  const value = result[marketAlertStateKey];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function alertRules(workspace) {
  const alerts = workspace.markets?.alerts;
  return Array.isArray(alerts)
    ? alerts.filter(alert => typeof alert?.id === "string" && alert.id.length > 0 && validMarketAlert(alert))
    : [];
}

function signature(alert) {
  return `${alert.symbol}:${alert.direction}:${alert.price}`;
}

function delivered(sample) {
  return Number.isFinite(sample?.firedAt) && sample.firedAt > 0;
}

function trimSamples(samples, rules) {
  const known = new Set(rules.map(({ id }) => id));
  return new Map([...samples].flatMap(([id, sample]) => {
    if (known.has(id)) return [[id, sample]];
    // Keep the one-shot marker when a fired rule disappears or is restored.
    return delivered(sample) ? [[id, { firedAt: sample.firedAt }]] : [];
  }));
}

async function persistSamples(before, after) {
  const value = Object.fromEntries(after);
  if (JSON.stringify(value) !== JSON.stringify(Object.fromEntries(before))) {
    await chrome.storage.local.set({ [marketAlertStateKey]: value });
  }
}

async function canNotify() {
  const notifications = chrome.notifications;
  if (typeof notifications?.create !== "function") return false;
  if (chrome.permissions?.contains && !await chrome.permissions.contains(notificationPermission)) return false;
  return !notifications.getPermissionLevel || await notifications.getPermissionLevel() === "granted";
}

function sampleQuote(quote, now) {
  if (quote?.stale !== false || !Number.isFinite(quote.price) || quote.price <= 0 || typeof quote.asOf !== "string") return undefined;
  const sampleAt = Date.parse(quote.asOf);
  if (!Number.isFinite(sampleAt) || sampleAt > now + 60_000) return undefined;
  return { sampleAt, price: quote.price };
}

function matchCrossing(alert, previous, price) {
  if (alert.direction === "above") return previous < alert.price && price >= alert.price;
  return previous > alert.price && price <= alert.price;
}

async function updateAlarm(enabled, current) {
  if (!enabled && current) await chrome.alarms.clear(alertAlarm);
  if (enabled && current?.periodInMinutes !== pollInterval) {
    await chrome.alarms.create(alertAlarm, { periodInMinutes: pollInterval });
  }
}

async function reconcile(mode) {
  const [workspace, deliveryState, alarm, enabled] = await Promise.all([
    readWorkspace(), readMarketAlertState(), chrome.alarms.get(alertAlarm), canNotify()
  ]);
  const rules = alertRules(workspace);
  const stored = new Map(Object.entries(deliveryState));
  const samples = trimSamples(stored, rules);
  await persistSamples(stored, samples);
  const pending = rules.filter(({ id }) => !delivered(samples.get(id)));
  await updateAlarm(enabled && pending.length > 0, alarm);
  if (!enabled || !pending.length) return;
  if (mode === "seed" && !pending.some(alert => samples.get(alert.id)?.rule !== signature(alert))) return;

  let quotes;
  try {
    ({ quotes } = await getMarketQuotes({ symbols: pending.map(alert => alert.symbol) }));
  } catch {
    return;
  }

  // A rule may be removed, restored, or changed while the quote request is in flight.
  const current = await readWorkspace();
  if (!await canNotify()) return;
  const liveRules = alertRules(current);
  const live = new Map(liveRules.map(alert => [alert.id, alert]));
  const next = trimSamples(samples, liveRules);
  const bySymbol = new Map(quotes.map(quote => [quote.symbol, quote]));
  const now = Date.now();
  const crossed = [];

  for (const alert of pending) {
    const rule = signature(alert);
    if (!live.has(alert.id) || signature(live.get(alert.id)) !== rule) continue;
    const quote = sampleQuote(bySymbol.get(alert.symbol), now);
    if (!quote) continue;
    const priorSample = next.get(alert.id);
    const prior = priorSample?.rule === rule ? priorSample : undefined;
    if (quote.sampleAt <= (prior?.sampleAt ?? 0)) continue;
    const previousPrice = prior?.previousPrice;
    const reached = Number.isFinite(previousPrice) && matchCrossing(alert, previousPrice, quote.price);
    next.set(alert.id, {
      rule, sampleAt: quote.sampleAt, previousPrice: quote.price,
      ...(reached ? { firedAt: now } : {})
    });
    if (reached) crossed.push({ alert, price: quote.price });
  }

  // Record crossings before sending notifications so worker restarts can't replay them.
  await persistSamples(samples, next);
  if (!liveRules.some(({ id }) => !delivered(next.get(id)))) await chrome.alarms.clear(alertAlarm);
  if (!crossed.length || !await canNotify()) return;

  const latest = await readWorkspace();
  const ready = new Map(alertRules(latest).map(alert => [alert.id, signature(alert)]));
  const number = new Intl.NumberFormat(latest.locale, { maximumFractionDigits: 8 });
  await Promise.allSettled(crossed
    .filter(({ alert }) => ready.get(alert.id) === signature(alert))
    .map(({ alert, price }) => chrome.notifications.create(
      `ease-market-${alert.id}`,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/128.png"),
        title: translate(latest.locale, "markets"),
        message: translate(latest.locale, "marketsAlertNotification", {
          symbol: marketLabel(marketInstrument(alert.symbol, latest.markets?.instruments?.[alert.symbol])),
          price: number.format(price)
        })
      }
    )));
}

export function registerMarketAlertHandlers() {
  if (!chrome.alarms?.get || !chrome.alarms?.onAlarm) return;
  let queue = Promise.resolve();
  const sync = (mode = "seed") => {
    queue = queue.then(() => reconcile(mode)).catch(() => {});
    return queue;
  };

  chrome.alarms.onAlarm.addListener(({ name }) => {
    if (name === alertAlarm) return sync("poll");
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[storageKey];
    if (area === "local" && change
      && JSON.stringify(change.oldValue?.markets?.alerts) !== JSON.stringify(change.newValue?.markets?.alerts)) {
      return sync();
    }
  });
  chrome.runtime.onInstalled?.addListener(() => sync());
  chrome.runtime.onStartup?.addListener(() => sync("poll"));
  const syncPermission = ({ permissions }) => {
    if (permissions?.includes("notifications")) return sync();
  };
  chrome.permissions?.onAdded?.addListener(syncPermission);
  chrome.permissions?.onRemoved?.addListener(syncPermission);
  chrome.notifications?.onPermissionLevelChanged?.addListener(() => sync());
  return sync();
}
