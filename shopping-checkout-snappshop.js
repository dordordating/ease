import { waitForShopTab } from "./shopping-cart.js";
import { snappShopCheckoutControl } from "./shopping-checkout-snappshop-page.js";
import { checkoutAmounts } from "./shopping-purchase-store.js";
import { digikalaPrice, isSnappShopPage, shoppingProductUrl } from "./shopping-store.js";

export const snappShopCartUrl = "https://snappshop.ir/checkout/cart";

export class SnappShopCheckoutError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireCheckout(condition, code = "shoppingPurchaseReview") {
  if (!condition) throw new SnappShopCheckoutError(code);
}

export function snappShopStage(url) {
  if (!isSnappShopPage(url)) return null;
  const path = new URL(url).pathname.replace(/\/+$/u, "");
  return /^\/checkout\/(cart|shipping|payment)$/u.exec(path)?.[1] ?? null;
}

async function control(tabId, intent, expected = {}) {
  try {
    const [answer] = await chrome.scripting.executeScript({
      target: { tabId }, func: snappShopCheckoutControl, args: [intent, expected]
    });
    return answer?.result ?? null;
  } catch { return null; }
}

async function until(read, accept, delay = 250, timeout = 10_000) {
  const stop = Date.now() + timeout;
  do {
    const value = await read();
    if (value?.login) throw new SnappShopCheckoutError("shoppingSnappSignIn");
    if (accept(value)) return value;
    if (Date.now() < stop) await new Promise(resolve => setTimeout(resolve, delay));
  } while (Date.now() < stop);
  return null;
}

async function open(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  requireCheckout(await waitForShopTab(tabId, isSnappShopPage), "shoppingPurchaseConnection");
}

function itemsKey(items) {
  return JSON.stringify(items.map(item => JSON.stringify([item.id, item.price, item.quantity, item.signature])).sort());
}

async function fingerprint(items) {
  const key = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(itemsKey(items)));
  return [...new Uint8Array(key)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function checkCart(cart, expected, policy, wanted, otherItems) {
  requireCheckout(cart, "shoppingPurchaseCartChanged");
  const sameProduct = cart.items.filter(item => item.id === expected.productId);
  requireCheckout(sameProduct.length <= 1 && sameProduct.every(item => item.matchesOffer && item.quantity <= wanted),
    "shoppingSnappOfferChanged");
  const others = cart.items.filter(item => item.id !== expected.productId);
  requireCheckout(!others.length || policy.cart === "include", "shoppingPurchaseMixedCart");
  if (otherItems !== undefined) requireCheckout(itemsKey(others) === otherItems, "shoppingPurchaseCartChanged");
  return { quantity: sameProduct[0]?.quantity ?? 0, others: itemsKey(others) };
}

export async function prepareSnappShopCheckout(tabId, watch, offer, job, authorized) {
  requireCheckout(offer?.sellerName && offer.optionsComplete, "shoppingSnappOfferChanged");
  const wanted = watch.quantity ?? 1;
  const expected = { productId: watch.productId, sellerName: offer.sellerName, optionValues: offer.optionValues,
    warranty: offer.warranty, price: offer.price, offerId: offer.id, sellerId: offer.sellerId };
  const read = () => control(tabId, "cart", expected);
  let cart = await until(read, value => Array.isArray(value?.items));
  const before = checkCart(cart, expected, job.policy, wanted);
  if (before.quantity === 0) {
    await open(tabId, shoppingProductUrl(watch));
    const item = { ...expected, discount: watch.discount, optionFields: offer.optionFields, defaultOffer: offer.defaultForOption };
    for (const option of item.optionFields) {
      const selected = await until(() => control(tabId, "select-option", { productId: watch.productId, option }), value => value?.clicked);
      requireCheckout(selected, "shoppingSnappOfferChanged");
    }
    const readOffer = () => control(tabId, "offer", item);
    let shown = await until(readOffer, value => value?.ready || value?.changed, 250, 3500);
    if (!shown) {
      await control(tabId, "more-sellers", { productId: watch.productId });
      shown = await until(readOffer, value => value?.ready || value?.changed, 250, 6500);
    }
    requireCheckout(shown?.ready, "shoppingSnappOfferChanged");
    requireCheckout(await authorized(), "shoppingConditionsChanged");
    const added = await control(tabId, "add", item);
    requireCheckout(added?.clicked, added?.login ? "shoppingSnappSignIn" : "shoppingSnappOfferChanged");
    // Let the storefront process its cart update before changing routes.
    await new Promise(resolve => setTimeout(resolve, 900));
    await open(tabId, snappShopCartUrl);
    cart = await until(read, value => value?.items?.some(row => row.id === expected.productId));
    requireCheckout(checkCart(cart, expected, job.policy, wanted, before.others).quantity === 1, "shoppingPurchaseCartChanged");
  }
  let current = checkCart(cart, expected, job.policy, wanted, before.others).quantity;
  while (current < wanted) {
    requireCheckout(await authorized(), "shoppingConditionsChanged");
    const increased = await control(tabId, "increase", { ...expected, snapshot: JSON.stringify(cart.items) });
    requireCheckout(increased?.clicked, "shoppingPurchaseCartChanged");
    cart = await until(read, value => value?.items?.some(item => item.id === expected.productId && item.quantity !== current));
    const quantity = checkCart(cart, expected, job.policy, wanted, before.others).quantity;
    requireCheckout(quantity === current + 1, "shoppingPurchaseCartChanged");
    current = quantity;
  }
  const cartFingerprint = await fingerprint(cart.items);
  const cartSubtotal = cart.items.reduce((total, item) => total + item.price * item.quantity, 0);
  requireCheckout(digikalaPrice(cartSubtotal), "shoppingPurchaseCartChanged");
  requireCheckout(await authorized(), "shoppingConditionsChanged");
  const moved = await control(tabId, "shipping", { ...expected, snapshot: JSON.stringify(cart.items) });
  requireCheckout(moved?.clicked, moved?.login ? "shoppingSnappSignIn" : "shoppingPurchaseDelivery");
  const stage = await until(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    const path = snappShopStage(tab.url);
    return /^#(?:mobile|otp|login)/u.test(new URL(tab.url ?? "about:blank").hash) ? { login: true }
      : { path, pending: tab.status !== "complete" || !!tab.pendingUrl };
  }, value => !value?.pending && ["shipping", "payment"].includes(value?.path));
  requireCheckout(stage, "shoppingPurchaseDelivery");
  if (stage.path === "shipping") await listenForSnappDelivery(tabId, job.token);
  return { cartFingerprint, cartSubtotal, offerCheck: expected, stage: stage.path };
}

export function listenForSnappDelivery(tabId, token) {
  return control(tabId, "watch-delivery", { token });
}

export function listenForSnappPayment(tabId, token, invoiceQuote) {
  return control(tabId, "watch-payment", { token, invoiceQuote });
}

export function snappShopQuoteIssue(quote, job) {
  if (!checkoutAmounts(quote) || !digikalaPrice(quote.subtotal)) return "shoppingPurchaseDeliveryUnknown";
  if (quote.total > job.limit) return "shoppingPurchaseOverLimit";
  if (job.policy.delivery === "max" && quote.shipping > job.policy.shippingLimit) return "shoppingPurchaseShippingLimit";
  const cartSubtotal = job.cartSubtotal ?? (job.policy.cart === "review" ? job.offerCheck.price * (job.quantity ?? 1) : null);
  if ((cartSubtotal !== null && quote.subtotal !== cartSubtotal)
    || (job.shippingQuote != null && quote.shipping !== job.shippingQuote)) return "shoppingSnappCostChanged";
  return null;
}

export async function checkSnappShopInvoice(tabId, job) {
  let expand = true;
  const read = async () => {
    const row = await control(tabId, "invoice", { expand });
    if (row?.expanded) expand = false;
    return row;
  };
  const valid = value => value && checkoutAmounts(value) && digikalaPrice(value.subtotal);
  let quote = await until(read, valid, 300, 8000);
  requireCheckout(quote, "shoppingPurchaseDeliveryUnknown");
  const cartTab = await chrome.tabs.create({ url: snappShopCartUrl, active: false });
  requireCheckout(Number.isInteger(cartTab.id) && !cartTab.incognito, "shoppingPurchaseConnection");
  try {
    requireCheckout(await waitForShopTab(cartTab.id, isSnappShopPage), "shoppingPurchaseConnection");
    const cart = await until(() => control(cartTab.id, "cart", job.offerCheck), value => Array.isArray(value?.items));
    const cartChanged = !cart || await fingerprint(cart.items) !== job.cartFingerprint;
    const newest = await read();
    if (valid(newest)) quote = newest;
    else throw new SnappShopCheckoutError("shoppingPurchaseDeliveryUnknown");
    return { invoiceQuote: { ...quote, checkedAt: Date.now() }, cartChanged };
  } finally {
    await chrome.tabs.remove(cartTab.id).catch(() => {});
  }
}
