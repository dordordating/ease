import test from "node:test";
import assert from "node:assert/strict";
import { checkoutInvoice, readCheckoutCart } from "../shopping-checkout-digikala.js";
import {
  checkoutCartIssue, checkoutCostIssue, checkoutItemsKey, purchaseJobApplies, shoppingPurchasePolicy
} from "../shopping-purchase-store.js";
import { shoppingWatchKey } from "../shopping-store.js";

const watch = {
  productId: "123", variantId: "216", priceLimit: 890_000, discount: 10,
  startAt: null, endAt: null
};
const offer = { variantId: "216", sellerId: "441", price: 850_000 };
const item = { ...offer, productId: watch.productId, quantity: 1 };
const other = { variantId: "217", sellerId: "442", productId: "124", quantity: 1, price: 100_000 };
const cart = (...items) => ({ id: "cart-1", items, extraServices: false });
const policy = (cart, delivery = "include", shippingLimit = null) => shoppingPurchasePolicy({ cart, delivery, shippingLimit });

test("mixed carts require approval and a matching single target at the verified price", () => {
  const review = policy("review");
  const include = policy("include");
  assert.equal(checkoutCartIssue(cart(item, other), watch, offer, review), "shoppingPurchaseMixedCart");
  assert.equal(checkoutCartIssue(cart(item, other), watch, offer, include), null);
  assert.equal(checkoutCartIssue(cart(other), watch, offer, include), "shoppingPurchaseCartChanged");
  assert.equal(checkoutCartIssue(cart(other), watch, offer, include, { requireTarget: false }), null);
  for (const changed of [{ quantity: 2 }, { sellerId: "442" }, { price: 860_000 }]) {
    assert.equal(checkoutCartIssue(cart({ ...item, ...changed }), watch, offer, include), "shoppingPurchaseCartChanged");
  }
  assert.equal(checkoutItemsKey(cart(item, other)), checkoutItemsKey(cart(other, item)));
  assert.notEqual(checkoutItemsKey(cart(item, other)), checkoutItemsKey(cart(item, { ...other, quantity: 2 })));
});

test("shipping is counted, separately approved, or separately capped", () => {
  const invoice = { total: 990_000, shipping: 140_000 };
  assert.equal(checkoutCostIssue(invoice, 850_000, policy("review")), "shoppingPurchaseOverLimit");
  assert.equal(checkoutCostIssue(invoice, 850_000, policy("review", "separate")), null);
  assert.equal(checkoutCostIssue(invoice, 850_000, policy("include", "max", 139_999)), "shoppingPurchaseShippingLimit");
  assert.equal(checkoutCostIssue(invoice, 850_000, policy("include", "max", 140_000)), null);
  assert.equal(checkoutCostIssue({ total: 850_000, shipping: 0 }, 850_000, policy("include", "max", 0)), null);
  for (const shipping of [undefined, null, -1, 1_000_000]) {
    assert.equal(checkoutCostIssue({ ...invoice, shipping }, 990_000, policy("review", "separate")), "shoppingPurchaseDeliveryUnknown");
  }
});

test("wallet approval binds the watch and purchase settings", () => {
  const approved = policy("review", "max", 140_000);
  const job = { mode: "wallet", rule: shoppingWatchKey(watch), policy: approved };
  assert.ok(purchaseJobApplies(watch, job, approved));
  assert.ok(!purchaseJobApplies(watch, job, policy("include", "max", 140_000)));
  assert.ok(!purchaseJobApplies(watch, job, policy("review", "separate")));
  assert.ok(!purchaseJobApplies({ ...watch, discount: 15 }, job, approved));
});

test("wallet invoices require a consistent cart and identifiable shipping", () => {
  const row = {
    variant_id: 216, product: { id: 123 }, variant: { seller: { id: 441 } },
    quantity: 1, price: { selling_price: 850_000 }
  };
  const raw = { id: "cart-1", total_quantity: 1, payable_price: 990_000, shipping_cost: 140_000 };
  const data = {
    cart: raw, cart_items: [row], cart_shipments: [{ address: { id: 28 } }],
    payment_types: [{ sources: [
      { title: "کیف پول دیجی‌پی", is_clickable: true, balance: 1_000_000, price_type: "wallet" },
      { title: "کیف پول اوانو", is_clickable: true, balance: 2_000_000 }
    ] }],
    price_types_cart_data: { wallet: { ...raw, payable_price: 980_000, items: [row] } }
  };
  assert.deepEqual(readCheckoutCart({ cart: raw, packages: [{ cart_items: [row] }] }).items, [item]);
  assert.equal(readCheckoutCart({ cart: raw, cart_items: [] }), null);
  const invoice = checkoutInvoice(data, true);
  assert.equal(invoice.total, 980_000);
  assert.equal(invoice.shipping, 140_000);
  assert.equal(invoice.walletBalance, 1_000_000);
  assert.deepEqual(invoice.addressIds, ["28"]);
  assert.equal(checkoutInvoice({ ...data, cart_shipments: [{ is_cash_on_delivery: true }] }, true).shipping, null);
});
