import test from "node:test";
import assert from "node:assert/strict";
import {
  checkoutInvoice, readCheckoutCart, readDigikalaDeliveryChoices, readDigikalaBuyer, selectDigikalaDeliveryAddress
} from "../shopping-checkout-digikala.js";
import { readDigikalaFromPage } from "../shopping-digikala-session.js";
import { quoteForWatch, readDigikalaProduct } from "../shopping-digikala.js";
import {
  canRetryShoppingPurchase, checkoutCartIssue, checkoutCostIssue, checkoutItemsKey, purchaseJobApplies, shoppingPurchasePolicy
} from "../shopping-purchase-store.js";
import { parseShoppingNumber, shoppingAvailable, shoppingPriceStatus, shoppingWatchKey, updateShopping } from "../shopping-store.js";

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
  assert.ok(!purchaseJobApplies({ ...watch, quantity: 2 }, job, approved));
  assert.ok(!purchaseJobApplies({ ...watch, optionKey: "blue" }, job, approved));
});

test("a refreshed checkout can retry an eligible review before payment", () => {
  const approved = policy("review");
  const job = { status: "review", mode: "wallet", rule: shoppingWatchKey(watch), policy: approved };
  const state = { policy: approved };
  assert.equal(canRetryShoppingPurchase(watch, job, state), true);
  assert.equal(canRetryShoppingPurchase(watch, job, { ...state, payment: { token: "pending" } }), false);
  assert.equal(canRetryShoppingPurchase(watch, job, { policy: policy("include") }), false);
  for (const status of ["paid", "unknown", "prepared", "submitting", "armed"]) {
    assert.equal(canRetryShoppingPurchase(watch, { ...job, status }, state), false);
  }
});

test("cart verification permits a partial quantity during setup and requires the exact quantity for checkout", () => {
  const three = { ...watch, quantity: 3 };
  const approved = policy("review");
  assert.equal(checkoutCartIssue(cart(item), three, offer, approved, { allowFewer: true }), null);
  assert.equal(checkoutCartIssue(cart(item), three, offer, approved), "shoppingPurchaseCartChanged");
  assert.equal(checkoutCartIssue(cart({ ...item, quantity: 3 }), three, offer, approved), null);
  assert.equal(checkoutCartIssue(cart({ ...item, quantity: 4 }), three, offer, approved, { allowFewer: true }), "shoppingPurchaseCartChanged");
});

test("available sellers are constrained to the chosen product option and quantity", async t => {
  const variant = (id, color, seller, price, stock, maximum) => ({
    id, color, seller: { id: seller, title: `Seller ${seller}` }, status: "marketable",
    price: { selling_price: price, rrp_price: 1_100_000, marketable_stock: stock, order_limit: maximum }
  });
  const blue = { id: 4, title: "Blue" };
  const black = { id: 7, title: "Black" };
  const product = {
    id: 123, title_fa: "Sample", status: "marketable",
    default_variant: variant(216, black, 441, 500_000, 30, 7),
    variants: [variant(217, blue, 442, 650_000, 6, 1), variant(218, blue, 443, 730_000, 4, 7)]
  };
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: { product } }));
  const details = await readDigikalaProduct("123");
  const option = details.offers[1];
  const rule = { ...watch, variantId: null, allSellers: true,
    optionKey: option.optionKey, optionLabel: option.optionLabel, quantity: 3 };
  assert.ok(option.optionKey);
  assert.equal(option.optionLabel, "Blue");
  assert.equal(quoteForWatch(details, rule).sellerId, "443");
  assert.equal(quoteForWatch(details, { ...rule, quantity: 1 }).sellerId, "442");
  const excluded = { ...rule, excludedSellers: ["443"] };
  assert.equal(shoppingPriceStatus(excluded, quoteForWatch(details, excluded)), "shoppingWaitingQuantity");
  assert.equal(quoteForWatch(details, { ...rule, variantId: "216" }).available, false);
  const workspace = { shopping: [] };
  assert.equal(updateShopping(workspace, "shopping-save", rule), undefined);
  assert.equal(workspace.shopping[0].quantity, 3);
  assert.equal(workspace.shopping[0].optionKey, option.optionKey);
  assert.equal(updateShopping(workspace, "shopping-save", { ...rule, quantity: 0 }), "shoppingInvalidRule");
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
  const line = { ...row, quantity: 2, price: { selling_price: 1_700_000 },
    variant: { ...row.variant, price: { selling_price: 850_000 } } };
  assert.equal(readCheckoutCart({ cart: { ...raw, total_quantity: 2 }, cart_items: [line] }).items[0].price, 850_000);
  assert.equal(readCheckoutCart({ cart: raw, cart_items: [] }), null);
  const invoice = checkoutInvoice(data, true);
  assert.equal(invoice.total, 980_000);
  assert.equal(invoice.shipping, 140_000);
  assert.equal(invoice.walletBalance, 1_000_000);
  assert.deepEqual(invoice.addressIds, ["28"]);
  assert.equal(checkoutInvoice({ ...data, cart_shipments: [{ is_cash_on_delivery: true }] }, true).shipping, null);
});

test("Iran-region visibility and grouped amounts use local settings", () => {
  const abroad = { timeZone: "Europe/Berlin", languages: ["de-DE", "fa-AF"] };
  assert.equal(shoppingAvailable("en", abroad), false);
  assert.equal(shoppingAvailable("fa", abroad), true);
  assert.equal(shoppingAvailable("en", { ...abroad, timeZone: "Asia/Tehran" }), true);
  assert.equal(shoppingAvailable("es", { ...abroad, languages: ["en-IR"] }), true);
  assert.equal(parseShoppingNumber("۱٬۲۳۴٬۰۰۰"), 1_234_000);
  assert.equal(parseShoppingNumber("1.234.000", "."), 1_234_000);
  assert.equal(parseShoppingNumber("1 234 000", " "), 1_234_000);
  assert.ok(Number.isNaN(parseShoppingNumber("-1,234")));
});

test("Digikala session reads recognize a bare profile and use the store's renewal for an expired session", async t => {
  globalThis.location = { origin: "https://www.digikala.com" };
  t.after(() => { delete globalThis.location; });
  let profile = { id: 321, national_identity_number: "private" };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, params) => {
    requests.push({ url, method: params.method, credentials: params.credentials });
    if (params.method === "POST") {
      assert.equal(url, "https://api.digikala.com/v1/user/token/");
      profile = { data: { id: 321 } };
      return new Response(null, { status: 204 });
    }
    return Response.json(profile);
  });
  assert.deepEqual(await readDigikalaFromPage("profile"), { status: 200, data: { id: 321 } });
  assert.deepEqual(requests.map(item => item.method), ["GET"]);
  requests.length = 0;
  profile = {};
  assert.deepEqual(await readDigikalaFromPage("profile"), { status: 200, data: { id: 321 } });
  assert.deepEqual(requests.map(item => item.method), ["GET", "GET", "POST", "GET"]);
  assert.ok(requests.every(item => item.credentials === "include"));
  globalThis.location.origin = "https://example.com";
  assert.equal(await readDigikalaFromPage("profile"), null);
  assert.equal(requests.length, 4);
});

test("cart quantity uses Digikala's exact cart item update", async t => {
  globalThis.location = { origin: "https://www.digikala.com" };
  t.after(() => { delete globalThis.location; });
  let count = 0;
  t.mock.method(globalThis, "fetch", async (url, params) => {
    count += 1;
    assert.equal(url, "https://api.digikala.com/checkout/v1/carts/items");
    assert.equal(params.method, "PATCH");
    assert.deepEqual(JSON.parse(params.body), { cartItemId: 123, quantity: 3 });
    return new Response(null, { status: 204 });
  });
  assert.equal((await readDigikalaFromPage("cart-quantity", { id: "123", quantity: 3 })).status, 204);
  assert.equal(await readDigikalaFromPage("cart-quantity", { id: "123", quantity: 0 }), null);
  assert.equal(count, 1);
});

test("checkout can bind and verify a non-default saved address from the next page", async t => {
  const home = { id: 1, name: "Home", address: "First street", postCode: "123" };
  const office = { id: 2, name: "Office", address: "Second street", postCode: "456" };
  let current = home;
  let changes = 0;
  globalThis.chrome = { scripting: { executeScript: async ({ target, args: [kind, option] }) => {
    assert.equal(target.tabId, 27);
    const responses = {
      profile: { id: 99 },
      addresses: { addresses: { items: option === 1 ? [home] : [office], totalPages: 2 },
        location: { id: 3, address: "Nearby location" } },
      "default-address": current
    };
    if (kind === "select-address") {
      assert.equal(option, "2");
      current = office;
      changes += 1;
    }
    return [{ result: { status: 200, data: responses[kind] ?? null } }];
  }}};
  t.after(() => { delete globalThis.chrome; });
  const { choices, defaultId } = await readDigikalaDeliveryChoices(27);
  assert.equal(defaultId, "1");
  assert.deepEqual(choices.map(({ id, title }) => [id, title]), [["1", "Home"], ["2", "Office"]]);
  const buyer = await readDigikalaBuyer(27, "2");
  assert.deepEqual(buyer, { accountId: "99", addressId: "2", addressKey: choices[1].key });
  assert.equal(changes, 0);
  await assert.rejects(selectDigikalaDeliveryAddress(27, "2", async () => false), /shoppingConditionsChanged/u);
  assert.equal(changes, 0);
  await selectDigikalaDeliveryAddress(27, "2", async () => true);
  await selectDigikalaDeliveryAddress(27, "2", async () => true);
  assert.equal(changes, 1);
});
