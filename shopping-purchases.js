import { translate } from "./locales.js";
import { workspaceOwnerKey } from "./workspace-accounts.js";
import { addDigikalaTabItem } from "./shopping-cart.js";
import { digikalaCheckoutControl } from "./shopping-checkout-page.js";
import {
  checkoutInvoiceKey, DigikalaCheckoutError, digikalaCartUrl, digikalaCheckoutStage, digikalaOrdersUrl,
  digikalaShippingUrl, loadDigikalaCart, loadDigikalaInvoice, readDigikalaBuyer, readDigikalaReceipt
} from "./shopping-checkout-digikala.js";
import { readDigikalaProduct, quoteForWatch, shoppingHostPermission, shoppingNotificationPermission } from "./shopping-digikala.js";
import {
  checkoutCartIssue, checkoutCostIssue, checkoutItemsKey, purchaseJobApplies, readShoppingPurchases, shoppingPaymentKey, shoppingPurchasePolicy
} from "./shopping-purchase-store.js";
import { digikalaPrice, digikalaProductUrl, shoppingStatus, shoppingWatchKey } from "./shopping-store.js";

const noticePrefix = "ease-shopping-purchase:";
const inProgress = new Set();
const errorFor = error => error instanceof DigikalaCheckoutError ? error.code : "shoppingPurchaseReview";
const requireCheckout = (condition, code = "shoppingPurchaseReview") => {
  if (!condition) throw new DigikalaCheckoutError(code);
};
const savedState = (state, jobs = state.jobs) => ({ policy: state.policy, jobs });
const changeJob = (state, id, job) => ({ [state.key]: savedState(state, { ...state.jobs, [id]: job }) });
const pause = () => new Promise(resolve => setTimeout(resolve, 300));

export async function stageShoppingPurchase(workspace, action, data, transaction) {
  // All purchase approvals and results live in the current browser profile.
  if (action === "shopping-save" && data.purchase === undefined) return;
  const owner = (await chrome.storage.local.get(workspaceOwnerKey))[workspaceOwnerKey] ?? null;
  const state = await readShoppingPurchases(owner);
  if (action === "shopping-purchase-settings") {
    const policy = shoppingPurchasePolicy(data);
    if (!policy) return "shoppingPurchaseInvalidShipping";
    transaction.writeWorkspace = false;
    transaction.storageUpdates = { [state.key]: { ...savedState(state), policy } };
    return;
  }
  if (action === "shopping-purchase-release") {
    if (!state.payment?.needsReview || state.payment.owner !== owner || data?.token !== state.payment.token
      || data.reviewed !== true) return "shoppingPurchasePending";
    transaction.writeWorkspace = false;
    transaction.storageUpdates = { [shoppingPaymentKey]: null };
    return;
  }
  const id = data.id ?? workspace.shopping[0]?.id;
  const previous = state.jobs[id];
  const mode = action === "shopping-remove" ? "notify" : data.purchase?.mode;
  if (previous?.status === "running" || previous?.status === "submitting") return "shoppingPurchaseWorking";
  if (mode === "notify") {
    if (!previous) return;
    const jobs = { ...state.jobs };
    delete jobs[id];
    transaction.storageUpdates = { [state.key]: savedState(state, jobs) };
    return;
  }
  if (!["prepare", "wallet"].includes(mode)) return "shoppingInvalidRule";
  const watch = workspace.shopping.find(item => item.id === id);
  const rule = shoppingWatchKey(watch);
  const limit = mode === "wallet" ? digikalaPrice(data.purchase.limit) : null;
  if (mode === "wallet" && !limit) return "shoppingPurchaseInvalidBudget";
  if (previous?.rule === rule && previous.mode === mode && previous.limit === limit
    && purchaseJobApplies(watch, previous, state.policy) && data.purchase.confirm !== true) return;
  const next = { mode, rule, limit, policy: state.policy, status: "armed", token: crypto.randomUUID() };
  if (mode === "wallet") {
    if (state.payment) return "shoppingPurchasePending";
    if (data.purchase.confirm !== true) return "shoppingPurchaseConsentRequired";
    // Persist exactly the policy that the user was shown before confirming.
    if (JSON.stringify(shoppingPurchasePolicy(data.purchase.policy)) !== JSON.stringify(state.policy)) return "shoppingPurchaseRearm";
    if (!await chrome.permissions.contains(shoppingHostPermission)) return "shoppingConnect";
    try { next.buyer = await readDigikalaBuyer(); }
    catch (error) { return errorFor(error); }
  }
  transaction.storageUpdates = changeJob(state, id, next);
}

async function script(tabId, intent, expected = {}) {
  const [answer] = await chrome.scripting.executeScript({
    target: { tabId }, func: digikalaCheckoutControl, args: [intent, expected]
  });
  return answer?.result ?? null;
}

async function waitForTab(tabId, test, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  do {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    const value = await test(tab);
    if (value != null) return value;
    await pause();
  } while (Date.now() < deadline);
  return null;
}

async function openShipping(tabId, authorized) {
  await chrome.tabs.update(tabId, { url: digikalaShippingUrl });
  const selectedGroups = [];
  let chosen = false;
  let continued = false;
  return waitForTab(tabId, async tab => {
    if (tab.status !== "complete") return null;
    const stage = digikalaCheckoutStage(tab.url);
    if (stage === "payment") return true;
    if (stage !== "shipping") return false;
    const ready = await script(tabId, "shipping-status", { skip: selectedGroups }).catch(() => null);
    if (ready === "review") return false;
    if (ready === "continue" && !continued) {
      requireCheckout(await authorized());
      continued = true;
      await script(tabId, "shipping-continue");
    } else if (typeof ready === "string" && ready.startsWith("select:")) {
      requireCheckout(await authorized());
      const key = ready.slice(7);
      await script(tabId, "shipping-select", { key, skip: selectedGroups });
      selectedGroups.push(key);
      chosen = false;
    } else if (ready === "choose" && !chosen) {
      requireCheckout(await authorized());
      chosen = true;
      await script(tabId, "shipping-open-time");
    }
    return null;
  }, 16_000);
}

async function waitForCart(offer, initial) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const cart = await loadDigikalaCart();
    if (cart.items.some(item => item.variantId === offer.variantId)) {
      const remaining = { items: cart.items.filter(item => item.variantId !== offer.variantId) };
      requireCheckout(checkoutItemsKey(initial) === checkoutItemsKey(remaining), "shoppingPurchaseCartChanged");
      return cart;
    }
    await pause();
  }
  throw new DigikalaCheckoutError("shoppingPurchaseCartChanged");
}

async function notifyOutcome(id, watch, status, locale) {
  if (!chrome.notifications?.create || !await chrome.permissions.contains(shoppingNotificationPermission)) return;
  await chrome.notifications.create(noticePrefix + id, {
    type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"), title: watch.title,
    message: translate(locale, status)
  });
}

export function shoppingPurchases(queueWorkspace, currentShopping, openShopping) {
  let pending = Promise.resolve();
  const serialize = operation => {
    const run = pending.then(operation);
    pending = run.catch(() => {});
    return run;
  };
  async function setJob(owner, id, token, changes, payment) {
    return queueWorkspace(async () => {
      const state = await readShoppingPurchases(owner);
      const job = state.jobs[id];
      if (job?.token !== token || job.status === "paid") return false;
      const values = changeJob(state, id, { ...job, ...changes });
      if (payment !== undefined && state.payment?.token === token) values[shoppingPaymentKey] = payment;
      await chrome.storage.local.set(values);
      return true;
    });
  }

  async function reviewPending({ tabId, token, owner, id, cartId }, tabUrl) {
    const receipt = await readDigikalaReceipt(tabUrl, cartId).catch(() => null);
    if (!receipt) return false;
    await queueWorkspace(async () => {
      const state = await readShoppingPurchases(owner);
      if (state.payment?.token !== token || state.payment.tabId !== tabId) return;
      const job = state.jobs[id];
      const values = job?.token === token ? changeJob(state, id, { ...job, ...receipt, status: "paid" }) : {};
      await chrome.storage.local.set({ ...values, [shoppingPaymentKey]: null });
    });
    return true;
  }

  async function runPurchase(owner, id) {
    let context, watch, job, tabId;
    const start = await queueWorkspace(async () => {
      context = await currentShopping();
      if (context.owner !== owner || !context.enabled) return false;
      watch = context.watches.find(item => item.id === id);
      const state = await readShoppingPurchases(owner);
      job = state.jobs[id];
      const observation = (await chrome.storage.local.get(context.key))[context.key]?.[id];
      if (!watch || job?.status !== "armed" || !purchaseJobApplies(watch, job, state.policy)
        || shoppingStatus(watch, observation) !== "shoppingReady") return false;
      inProgress.add(job.token);
      job = { ...job, policy: state.policy, status: "running", tabId: null };
      await chrome.storage.local.set(changeJob(state, id, job));
      return true;
    });
    if (!start) return;

    // Read again at each stage. A paused, edited, expired or owner-switched rule cannot pay.
    const authorized = async () => {
      const [latest, state, allowed] = await Promise.all([
        currentShopping(), readShoppingPurchases(owner), chrome.permissions.contains(shoppingHostPermission)
      ]);
      const current = latest.watches.find(item => item.id === id);
      const saved = state.jobs[id];
      const now = Date.now();
      return allowed && latest.enabled && latest.owner === owner && current && !current.paused
        && (current.startAt === null || current.startAt <= now) && (current.endAt === null || current.endAt > now)
        && saved?.token === job.token && purchaseJobApplies(current, saved, state.policy)
        && JSON.stringify(state.policy) === JSON.stringify(job.policy);
    };
    const finish = async (status, reason, payment) => {
      if (await setJob(owner, id, job.token, { status, reason }, payment)) {
        const label = status === "review" ? reason : status === "prepared" ? "shoppingPurchasePrepared" : "shoppingPurchaseUnknown";
        await notifyOutcome(id, watch, label, context.locale).catch(() => {});
      }
    };
    try {
      requireCheckout(await authorized(), "shoppingConditionsChanged");
      if (job.mode === "wallet") {
        requireCheckout(!(await readShoppingPurchases(owner)).payment, "shoppingPurchasePending");
        const buyer = await readDigikalaBuyer();
        requireCheckout(buyer.accountId === job.buyer.accountId, "shoppingPurchaseSignIn");
        requireCheckout(buyer.addressKey === job.buyer.addressKey, "shoppingPurchaseAddress");
      }
      const offer = quoteForWatch(await readDigikalaProduct(watch.productId), watch);
      if (shoppingStatus(watch, { rule: job.rule, quote: offer, checkedAt: Date.now() }) !== "shoppingReady") {
        await setJob(owner, id, job.token, { status: "armed" });
        return;
      }
      requireCheckout(offer.singleItem && offer.variantId && offer.sellerId, "shoppingConditionsChanged");
      if (job.limit !== null) requireCheckout(offer.price <= job.limit, "shoppingPurchaseOverLimit");
      const initial = await loadDigikalaCart();
      const issue = checkoutCartIssue(initial, watch, offer, job.policy, { requireTarget: false });
      const alreadyInCart = initial.items.some(item => item.variantId === offer.variantId);
      requireCheckout(await authorized(), "shoppingConditionsChanged");
      const tab = await chrome.tabs.create({ active: false,
        url: issue || alreadyInCart ? digikalaCartUrl : digikalaProductUrl(watch.productId, offer.variantId) });
      tabId = tab.id;
      requireCheckout(Number.isInteger(tabId) && !tab.incognito);
      await setJob(owner, id, job.token, { tabId });
      requireCheckout(!issue, issue);
      let cart = initial;
      if (!alreadyInCart) {
        requireCheckout(await addDigikalaTabItem(tab, watch, offer, authorized), "shoppingPurchaseCartChanged");
        cart = await waitForCart(offer, initial);
      }
      requireCheckout(!checkoutCartIssue(cart, watch, offer, job.policy), "shoppingPurchaseCartChanged");
      requireCheckout(await authorized(), "shoppingConditionsChanged");
      requireCheckout(await openShipping(tabId, authorized), "shoppingPurchaseDelivery");
      if (job.mode === "prepare") {
        await finish("prepared");
        return;
      }

      const checkInvoice = invoice => {
        requireCheckout(invoice.cart.id === cart.id && checkoutItemsKey(invoice.cart) === checkoutItemsKey(cart)
          && !checkoutCartIssue(invoice.cart, watch, offer, job.policy), "shoppingPurchaseCartChanged");
        requireCheckout(invoice.addressIds.length && invoice.addressIds.every(value => value === job.buyer.addressId), "shoppingPurchaseAddress");
        const issue = checkoutCostIssue(invoice, job.limit, job.policy);
        requireCheckout(!issue, issue);
        requireCheckout(invoice.walletSelectable && invoice.walletBalance >= invoice.total, "shoppingPurchaseWalletBalance");
      };
      checkInvoice(await loadDigikalaInvoice(true));
      const attempted = await waitForTab(tabId, tab => digikalaCheckoutStage(tab.url) === "payment"
        ? script(tabId, "select-wallet").catch(() => null) : false, 7000);
      requireCheckout(attempted, "shoppingPurchaseWalletBalance");
      const invoice = await loadDigikalaInvoice(true);
      checkInvoice(invoice);
      const expected = { total: invoice.total, deadline: watch.endAt };
      const visibleTotal = await waitForTab(tabId, tab => digikalaCheckoutStage(tab.url) === "payment"
        ? script(tabId, "verify", expected).catch(() => null) : false, 6500);
      requireCheckout(visibleTotal, "shoppingPurchaseDeliveryUnknown");
      const [confirmed, buyer] = await Promise.all([loadDigikalaInvoice(true), readDigikalaBuyer()]);
      checkInvoice(confirmed);
      requireCheckout(buyer.accountId === job.buyer.accountId && buyer.addressKey === job.buyer.addressKey, "shoppingPurchaseAddress");
      requireCheckout(checkoutInvoiceKey(invoice) === checkoutInvoiceKey(confirmed), "shoppingPurchaseCartChanged");

      const payment = { owner, id, tabId, cartId: cart.id, token: job.token };
      let sent = false;
      await queueWorkspace(async () => {
        requireCheckout(await authorized(), "shoppingConditionsChanged");
        const state = await readShoppingPurchases(owner);
        requireCheckout(!state.payment, "shoppingPurchasePending");
        await chrome.storage.local.set({
          ...changeJob(state, id, { ...state.jobs[id], status: "submitting" }), [shoppingPaymentKey]: payment
        });
        // A throw after injection may mean Digikala already received the click.
        sent = await script(tabId, "pay", expected).then(Boolean, () => true);
      });
      if (!sent) {
        await finish("review", "shoppingPurchaseDeliveryUnknown", null);
        return;
      }
      const receipt = await waitForTab(tabId, tab => digikalaCheckoutStage(tab.url) === "receipt" ? tab.url : null);
      if (receipt && await reviewPending(payment, receipt)) {
        await notifyOutcome(id, watch, "shoppingPurchasePaid", context.locale).catch(() => {});
      } else {
        await finish("unknown", null, { ...payment, needsReview: true });
      }
    } catch (error) {
      const { payment } = await readShoppingPurchases(owner);
      if (payment?.token === job.token) await finish("unknown", null, { ...payment, needsReview: true });
      else {
        const latest = await readShoppingPurchases(owner);
        if (latest.jobs[id]?.status !== "paid") await finish("review", errorFor(error));
      }
    } finally {
      inProgress.delete(job.token);
    }
  }

  async function recover() {
    const { owner } = await currentShopping();
    const { payment } = await readShoppingPurchases(owner);
    if (payment && !inProgress.has(payment.token)) {
      const tab = await chrome.tabs.get(payment.tabId).catch(() => null);
      const receipts = await chrome.tabs.query({ url: "https://www.digikala.com/checkout/thank-you/payment/*" }).catch(() => []);
      const urls = new Set([tab?.url, ...receipts.map(item => item.url)]);
      let found = false;
      for (const url of urls) {
        found = await reviewPending(payment, url);
        if (found) break;
      }
      if (!found && !payment.needsReview) {
        await setJob(payment.owner, payment.id, payment.token, { status: "unknown" }, { ...payment, needsReview: true });
      }
    }
    await queueWorkspace(async () => {
      const state = await readShoppingPurchases(owner);
      const interrupted = Object.entries(state.jobs).filter(([, job]) => job.status === "running" && !inProgress.has(job.token));
      if (!interrupted.length) return;
      const jobs = { ...state.jobs };
      for (const [id, job] of interrupted) jobs[id] = { ...job, status: "review", reason: "shoppingPurchaseInterrupted" };
      await chrome.storage.local.set({ [state.key]: savedState(state, jobs) });
    });
  }

  if (chrome.tabs.onUpdated) chrome.tabs.onUpdated.addListener((id, changes, tab) => {
    if (!changes.url && changes.status !== "complete") return;
    const url = tab.url;
    if (digikalaCheckoutStage(url) !== "receipt") return;
    void readShoppingPurchases(null).then(({ payment }) => {
      if (payment?.tabId === id && !inProgress.has(payment.token)) return reviewPending(payment, url);
    }).catch(() => {});
  });
  chrome.notifications?.onClicked?.addListener(notice => {
    if (notice.startsWith(noticePrefix)) void openShopping({ watch: notice.slice(noticePrefix.length) }).catch(() => {});
  });

  return {
    queue: serialize,
    recover: () => serialize(recover),
    run: (owner, ids) => serialize(async () => {
      for (const id of ids) await runPurchase(owner, id);
    }),
    async open(id) {
      const { owner } = await currentShopping();
      const { jobs } = await readShoppingPurchases(owner);
      const job = jobs[id];
      if (!job) return { error: "shoppingRuleMissing" };
      const tab = Number.isInteger(job.tabId) ? await chrome.tabs.get(job.tabId).catch(() => null) : null;
      if (tab && (["cart", "shipping", "payment", "receipt"].includes(digikalaCheckoutStage(tab.url))
        || (job.status === "review" && /^https:\/\/www\.digikala\.com\/(product\/|users\/login)/u.test(tab.url ?? "")))) {
        await chrome.tabs.update(tab.id, { active: true });
      } else await chrome.tabs.create({ url: ["unknown", "paid", "submitting"].includes(job.status) ? digikalaOrdersUrl : digikalaCartUrl });
      return { ok: true };
    }
  };
}
