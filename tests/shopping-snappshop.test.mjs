import test from "node:test";
import assert from "node:assert/strict";
import { quoteForWatch } from "../shopping-digikala.js";
import { snappShopQuoteIssue, snappShopStage } from "../shopping-checkout-snappshop.js";
import { snappShopProductDetails } from "../shopping-snappshop.js";
import { stageShoppingPurchase } from "../shopping-purchases.js";
import { shoppingPurchaseKey, shoppingPurchasePolicy, shoppingPurchaseStatus } from "../shopping-purchase-store.js";
import { shoppingProductLink, shoppingProductUrl, shoppingWatchKey, updateShopping } from "../shopping-store.js";

const snapp = { store: "snappshop", productId: "1391680052", title: "کابل آزمایشی", quantity: 2 };
const cartPolicy = (delivery = "include", shippingLimit = null) => shoppingPurchasePolicy({ cart: "review", delivery, shippingLimit });

test("store identity and opaque SnappShop offer IDs survive a workspace round trip", () => {
  const link = shoppingProductLink("www.snappshop.ir/product/snp-1391680052/کابل-آزمایشی");
  assert.deepEqual(link, { store: "snappshop", productId: snapp.productId, title: snapp.title, variantId: null });
  assert.equal(shoppingProductUrl(link), "https://snappshop.ir/product/snp-1391680052");
  assert.equal(shoppingProductLink("https://snappshop.ir.example.org/product/snp-1391680052"), null);
  assert.equal(shoppingProductLink("https://someone@snappshop.ir/product/snp-1391680052"), null);
  const workspace = { shopping: [] };
  assert.equal(updateShopping(workspace, "shopping-save", snapp), undefined);
  assert.equal(updateShopping(workspace, "shopping-save", { ...snapp, store: undefined }), undefined);
  assert.notEqual(shoppingWatchKey(workspace.shopping[0]), shoppingWatchKey(workspace.shopping[1]));
  assert.equal(updateShopping(workspace, "shopping-save", { ...snapp, variantId: "vdEG8k", sellerId: "g33N2d" }), undefined);
  assert.equal(workspace.shopping[0].sellerId, "g33N2d");
  assert.equal(updateShopping(workspace, "shopping-save", { ...snapp, allSellers: true, excludedSellers: ["g33N2d"] }), undefined);
  assert.deepEqual(workspace.shopping[0].excludedSellers, ["g33N2d"]);
});

test("SnappShop uses toman prices, stock, delivery eligibility, and the selected seller and option", () => {
  const makeOffer = (vendorId, stock, delivery = true) => ({
    vendor_product_info_id: `offer-${vendorId}`, vendor_id: vendorId, price: 125_000, special_price: 100_000,
    special_price_percent_discount: 20, stock, is_available_in_vendor_inventory: true,
    shipment: { asap: { enabled: delivery } }
  });
  const product = snappShopProductDetails(snapp.productId, {
    content: { title_fa: snapp.title }, images: [{ src: "https://cdn.snappshop.ir/products/fixture.jpg?width=200" }],
    vendors: [{ id: "A", title: "فروشگاه یک" }, { id: "B", title: "فروشگاه دو" }, { id: "C", title: "فروشگاه سه" }],
    default_variant: { variation_id: "white", vendor_product_info_id: "offer-A" },
    configurable_attribute: [{ id: "color", value: { id: "white", title: "سفید" } }],
    variants: [{ variation_id: "white", attribute_ids: [{ attribute_id: "color", attribute_value_id: "white" }],
      vendor: [makeOffer("A", 1), makeOffer("B", 5), makeOffer("C", 8, false)] }]
  });
  assert.equal(product.main.price, 1_000_000);
  assert.equal(product.main.reference, 1_250_000);
  assert.equal(product.main.discount, 20);
  assert.equal(product.image, "https://cdn.snappshop.ir/products/fixture.jpg");
  assert.deepEqual(product.main.optionFields, [{ group: "color", id: "white", name: "سفید" }]);
  const rule = { ...snapp, variantId: null, allSellers: true, optionKey: "white", priceLimit: 1_000_000, discount: 15 };
  assert.equal(quoteForWatch(product, rule).sellerId, "B");
  assert.notEqual(quoteForWatch(product, { ...rule, excludedSellers: ["B"] }).sellerId, "B");
  assert.equal(quoteForWatch(product, { ...rule, variantId: "offer-A", sellerId: "B" }).available, false);
});

test("SnappShop prepares with a whole-order budget and never arms a wallet or credit payment", async t => {
  const old = globalThis.chrome;
  globalThis.chrome = { storage: { local: { get: async () => ({}) } } };
  t.after(() => { globalThis.chrome = old; });
  const workspace = { shopping: [] };
  assert.equal(updateShopping(workspace, "shopping-save", snapp), undefined);
  const [watch] = workspace.shopping;
  const saved = {};
  assert.equal(await stageShoppingPurchase(workspace, "shopping-save", { id: watch.id, purchase: { mode: "wallet", confirm: true } }, {}),
    "shoppingInvalidRule");
  assert.equal(await stageShoppingPurchase(workspace, "shopping-save", { id: watch.id, purchase: { mode: "prepare" } }, {}),
    "shoppingPurchaseInvalidBudget");
  assert.equal(await stageShoppingPurchase(workspace, "shopping-save", {
    id: watch.id, purchase: { mode: "prepare", limit: 2_500_000 }
  }, saved), undefined);
  const { jobs, policy } = saved.storageUpdates[shoppingPurchaseKey(null)];
  const job = jobs[watch.id];
  assert.equal(job.store, "snappshop");
  assert.equal(job.limit, 2_500_000);
  assert.equal(shoppingPurchaseStatus(watch, { ...job, stage: "shipping", status: "prepared" }, policy), "shoppingSnappSelectDelivery");
});

test("SnappShop compares the final total and highlights changes after the delivery quote", () => {
  const quote = { total: 1_249_000, shipping: 99_000, subtotal: 1_150_000 };
  const job = { quantity: 1, limit: 1_300_000, policy: cartPolicy(), shippingQuote: 0, offerCheck: { price: 1_000_000 } };
  assert.equal(snappShopQuoteIssue(quote, job), "shoppingSnappCostChanged");
  assert.equal(snappShopQuoteIssue(quote, { ...job, limit: 1_200_000, policy: cartPolicy("separate") }), "shoppingPurchaseOverLimit");
  assert.equal(snappShopQuoteIssue(quote, { ...job, policy: cartPolicy("max", 95_000) }), "shoppingPurchaseShippingLimit");
  assert.equal(snappShopQuoteIssue(quote, { ...job, shippingQuote: 99_000, offerCheck: { price: 1_150_000 } }), null);
  assert.equal(snappShopQuoteIssue(quote, {
    ...job, shippingQuote: 99_000, cartSubtotal: 1_050_000, policy: { ...job.policy, cart: "include" }
  }), "shoppingSnappCostChanged");
  assert.equal(snappShopStage("https://snappshop.ir/checkout/payment"), "payment");
  assert.equal(snappShopStage("https://snappshop.ir.invalid/checkout/payment"), null);
});
