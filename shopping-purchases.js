import { translate } from "./locales.js";
import { workspaceOwnerKey } from "./workspace-accounts.js";
import { addDigikalaTabItem, waitForShopTab } from "./shopping-cart.js";
import { digikalaCheckoutControl } from "./shopping-checkout-page.js";
import {
  checkoutInvoiceKey, digikalaCartUrl, digikalaCheckoutStage, digikalaOrdersUrl, digikalaShippingUrl, invoiceAddressIssue,
  loadDigikalaCart, loadDigikalaInvoice, readDigikalaBuyer, readDigikalaReceipt, selectDigikalaDeliveryAddress,
  setDigikalaCartQuantity, verifyDigikalaDeliveryAddress
} from "./shopping-checkout-digikala.js";
import { DigikalaCheckoutError, isDigikalaPage, withDigikalaTab } from "./shopping-digikala-session.js";
import { readDigikalaProduct, quoteForWatch, shoppingHostPermission, shoppingNotificationPermission } from "./shopping-digikala.js";
import {
  canRetryShoppingPurchase, checkoutAmounts, checkoutCartIssue, checkoutCartsMatch, checkoutCostIssue, checkoutItemsKey,
  isShoppingCreditMode, isShoppingPaymentMode, purchaseJobApplies, readShoppingPurchases, shoppingPaymentKey,
  shoppingPurchasePolicy, shoppingPurchaseStatus
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

function settledTab(tab) {
  return Number.isInteger(tab?.id) && !tab.incognito && tab.status === "complete" && !tab.pendingUrl;
}

function creditHandoff(tab) {
  if (!settledTab(tab)) return false;
  // Chrome can withhold the URL when this known checkout tab leaves Digikala.
  if (!tab.url) return true;
  try {
    const { protocol, hostname, pathname } = new URL(tab.url);
    return protocol === "https:" && (hostname === "mydigipay.com" || hostname.endsWith(".mydigipay.com")
      || hostname.endsWith(".shaparak.ir") || (isDigikalaPage(tab.url) && pathname.startsWith("/checkout/payment/order/")));
  } catch { return false; }
}

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
  if (previous?.status === "awaiting" && state.payment?.token === previous.token) return "shoppingPurchasePending";
  if (mode === "notify") {
    if (!previous) return;
    const jobs = { ...state.jobs };
    delete jobs[id];
    transaction.storageUpdates = { [state.key]: savedState(state, jobs) };
    return;
  }
  const paymentMode = isShoppingPaymentMode(mode);
  if (mode !== "prepare" && !paymentMode) return "shoppingInvalidRule";
  const watch = workspace.shopping.find(item => item.id === id);
  const rule = shoppingWatchKey(watch);
  const limit = paymentMode ? digikalaPrice(data.purchase.limit) : null;
  if (paymentMode && !limit) return "shoppingPurchaseInvalidBudget";
  const selection = data.purchase.address;
  const sameAddress = selection ? selection.id === previous?.buyer?.addressId
    && selection.key === previous?.buyer?.addressKey && selection.accountId === previous?.buyer?.accountId
    : paymentMode || !previous?.buyer;
  if (previous?.rule === rule && previous.mode === mode && previous.limit === limit && sameAddress
    && purchaseJobApplies(watch, previous, state.policy) && data.purchase.confirm !== true) return;
  const next = { mode, rule, limit, policy: state.policy, status: "armed", token: crypto.randomUUID() };
  if (paymentMode) {
    if (state.payment) return "shoppingPurchasePending";
    const credit = isShoppingCreditMode(mode);
    if (data.purchase.confirm !== true) return credit ? "shoppingPurchaseCreditConsentRequired" : "shoppingPurchaseConsentRequired";
    if (credit) next.creditApproved = true;
    // Bind the payment method to the policy shown in the watch editor.
    if (JSON.stringify(shoppingPurchasePolicy(data.purchase.policy)) !== JSON.stringify(state.policy)) return "shoppingPurchaseRearm";
  }
  if (paymentMode || selection) {
    if (typeof selection?.id !== "string" || !selection.id) return "shoppingPurchaseChooseAddress";
    if (!await chrome.permissions.contains(shoppingHostPermission)) return "shoppingConnect";
    try {
      const buyer = await withDigikalaTab(tabId => readDigikalaBuyer(tabId, selection.id));
      if (buyer.accountId !== selection.accountId || buyer.addressKey !== selection.key) return "shoppingPurchaseAddressChanged";
      next.buyer = buyer;
    }
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

async function openShipping(tabId, authorized, buyer) {
  await chrome.tabs.update(tabId, { url: digikalaShippingUrl });
  const selectedGroups = [];
  let chosen = false;
  let continued = false;
  let addressVerified = false;
  const addressLabels = buyer?.delivery.labels;
  return waitForTab(tabId, async tab => {
    if (tab.status !== "complete" || tab.pendingUrl) return null;
    const stage = digikalaCheckoutStage(tab.url);
    if (stage === "payment") return { addressVerified };
    if (stage !== "shipping") return false;
    const ready = await script(tabId, "shipping-status", { skip: selectedGroups, addressLabels }).catch(() => null);
    if (ready === "review") return false;
    requireCheckout(ready !== "address-mismatch", "shoppingPurchaseAddressMismatch");
    if ((ready === "continue" || ready === "address-verified") && !continued) {
      if (ready === "address-verified") await verifyDigikalaDeliveryAddress(tabId, buyer);
      requireCheckout(await authorized());
      const result = await script(tabId, "shipping-continue", { addressLabels });
      requireCheckout(result !== "address-mismatch", "shoppingPurchaseAddressMismatch");
      continued = result === "continue" || result === "address-verified";
      addressVerified = ready === "address-verified" && result === "address-verified";
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

async function waitForCart(tabId, offer, initial) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const cart = await loadDigikalaCart(tabId);
    if (cart.items.some(item => item.variantId === offer.variantId)) {
      const remaining = { items: cart.items.filter(item => item.variantId !== offer.variantId) };
      requireCheckout(checkoutItemsKey(initial) === checkoutItemsKey(remaining), "shoppingPurchaseCartChanged");
      return cart;
    }
    await pause();
  }
  throw new DigikalaCheckoutError("shoppingPurchaseCartChanged");
}

export async function fillDigikalaCart(tab, watch, offer, policy, authorized) {
  const quantity = watch.quantity ?? 1;
  requireCheckout(await authorized(), "shoppingConditionsChanged");
  const initial = await loadDigikalaCart(tab.id);
  const issue = checkoutCartIssue(initial, watch, offer, policy, { requireTarget: false, allowFewer: true });
  if (issue) await chrome.tabs.update(tab.id, { url: digikalaCartUrl });
  requireCheckout(!issue, issue);
  let cart = initial;
  let item = cart.items.find(entry => entry.variantId === offer.variantId);
  if (!item) {
    requireCheckout(await addDigikalaTabItem(tab, watch, offer, authorized), "shoppingPurchaseCartChanged");
    cart = await waitForCart(tab.id, offer, initial);
    item = cart.items.find(entry => entry.variantId === offer.variantId);
  }
  const cartIssue = checkoutCartIssue(cart, watch, offer, policy, { allowFewer: true });
  requireCheckout(!cartIssue, cartIssue);
  if (item.quantity < quantity) {
    requireCheckout(item.id && item.price === offer.price, "shoppingPurchaseCartChanged");
    requireCheckout(await authorized(), "shoppingConditionsChanged");
    await setDigikalaCartQuantity(tab.id, item.id, quantity);
    const others = value => checkoutItemsKey({ items: value.items.filter(entry => entry.variantId !== offer.variantId) });
    const originalId = cart.id;
    const originalOthers = others(cart);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      cart = await loadDigikalaCart(tab.id);
      const issue = checkoutCartIssue(cart, watch, offer, policy, { allowFewer: true });
      requireCheckout(cart.id === originalId && others(cart) === originalOthers && !issue, "shoppingPurchaseCartChanged");
      if (cart.items.find(entry => entry.variantId === offer.variantId).quantity === quantity) break;
      if (attempt < 2) await pause();
    }
  }
  const finalIssue = checkoutCartIssue(cart, watch, offer, policy);
  requireCheckout(!finalIssue, finalIssue);
  return cart;
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
      if (job?.token !== token || job.status === "paid" || (payment !== undefined && state.payment?.token !== token)) return false;
      const values = changeJob(state, id, { ...job, ...changes });
      if (payment !== undefined) values[shoppingPaymentKey] = payment;
      await chrome.storage.local.set(values);
      return true;
    });
  }

  async function reviewPending({ tabId, token, owner, id, cartId }, tab) {
    if (!settledTab(tab)) return false;
    const receipt = await readDigikalaReceipt(tab.id, tab.url, cartId).catch(() => null);
    if (!receipt) return false;
    return queueWorkspace(async () => {
      const state = await readShoppingPurchases(owner);
      if (state.payment?.token !== token || state.payment.tabId !== tabId) return false;
      const job = state.jobs[id];
      const values = job?.token === token ? changeJob(state, id, { ...job, ...receipt, status: "paid" }) : {};
      await chrome.storage.local.set({ ...values, [shoppingPaymentKey]: null });
      return true;
    });
  }

  async function updatePendingStatus(payment, tab) {
    if (tab && !settledTab(tab)) return;
    const { owner, id, token } = payment;
    if (isShoppingCreditMode(payment.mode) && creditHandoff(tab)) {
      const { jobs } = await readShoppingPurchases(owner);
      if (jobs[id]?.status !== "awaiting" || payment.needsReview) {
        await setJob(owner, id, token, { status: "awaiting" }, { ...payment, needsReview: false });
      }
    } else if (!payment.needsReview) {
      await setJob(owner, id, token, { status: "unknown" }, { ...payment, needsReview: true });
    }
  }

  async function runPurchase(owner, { id, retryToken }) {
    let context, watch, job, tabId, previous;
    const start = await queueWorkspace(async () => {
      context = await currentShopping();
      if (context.owner !== owner || !context.enabled) return false;
      watch = context.watches.find(item => item.id === id);
      const state = await readShoppingPurchases(owner);
      job = state.jobs[id];
      const observation = (await chrome.storage.local.get(context.key))[context.key]?.[id];
      if (!watch || !purchaseJobApplies(watch, job, state.policy) || shoppingStatus(watch, observation) !== "shoppingReady") return false;
      if (retryToken) {
        if (retryToken !== job.token || !canRetryShoppingPurchase(watch, job, state)) return false;
        previous = job;
      } else if (job.status !== "armed") return false;
      job = { ...job, policy: state.policy, status: "running", reason: null, tabId: null, cartId: null, invoiceQuote: null,
        token: retryToken ? crypto.randomUUID() : job.token };
      inProgress.add(job.token);
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
        const label = shoppingPurchaseStatus(watch, { ...job, status, reason }, job.policy);
        await notifyOutcome(id, watch, label, context.locale).catch(() => {});
      }
    };
    try {
      requireCheckout(await authorized(), "shoppingConditionsChanged");
      const oldTab = Number.isInteger(previous?.tabId) ? await chrome.tabs.get(previous.tabId).catch(() => null) : null;
      if ([oldTab?.url, oldTab?.pendingUrl].some(url => digikalaCheckoutStage(url) === "receipt")) {
        const receipt = previous.cartId && !oldTab.incognito && oldTab.status === "complete"
          ? await readDigikalaReceipt(oldTab.id, oldTab.url, previous.cartId).catch(() => null) : null;
        await setJob(owner, id, job.token, { tabId: oldTab.id, ...(receipt ?? {}), status: receipt ? "paid" : "unknown" });
        return;
      }
      if (isShoppingPaymentMode(job.mode)) {
        requireCheckout(!(await readShoppingPurchases(owner)).payment, "shoppingPurchasePending");
        requireCheckout(job.buyer?.addressId, "shoppingPurchaseChooseAddress");
      }
      const offer = quoteForWatch(await readDigikalaProduct(watch.productId), watch);
      if (shoppingStatus(watch, { rule: job.rule, quote: offer, checkedAt: Date.now() }) !== "shoppingReady") {
        await setJob(owner, id, job.token, { status: "armed" });
        return;
      }
      requireCheckout(offer.variantId && offer.sellerId, "shoppingConditionsChanged");
      if (job.limit !== null) requireCheckout(offer.price * (watch.quantity ?? 1) <= job.limit, "shoppingPurchaseOverLimit");
      requireCheckout(await authorized(), "shoppingConditionsChanged");
      const url = digikalaProductUrl(watch.productId, offer.variantId);
      const reuse = oldTab && !oldTab.active && !oldTab.incognito && digikalaCheckoutStage(oldTab.url) === "cart";
      const tab = reuse ? await chrome.tabs.update(oldTab.id, { url }) : await chrome.tabs.create({ active: false, url });
      tabId = tab.id;
      requireCheckout(Number.isInteger(tabId) && !tab.incognito);
      await setJob(owner, id, job.token, { tabId });
      requireCheckout(await waitForShopTab(tabId, isDigikalaPage), "shoppingPurchaseConnection");
      const readBuyer = async () => {
        const buyer = await readDigikalaBuyer(tabId, job.buyer.addressId, { details: true });
        requireCheckout(buyer.accountId === job.buyer.accountId, "shoppingPurchaseSignIn");
        requireCheckout(buyer.addressKey === job.buyer.addressKey, "shoppingPurchaseAddressChanged");
        return buyer;
      };
      const buyer = job.buyer ? await readBuyer() : null;
      const cart = await fillDigikalaCart(tab, watch, offer, job.policy, authorized);
      await setJob(owner, id, job.token, { cartId: cart.id });
      requireCheckout(await authorized(), "shoppingConditionsChanged");
      if (buyer) await selectDigikalaDeliveryAddress(tabId, buyer.addressId, authorized, buyer.delivery);
      const shipping = await openShipping(tabId, authorized, buyer);
      requireCheckout(shipping, "shoppingPurchaseDelivery");
      const checkAddress = async invoice => {
        const issue = invoiceAddressIssue(invoice, buyer);
        if (issue === "shoppingPurchaseAddressUnverified" && shipping.addressVerified) {
          // The shipping UI saved this address on the same cart before opening payment.
          await verifyDigikalaDeliveryAddress(tabId, buyer);
        } else {
          requireCheckout(!issue, issue);
        }
      };
      const saveQuote = async invoice => {
        const amounts = checkoutAmounts(invoice);
        if (amounts) await setJob(owner, id, job.token, { invoiceQuote: { ...amounts, checkedAt: Date.now() } });
      };
      if (job.mode === "prepare") {
        if (buyer) {
          const invoice = await loadDigikalaInvoice(tabId);
          await checkAddress(invoice);
          if (checkoutCartsMatch(cart, invoice.cart)) await saveQuote(invoice);
        }
        await finish("prepared");
        return;
      }

      const credit = isShoppingCreditMode(job.mode);
      const controlIssue = credit ? "shoppingPurchaseCreditControl" : "shoppingPurchaseWalletControl";
      const checkInvoice = async (invoice, record = false) => {
        requireCheckout(checkoutCartsMatch(cart, invoice.cart)
          && !checkoutCartIssue(invoice.cart, watch, offer, job.policy), "shoppingPurchaseCartChanged");
        await checkAddress(invoice);
        if (record) await saveQuote(invoice);
        const issue = checkoutCostIssue(invoice, job.limit, job.policy);
        requireCheckout(!issue, issue);
        if (credit) {
          const orderIssue = checkoutCostIssue(invoice.orderCost, job.limit, job.policy);
          requireCheckout(!orderIssue, orderIssue);
          requireCheckout(invoice.payment?.selectable, "shoppingPurchaseCreditUnavailable");
        } else {
          requireCheckout(invoice.payment?.selectable && invoice.payment.balance >= invoice.total, "shoppingPurchaseWalletBalance");
        }
      };
      const initialInvoice = await loadDigikalaInvoice(tabId, job.mode);
      await checkInvoice(initialInvoice, true);
      const paymentSelection = { payment: initialInvoice.payment };
      const attempted = await waitForTab(tabId, tab => digikalaCheckoutStage(tab.url) === "payment"
        ? script(tabId, "select-payment", paymentSelection).catch(() => null) : false, 7000);
      requireCheckout(attempted, controlIssue);
      const selected = attempted.selected || await waitForTab(tabId, tab => digikalaCheckoutStage(tab.url) === "payment"
        ? script(tabId, "payment-selected", paymentSelection).catch(() => null) : false, 5500);
      requireCheckout(selected, controlIssue);
      const invoice = await loadDigikalaInvoice(tabId, job.mode);
      await checkInvoice(invoice, true);
      const expected = { total: invoice.total, deadline: watch.endAt, payment: invoice.payment, creditApproved: job.creditApproved };
      const visibleTotal = await waitForTab(tabId, tab => digikalaCheckoutStage(tab.url) === "payment"
        ? script(tabId, "verify", expected).catch(() => null) : false, 6500);
      requireCheckout(visibleTotal, "shoppingPurchaseDeliveryUnknown");
      const [confirmed] = await Promise.all([loadDigikalaInvoice(tabId, job.mode), readBuyer()]);
      await checkInvoice(confirmed);
      requireCheckout(checkoutInvoiceKey(invoice) === checkoutInvoiceKey(confirmed), "shoppingPurchaseCartChanged");
      if (checkoutItemsKey(cart) !== checkoutItemsKey(confirmed.cart)) {
        const fresh = await loadDigikalaCart(tabId);
        requireCheckout(fresh.id === cart.id && checkoutItemsKey(fresh) === checkoutItemsKey(cart) && !fresh.extraServices,
          "shoppingPurchaseCartChanged");
      }
      // Watches created before credit submission required a separate confirmation on Digikala.
      if (credit && job.creditApproved !== true) {
        requireCheckout(await authorized(), "shoppingConditionsChanged");
        await finish("prepared");
        return;
      }

      const payment = { owner, id, tabId, cartId: cart.id, token: job.token, mode: job.mode };
      let sent = false;
      await queueWorkspace(async () => {
        requireCheckout(await authorized(), "shoppingConditionsChanged");
        const state = await readShoppingPurchases(owner);
        requireCheckout(!state.payment, "shoppingPurchasePending");
        requireCheckout(!credit || state.jobs[id]?.creditApproved === true, "shoppingPurchaseCreditConsentRequired");
        await chrome.storage.local.set({
          ...changeJob(state, id, { ...state.jobs[id], status: "submitting" }), [shoppingPaymentKey]: payment
        });
        // A throw after injection may mean Digikala already received the click.
        sent = await script(tabId, "pay", expected).then(Boolean, () => true);
      });
      if (!sent) {
        await finish("review", credit ? controlIssue : "shoppingPurchaseDeliveryUnknown", null);
        return;
      }
      const destination = await waitForTab(tabId, tab => settledTab(tab)
        && (digikalaCheckoutStage(tab.url) === "receipt" || (credit && creditHandoff(tab))) ? tab : null);
      if (destination && await reviewPending(payment, destination)) {
        await notifyOutcome(id, watch, "shoppingPurchasePaid", context.locale).catch(() => {});
      } else if (credit && creditHandoff(destination)) {
        await finish("awaiting");
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
      const tabs = new Map([tab, ...receipts].filter(Boolean).map(item => [item.id, item]));
      let found = false;
      for (const candidate of tabs.values()) {
        found = await reviewPending(payment, candidate);
        if (found) break;
      }
      if (!found) await updatePendingStatus(payment, tab);
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

  function reconcilePaymentTab(tabId) {
    void chrome.storage.local.get(shoppingPaymentKey).then(values => {
      if (values[shoppingPaymentKey]?.tabId === tabId) return serialize(recover);
    }).catch(() => {});
  }

  chrome.tabs.onUpdated?.addListener((id, changes, tab) => {
    if ((changes.url || changes.status === "complete") && settledTab(tab)) reconcilePaymentTab(id);
  });
  chrome.tabs.onRemoved?.addListener(reconcilePaymentTab);
  chrome.notifications?.onClicked?.addListener(notice => {
    if (notice.startsWith(noticePrefix)) void openShopping({ watch: notice.slice(noticePrefix.length) }).catch(() => {});
  });

  return {
    queue: serialize,
    recover: () => serialize(recover),
    run: (owner, attempts) => serialize(async () => {
      for (const attempt of attempts) await runPurchase(owner, attempt);
    }),
    async open(id) {
      const { owner, enabled } = await currentShopping();
      if (!enabled) return { error: "shoppingUnavailable" };
      const { jobs, payment } = await readShoppingPurchases(owner);
      const job = jobs[id];
      if (!job) return { error: "shoppingRuleMissing" };
      const tab = Number.isInteger(job.tabId) ? await chrome.tabs.get(job.tabId).catch(() => null) : null;
      if (tab && ((job.status === "awaiting" && payment?.token === job.token && creditHandoff(tab))
        || ["cart", "shipping", "payment", "receipt"].includes(digikalaCheckoutStage(tab.url))
        || (job.status === "review" && /^https:\/\/www\.digikala\.com\/(product\/|users\/login)/u.test(tab.url ?? "")))) {
        await chrome.tabs.update(tab.id, { active: true });
      } else await chrome.tabs.create({ url: ["unknown", "paid", "submitting", "awaiting"].includes(job.status) ? digikalaOrdersUrl : digikalaCartUrl });
      return { ok: true };
    }
  };
}
