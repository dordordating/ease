import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantShoppingContext, assistantShoppingQuickSave, assistantWatchRule, prepareShoppingDraft, shoppingWatchDetails
} from "../assistant-shopping.js";
import { archiveAssistantDrafts } from "../assistant-actions.js";
import { defaultShoppingPurchasePolicy } from "../shopping-purchase-store.js";
import { shoppingWatchKey, updateShopping } from "../shopping-store.js";
import { taskTimestamp } from "../todo-store.js";

const watchId = "015999ff-ee00-4edf-a580-a0112ae959ac";
const watch = { id: watchId, store: "snappshop", title: "کابل شارژ سامسونگ", productId: "1391680052",
  variantId: null, priceLimit: 1_200_000, discount: null, quantity: 2, startAt: null, endAt: null };
const policy = defaultShoppingPurchasePolicy;
const snapshot = (observations = {}, jobs = {}) => ({ watches: [watch], observations, purchases: { policy, jobs } });
const noTab = () => { throw new Error("The current tab should not be read"); };

test("shopping binds a product reference to the supplied link and converts explicit conditions", async () => {
  const context = await assistantShoppingContext("این کالا را رصد کن https://snappshop.ir/product/snp-1391680052",
    [], snapshot(), "fa", noTab);
  const result = prepareShoppingDraft({
    kind: "shopping", operation: "create", use_product: true, price_toman: 110_000, discount: 20, quantity: 3,
    ends: { date: "2026-11-28" }, exclude_sellers: ["فروشگاه نمونه"]
  }, context);
  assert.equal(result.shopping.product.productId, "1391680052");
  assert.equal(result.shopping.store, "snappshop");
  assert.equal(result.shopping.changes.priceLimit, 1_100_000);
  assert.equal(result.shopping.changes.endAt, taskTimestamp("2026-11-28", "23:59"));
  assert.deepEqual(result.shopping.selection.exclude, ["فروشگاه نمونه"]);
  assert.equal(assistantShoppingQuickSave(result.shopping), true);
  assert.deepEqual(archiveAssistantDrafts([result]), [result]);
  const purchase = prepareShoppingDraft({
    kind: "shopping", operation: "create", use_product: true, mode: "prepare", budget_toman: 300_000
  }, context);
  assert.deepEqual(purchase.shopping.purchase, { mode: "prepare", limit: 3_000_000 });
  assert.equal(assistantShoppingQuickSave(purchase.shopping), false);
  assert.equal(prepareShoppingDraft({ operation: "create", use_product: true, mode: "wallet" }, context), null);
  assert.equal(prepareShoppingDraft({ operation: "create", use_product: true, mode: "prepare" }, context), null);
});

test("status resolves a local watch using its own observation and shows the quantity shortfall", async () => {
  const now = Date.now();
  const quote = { available: true, price: 1_000_000, maxQuantity: 1 };
  const state = snapshot({ [watchId]: { rule: shoppingWatchKey(watch), quote, checkedAt: now } });
  const context = await assistantShoppingContext("چرا آمادهٔ خرید نیست؟",
    [{ kind: "shopping", watchId }], state, "fa", noTab);
  assert.equal(context.input.watches[0].status, "shoppingWaitingQuantity");
  assert.equal(context.input.watches[0].stock, 1);
  assert.equal(context.input.watches[0].id, "w1");
  assert.equal(JSON.stringify(context.input).includes(watchId), false);
  const status = prepareShoppingDraft({ kind: "shopping", operation: "status", watch_ids: ["w1"] }, context);
  assert.deepEqual(status.shopping.watchIds, [watchId]);
  assert.equal(shoppingWatchDetails(state, watchId, now + 7 * 60_000).quote, null);
  assert.equal(prepareShoppingDraft({ kind: "shopping", operation: "edit", watch: "w2", paused: true }, context), null);
  assert.equal(await assistantShoppingContext("ترجمهٔ این ایمیل", [], state, "fa", noTab), null);
});

test("review resolves known seller and model IDs and preserves unrelated watch conditions", () => {
  const product = { offers: [
    { id: "offer-a", optionKey: "white", optionLabel: "سفید", sellerId: "a", sellerName: "فروشگاه اول" },
    { id: "offer-b", optionKey: "white", optionLabel: "سفید", sellerId: "b", sellerName: "فروشگاه دوم" }
  ] };
  const selection = { option: "سفید", seller: "", exclude: ["فروشگاه اول"] };
  const updated = assistantWatchRule(product, watch, { priceLimit: 1_100_000 }, selection, "fa");
  assert.deepEqual(updated.excludedSellers, ["a"]);
  assert.equal(updated.optionKey, "white");
  assert.equal(updated.quantity, 2);
  assert.equal(assistantWatchRule(product, watch, {}, { ...selection, exclude: ["نام نامعتبر"] }, "fa"), null);
  const workspace = { shopping: [watch] };
  assert.equal(updateShopping(workspace, "shopping-save", { ...updated, expectedRule: "stale" }), "assistantShoppingChanged");
  assert.equal(updateShopping(workspace, "shopping-save", { ...updated, expectedRule: shoppingWatchKey(watch), paused: true }), undefined);
  assert.equal(workspace.shopping[0].id, watchId);
  assert.equal(workspace.shopping[0].paused, true);
});
