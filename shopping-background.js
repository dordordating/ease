import { translate } from "./locales.js";
import { defaultWorkspace, moduleAvailable, storageKey } from "./workspace-data.js";
import { workspaceOwnerKey } from "./workspace-accounts.js";
import {
  digikalaProductUrl, restoreShopping, shoppingObservationKey, shoppingPollMinutes, shoppingProductLink, shoppingProductUrl,
  shoppingStatus, shoppingWatchKey
} from "./shopping-store.js";
import {
  quoteForWatch, ShoppingLookupError, shoppingHostPermission, shoppingNotificationPermission
} from "./shopping-digikala.js";
import { readShoppingProduct, searchShopping, shoppingPermission, shoppingPermissions } from "./shopping-catalog.js";
import { prepareDigikalaCart, waitForShopTab } from "./shopping-cart.js";
import { checkDigikalaOrderStatuses, previewDigikalaInvoice, readDigikalaDeliveryChoices } from "./shopping-checkout-digikala.js";
import { DigikalaCheckoutError, isDigikalaPage, withDigikalaTab } from "./shopping-digikala-session.js";
import { canRetryShoppingPurchase, purchaseJobApplies, readShoppingPurchases, shoppingPaymentKey, shoppingPurchasePrefix } from "./shopping-purchase-store.js";
import { maintainShoppingOrders, nextShoppingOrderWork, shoppingOrdersToCheck } from "./shopping-orders.js";
import { fillDigikalaCart, shoppingPurchases } from "./shopping-purchases.js";

export const shoppingMessage = "ease-shopping";
const alarmName = "ease-shopping-check";
const menuId = "ease-shopping-track-digikala";
const notificationPrefix = "ease-shopping-watch:";
const interval = shoppingPollMinutes * 60_000;
const storeOf = watch => watch.store ?? "digikala";
const productKey = watch => `${storeOf(watch)}:${watch.productId}`;

async function shoppingAccess() {
  const stores = await Promise.all(Object.entries(shoppingPermissions).map(async ([store, permission]) =>
    await chrome.permissions.contains(permission) ? store : null));
  return new Set(stores.filter(Boolean));
}

async function currentShopping() {
  const stored = await chrome.storage.local.get([storageKey, workspaceOwnerKey]);
  const workspace = { ...defaultWorkspace, ...stored[storageKey] };
  const owner = stored[workspaceOwnerKey] ?? null;
  const enabled = workspace.tabs.includes("shopping") && moduleAvailable("shopping", workspace.locale);
  return { workspace, owner, key: shoppingObservationKey(owner), locale: workspace.locale, enabled,
    watches: restoreShopping(workspace.shopping) ?? [] };
}

function active(watch, now) {
  return !watch.paused && (watch.endAt === null || now < watch.endAt);
}

async function canNotify() {
  return await chrome.permissions.contains(shoppingNotificationPermission)
    && typeof chrome.notifications?.create === "function"
    && (!chrome.notifications.getPermissionLevel || await chrome.notifications.getPermissionLevel() === "granted");
}

async function readObservations(key) {
  return (await chrome.storage.local.get(key))[key] ?? {};
}

function nextCheck(watch, observations, now) {
  const sample = observations[watch.id];
  const next = sample?.rule === shoppingWatchKey(watch) ? sample.checkedAt + interval : now;
  return Math.max(watch.startAt ?? 0, next);
}

async function scheduleAlarm(context, observations, purchaseState, access) {
  const now = Date.now();
  const pending = context.enabled ? context.watches.filter(watch => access.has(storeOf(watch)) && active(watch, now)
    && purchaseState.jobs[watch.id]?.status !== "paid") : [];
  const orders = nextShoppingOrderWork(context.watches, { ...purchaseState, owner: context.owner }, now,
    context.enabled && access.has("digikala"));
  const next = Math.min(orders ?? Infinity, ...pending.map(watch => nextCheck(watch, observations, now)));
  if (Number.isFinite(next)) {
    await chrome.alarms.create(alarmName, { when: Math.max(now + 1000, next) });
  } else {
    await chrome.alarms.clear(alarmName);
  }
}

async function checkProducts(watches) {
  const products = new Map();
  const unique = [...new Map(watches.map(watch => [productKey(watch), watch]))];
  for (let offset = 0; offset < unique.length; offset += 4) {
    await Promise.all(unique.slice(offset, offset + 4).map(async ([key, watch]) => {
      try { products.set(key, { product: await readShoppingProduct(watch), error: null }); }
      catch (error) { products.set(key, { error: lookupError(error) }); }
    }));
  }
  return products;
}

function lookupError(error) {
  return error instanceof ShoppingLookupError || error instanceof DigikalaCheckoutError ? error.code : "shoppingUnavailable";
}

function updateWatchDetails(watch, quote) {
  const changes = { title: quote.title, image: quote.image || watch.image };
  if (watch.variantId && quote.sellerName) {
    changes.variantLabel = quote.variantLabel;
    if (quote.sellerId) changes.sellerId = quote.sellerId;
    changes.sellerName = quote.sellerName;
  }
  return Object.entries(changes).some(([key, value]) => watch[key] !== value) ? { ...watch, ...changes } : watch;
}

function showAlert(watch, quote, locale, alertedAt) {
  const amount = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(quote.price / 10);
  const price = translate(locale, "shoppingTomanPrice", { amount });
  return chrome.notifications.create(`${notificationPrefix}${watch.id}:${alertedAt}`, {
    type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"),
    title: quote.title || watch.title,
    message: translate(locale, "shoppingNotification", { price }),
    buttons: [{ title: translate(locale, watch.store === "snappshop" ? "shoppingOpenProduct" : "shoppingPrepareCart") }]
  });
}

async function reconcile(force, queueWorkspace, retry, id, ordersOnly) {
  const context = await currentShopping();
  const [access, observations, initialPurchases] = await Promise.all([
    shoppingAccess(), readObservations(context.key), readShoppingPurchases(context.owner)
  ]);
  const now = Date.now();
  const tracking = access.has("digikala") && context.enabled;
  const pending = context.enabled && !ordersOnly ? context.watches.filter(watch => access.has(storeOf(watch)) &&
    (!id || watch.id === id) && initialPurchases.jobs[watch.id]?.status !== "paid" && active(watch, now)
    && (force || watch.startAt === null || watch.startAt <= now)
    && (force || nextCheck(watch, observations, now) <= now + 1000)) : [];
  const orders = tracking ? shoppingOrdersToCheck(context.watches, initialPurchases, now, ordersOnly || (retry && !id)) : [];
  const orderWork = nextShoppingOrderWork(context.watches, { ...initialPurchases, owner: context.owner }, now, tracking);
  if (!pending.length && !orders.length && (orderWork === null || orderWork > now)
    && Object.keys(observations).every(id => context.watches.some(watch => watch.id === id))) {
    await scheduleAlarm(context, observations, initialPurchases, access);
    return;
  }

  const [products, orderUpdates] = await Promise.all([checkProducts(pending), checkDigikalaOrderStatuses(orders)]);
  return queueWorkspace(async () => {
    const latest = await currentShopping();
    if (latest.owner !== context.owner) return;
    const allowed = await shoppingAccess();
    const notify = allowed.size > 0 && await canNotify();
    const newest = await readObservations(context.key);
    const purchaseState = await readShoppingPurchases(context.owner);
    const { policy } = purchaseState;
    const next = {};
    const checked = new Map(pending.map(watch => [watch.id, shoppingWatchKey(watch)]));
    const checkedAt = Date.now();
    const { watches, jobs, history } = maintainShoppingOrders(latest.watches, { ...purchaseState, owner: latest.owner }, orderUpdates, checkedAt);
    const notices = [];
    const attempts = [];
    const updated = watches.map(watch => {
      const rule = shoppingWatchKey(watch);
      const previous = newest[watch.id]?.rule === rule ? newest[watch.id] : null;
      if (!latest.enabled || !allowed.has(storeOf(watch)) || jobs[watch.id]?.status === "paid" || !active(watch, checkedAt) || checked.get(watch.id) !== rule) {
        if (previous) next[watch.id] = previous;
        return watch;
      }
      const { product, error } = products.get(productKey(watch));
      const quote = product ? quoteForWatch(product, watch) : previous?.quote ?? null;
      const sample = { rule, quote, checkedAt, error, alertedAt: previous?.alertedAt ?? null };
      if (shoppingStatus(watch, sample, checkedAt) === "shoppingReady") {
        const job = jobs[watch.id];
        if (job?.status === "armed" && purchaseJobApplies(watch, job, policy)) {
          attempts.push({ id: watch.id });
          sample.alertedAt ??= checkedAt;
        } else if (retry && canRetryShoppingPurchase(watch, job, purchaseState)) {
          attempts.push({ id: watch.id, retryToken: job.token });
          sample.alertedAt ??= checkedAt;
        } else if (notify && !sample.alertedAt && !job) {
          sample.alertedAt = checkedAt;
          notices.push({ watch, quote });
        }
      }
      next[watch.id] = sample;
      return product ? updateWatchDetails(watch, quote) : watch;
    });
    const changes = {};
    if (JSON.stringify(next) !== JSON.stringify(newest)) changes[context.key] = next;
    if (updated.length !== latest.watches.length || updated.some((watch, index) => watch !== latest.watches[index])) {
      changes[storageKey] = { ...latest.workspace, shopping: updated };
    }
    if (JSON.stringify(jobs) !== JSON.stringify(purchaseState.jobs) || JSON.stringify(history) !== JSON.stringify(purchaseState.history)) {
      changes[purchaseState.key] = { policy, jobs, history };
    }
    if (Object.keys(changes).length) await chrome.storage.local.set(changes);
    await scheduleAlarm({ ...latest, watches: updated }, next, { ...purchaseState, jobs, history }, allowed);
    await Promise.allSettled(notices.map(({ watch, quote }) => showAlert(watch, quote, latest.locale, checkedAt)));
    return { owner: latest.owner, attempts };
  });
}

function openShopping({ watch, product, issue } = {}) {
  const route = new URL(chrome.runtime.getURL("workspace.html"));
  route.searchParams.set("surface", "panel");
  route.searchParams.set("open", "shopping");
  if (watch) route.searchParams.set("watch", watch);
  if (product) {
    route.searchParams.set("product", product.productId);
    if (product.store) route.searchParams.set("store", product.store);
    if (product.variantId) route.searchParams.set("variant", product.variantId);
    if (product.title) route.searchParams.set("productTitle", product.title);
  }
  if (issue) route.searchParams.set("shoppingIssue", issue);
  return chrome.tabs.create({ url: route.href });
}

export function registerShoppingHandlers(queueWorkspace, fromWorkspacePage) {
  let pending = Promise.resolve();
  let menuPending = Promise.resolve();
  let notificationListeners = false;
  const cartRequests = new Map();
  const purchases = shoppingPurchases(queueWorkspace, currentShopping, openShopping);
  const run = (force = false, { retry = false, id, ordersOnly = false } = {}) => {
    const check = pending.then(() => reconcile(force, queueWorkspace, retry, id, ordersOnly)).then(ready => {
      if (ready?.attempts.length) void purchases.run(ready.owner, ready.attempts).catch(() => {});
    });
    pending = check.catch(() => {});
    return check;
  };
  const poll = force => run(force).catch(() => {});
  const updateMenu = () => {
    if (!chrome.contextMenus?.update) return;
    menuPending = menuPending.then(async () => {
      const { locale, enabled } = await currentShopping();
      const config = { title: translate(locale, "shoppingTrackHere"), visible: enabled, contexts: ["page"],
        documentUrlPatterns: ["https://www.digikala.com/product/dkp-*", "https://snappshop.ir/product/snp-*",
          "https://www.snappshop.ir/product/snp-*"] };
      await new Promise(resolve => chrome.contextMenus.update(menuId, config, () => {
        if (!chrome.runtime.lastError) resolve();
        else chrome.contextMenus.create({ id: menuId, ...config }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      }));
    }).catch(() => {});
  };

  async function addToCart(id) {
    const context = await currentShopping();
    const watch = context.enabled && context.watches.find(watch => watch.id === id);
    if (!watch) return { error: "shoppingRuleMissing" };
    const { payment, jobs } = await readShoppingPurchases(context.owner);
    if (payment && watch.store !== "snappshop") return { error: "shoppingPurchasePending" };
    if (jobs[id]) return { error: "shoppingPurchaseUseCheckout" };
    if (!await chrome.permissions.contains(shoppingPermission(watch.store))) return { error: "shoppingConnect" };
    const refresh = () => poll(true);
    try {
      const product = await readShoppingProduct(watch);
      const quote = quoteForWatch(product, watch);
      const rule = shoppingWatchKey(watch);
      const checkedAt = Date.now();
      const authorized = async () => {
        const latest = await currentShopping();
        const current = latest.enabled && latest.watches.find(item => item.id === id);
        return latest.owner === context.owner && current && shoppingWatchKey(current) === rule
          && shoppingStatus(current, { rule, quote, checkedAt }) === "shoppingReady";
      };
      if (!await authorized()) {
        void refresh();
        return { error: "shoppingConditionsChanged" };
      }
      if (watch.store === "snappshop") {
        await chrome.tabs.create({ url: shoppingProductUrl(watch) });
        return { ok: true, clicked: true };
      }
      if (watch.quantity > 1) {
        const tab = await chrome.tabs.create({ url: digikalaProductUrl(watch.productId, quote.variantId) });
        if (!Number.isInteger(tab.id) || tab.incognito || !await waitForShopTab(tab.id, isDigikalaPage)) {
          return { error: "shoppingPurchaseConnection" };
        }
        await fillDigikalaCart(tab, watch, quote, { cart: "include" }, authorized);
        return { ok: true, clicked: true };
      }
      const clicked = await prepareDigikalaCart(watch, quote, authorized);
      return { ok: true, clicked };
    } catch (error) {
      void refresh();
      return { error: lookupError(error) };
    }
  }

  function requestCart(id) {
    if (!cartRequests.has(id)) {
      cartRequests.set(id, purchases.queue(() => addToCart(id)).finally(() => cartRequests.delete(id)));
    }
    return cartRequests.get(id);
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== shoppingMessage || !fromWorkspacePage(sender)) return;
    const { action, id, input, token } = message;
    let result;
    if (action === "connect" || action === "notify") {
      const permission = action === "connect" ? shoppingPermission(message.store) : shoppingNotificationPermission;
      result = chrome.permissions.request(permission).then(ok => {
        if (ok) void poll(true);
        return ok ? { ok } : { error: action === "connect" ? "shoppingAccessDenied" : "shoppingNotificationDenied" };
      });
    } else if (action === "refresh") {
      result = run(true, { retry: true, id }).then(() => ({ ok: true }));
    } else if (action === "refresh-orders") {
      result = run(false, { ordersOnly: true }).then(() => ({ ok: true }));
    } else if (action === "cart") {
      result = requestCart(id);
    } else if (action === "open-checkout") {
      result = purchases.open(id);
    } else if (action === "confirm-credit") {
      result = purchases.confirmCredit(id, token);
    } else if (action === "addresses") {
      result = (async () => {
        if (!(await currentShopping()).enabled) return { error: "shoppingUnavailable" };
        if (!await chrome.permissions.contains(shoppingHostPermission)) return { error: "shoppingConnect" };
        return withDigikalaTab(readDigikalaDeliveryChoices);
      })();
    } else if (action === "invoice-preview") {
      result = (async () => {
        const context = await currentShopping();
        if (!context.enabled || !await chrome.permissions.contains(shoppingHostPermission)) return { quote: null };
        return { quote: await previewDigikalaInvoice(input).catch(() => null) };
      })();
    } else if (action === "lookup") {
      result = (async () => {
        if (!(await currentShopping()).enabled) return { error: "shoppingUnavailable" };
        const link = shoppingProductLink(input);
        const store = link ? storeOf(link) : message.store === "snappshop" ? "snappshop" : "digikala";
        if (!link && (typeof input !== "string" || !input.trim() || input.length > 140 || /:\/\/|^www\./iu.test(input))) {
          return { error: "shoppingInvalidLink" };
        }
        if (!await chrome.permissions.contains(shoppingPermission(store))) return { error: "shoppingConnect" };
        if (link) return { product: await readShoppingProduct(link), variantId: link.variantId };
        return { products: await searchShopping(store, input.trim()) };
      })();
    } else return;
    result.then(respond, error => respond({ error: lookupError(error) }));
    return true;
  });

  chrome.contextMenus?.onClicked?.addListener(info => {
    if (info.menuItemId !== menuId) return;
    const product = shoppingProductLink(info.pageUrl);
    if (product) currentShopping().then(context => context.enabled && openShopping({ product })).catch(() => {});
  });
  const notificationWatch = async notificationId => {
    if (!notificationId.startsWith(notificationPrefix)) return null;
    const [id, stamp] = notificationId.slice(notificationPrefix.length).split(":");
    const context = await currentShopping();
    const watch = context.enabled && context.watches.find(watch => watch.id === id);
    if (!watch) return null;
    const sample = (await readObservations(context.key))[id];
    return sample?.rule === shoppingWatchKey(watch) && String(sample.alertedAt) === stamp ? id : null;
  };
  function registerNotifications() {
    if (notificationListeners || !chrome.notifications?.onClicked) return;
    notificationListeners = true;
    chrome.notifications.onClicked.addListener(notificationId => {
      notificationWatch(notificationId).then(watch => watch && openShopping({ watch })).catch(() => {});
    });
    chrome.notifications.onButtonClicked?.addListener((notificationId, index) => {
      if (index !== 0) return;
      notificationWatch(notificationId).then(async watch => {
        if (!watch) return;
        const result = await requestCart(watch);
        if (result.error) await openShopping({ watch, issue: result.error });
      }).catch(() => {});
    });
  }
  registerNotifications();
  const recover = () => purchases.recover().catch(() => {});
  void recover();
  chrome.alarms.onAlarm.addListener(({ name }) => {
    if (name === alarmName) return recover().then(() => poll(false));
  });
  chrome.runtime.onInstalled?.addListener(() => { updateMenu(); return recover().then(() => poll(true)); });
  chrome.runtime.onStartup?.addListener(() => { updateMenu(); return recover().then(() => poll(false)); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const armed = Object.entries(changes).some(([key, value]) =>
      key.startsWith(shoppingPurchasePrefix)
      && Object.entries(value.newValue?.jobs ?? {}).some(([id, job]) =>
        job.status === "armed" && job.token !== value.oldValue?.jobs?.[id]?.token));
    if (armed) void poll(true);
    const paid = Object.entries(changes).some(([key, value]) => key.startsWith(shoppingPurchasePrefix)
      && Object.entries(value.newValue?.jobs ?? {}).some(([id, job]) =>
        job.status === "paid" && value.oldValue?.jobs?.[id]?.status !== "paid"));
    if (paid || (changes[shoppingPaymentKey]?.oldValue && !changes[shoppingPaymentKey]?.newValue)) void poll(false);
    const change = changes[storageKey];
    if (!change) return;
    const before = change.oldValue;
    const after = change.newValue;
    const toggled = before?.tabs?.includes("shopping") !== after?.tabs?.includes("shopping");
    const visibilityChanged = moduleAvailable("shopping", before?.locale) !== moduleAvailable("shopping", after?.locale);
    if (toggled || before?.locale !== after?.locale) updateMenu();
    if (toggled || visibilityChanged || JSON.stringify(before?.shopping) !== JSON.stringify(after?.shopping)
      || changes[workspaceOwnerKey]) return poll(visibilityChanged);
  });
  const permissionsChanged = ({ origins, permissions }) => {
    if (permissions?.includes("notifications")) registerNotifications();
    if (origins?.some(origin => Object.values(shoppingPermissions).some(permission => permission.origins.includes(origin)))
      || permissions?.includes("notifications")) return poll(false);
  };
  chrome.permissions.onAdded?.addListener(permissionsChanged);
  chrome.permissions.onRemoved?.addListener(permissionsChanged);
}
