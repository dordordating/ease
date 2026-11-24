import { digikalaPrice, shoppingStatus, shoppingWatchKey } from "./shopping-store.js";

export const shoppingPaymentKey = "easeDigikalaPendingPayment";
export const shoppingPurchasePrefix = "easeShoppingPurchases:";
export const defaultShoppingPurchasePolicy = Object.freeze({ cart: "review", delivery: "include", shippingLimit: null });

export function shoppingPurchaseKey(owner) {
  return shoppingPurchasePrefix + (owner ? `account:${owner}` : "guest");
}

export function shoppingPurchasePolicy(value) {
  if (!value || !["review", "include"].includes(value.cart) || !["include", "separate", "max"].includes(value.delivery)) return null;
  const shippingLimit = value.delivery === "max" ? value.shippingLimit : null;
  if (value.delivery === "max" && shippingLimit !== 0 && !digikalaPrice(shippingLimit)) return null;
  return { cart: value.cart, delivery: value.delivery, shippingLimit };
}

export async function readShoppingPurchases(owner) {
  const key = shoppingPurchaseKey(owner);
  const values = await chrome.storage.local.get([key, shoppingPaymentKey]);
  return { key, ...shoppingPurchaseView(values[key], values[shoppingPaymentKey]) };
}

export function shoppingPurchaseView(state, payment = null) {
  return { policy: shoppingPurchasePolicy(state?.policy) ?? defaultShoppingPurchasePolicy,
    jobs: state?.jobs ?? {}, history: state?.history ?? {}, payment };
}

export function purchaseJobApplies(watch, job, policy) {
  return job?.rule === shoppingWatchKey(watch) && (job.mode === "prepare" || JSON.stringify(job.policy) === JSON.stringify(policy));
}

export function isShoppingCreditMode(mode) {
  return mode === "credit-one" || mode === "credit-four";
}

export function isShoppingPaymentMode(mode) {
  return mode === "wallet" || isShoppingCreditMode(mode);
}

export function pendingCreditTotal(job, payment) {
  if (!payment?.token || !payment.cartId || !Number.isInteger(payment.tabId) || !isShoppingCreditMode(job?.mode)
    || job.creditApproved !== true || payment.mode !== job.mode
    || payment.token !== job.token || payment.cartId !== job.cartId || payment.tabId !== job.tabId
    || payment.creditConfirmationAttempted || payment.needsReview) return null;
  return digikalaPrice(payment.creditTotal ?? job.invoiceQuote?.total);
}

export function canRetryShoppingPurchase(watch, job, state) {
  return job?.status === "review" && !state.payment && purchaseJobApplies(watch, job, state.policy);
}

export function shoppingWatchStatus(watch, observation, job) {
  if (job?.status === "paid" && job.rule === shoppingWatchKey(watch)) return "shoppingPurchased";
  return shoppingStatus(watch, observation);
}

export function shoppingPurchaseStatus(watch, job, policy) {
  if (!job) return null;
  if ((job.status === "armed" || job.status === "review") && !purchaseJobApplies(watch, job, policy)) return "shoppingPurchaseRearm";
  if (job.status === "submitting" || job.status === "running") return "shoppingPurchaseWorking";
  if (job.status === "paid") return "shoppingPurchasePaid";
  if (job.status === "awaiting") return "shoppingPurchaseCreditAwaiting";
  if (job.status === "unknown") return "shoppingPurchaseUnknown";
  if (job.status === "prepared") return isShoppingCreditMode(job.mode) ? "shoppingPurchaseCreditPrepared" : "shoppingPurchasePrepared";
  if (job.status === "review") return job.reason ?? "shoppingPurchaseReview";
  return job.status === "armed" ? "shoppingPurchaseArmed" : null;
}

export function checkoutCartIssue(cart, watch, offer, policy, { requireTarget = true, allowFewer = false } = {}) {
  if (!cart) return "shoppingPurchaseCartChanged";
  if (cart.extraServices) return "shoppingPurchaseCartExtras";
  const matching = cart.items.filter(item => item.variantId === offer.variantId);
  if (matching.length > 1 || (requireTarget && matching.length !== 1)) return "shoppingPurchaseCartChanged";
  const target = matching[0];
  const quantity = watch.quantity ?? 1;
  if (target && ((allowFewer ? target.quantity > quantity : target.quantity !== quantity)
    || (target.productId && target.productId !== watch.productId)
    || (target.sellerId && target.sellerId !== offer.sellerId) || (target.price !== null && target.price !== offer.price))) {
    return "shoppingPurchaseCartChanged";
  }
  if (policy.cart === "review" && cart.items.length > matching.length) return "shoppingPurchaseMixedCart";
  return null;
}

export function checkoutCostIssue(invoice, limit, policy) {
  const { total, shipping } = invoice;
  if (!digikalaPrice(total) || (shipping !== 0 && !digikalaPrice(shipping)) || shipping > total) {
    return "shoppingPurchaseDeliveryUnknown";
  }
  if (policy.delivery === "max" && shipping > policy.shippingLimit) return "shoppingPurchaseShippingLimit";
  const counted = policy.delivery === "include" ? total : total - shipping;
  if (limit !== null && counted > limit) return "shoppingPurchaseOverLimit";
  return null;
}

export function checkoutItemsKey(cart) {
  return JSON.stringify(cart.items.map(item => [item.variantId, item.quantity, item.price, item.sellerId, item.productId])
    .sort((a, b) => a[0].localeCompare(b[0])));
}

export function checkoutCartsMatch(verified, invoice) {
  if (verified.id !== invoice.id || verified.items.length !== invoice.items.length) return false;
  const rows = new Map(invoice.items.map(item => [item.variantId, item]));
  if (rows.size !== invoice.items.length || new Set(verified.items.map(item => item.variantId)).size !== verified.items.length) return false;
  return verified.items.every(item => {
    const actual = rows.get(item.variantId);
    return actual && item.quantity === actual.quantity
      && ["price", "sellerId", "productId"].every(key => item[key] == null || actual[key] == null || item[key] === actual[key]);
  });
}

export function checkoutAmounts(invoice) {
  return !checkoutCostIssue(invoice, null, defaultShoppingPurchasePolicy)
    ? { total: invoice.total, shipping: invoice.shipping } : null;
}
