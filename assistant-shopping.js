import {
  digikalaPrice, shoppingPollMinutes, shoppingProductCode, shoppingProductLink, shoppingProductUrl, shoppingQuantity,
  shoppingTitle, shoppingWatchKey
} from "./shopping-store.js";
import { shoppingPurchaseStatus, shoppingWatchStatus } from "./shopping-purchase-store.js";
import { taskTimestamp } from "./todo-store.js";
import { normalizeSearchText } from "./workspace-search.js";

const shoppingWords = /(?:رصد|دیجی\s*کالا|اسنپ\s*شاپ|خرید|فروشنده|سبد|تخفیف|قیمت\s*کالا|بائع|شراء|\b(?:watch(?:es)?|digikala|snapp\s*shop|product|seller|discount|checkout|cart|rastreo|achat|suivi|compra|verk[äa]ufer|kauf)\b|商品|出品者|購入)/iu;
const currentProductWords = /(?:همین|این\s*کالا|کالای\s*صفحه|صفحهٔ?\s*فعلی|\b(?:this|current|open)\s+(?:product|item|page|tab|one)\b|este producto|ce produit|هذا المنتج|dieses produkt|この商品)/iu;
const watchQuestions = /(?:وضعیت|چرا|چطور|کدو(?:م|ما)|کدام|نتیجه|\b(?:status|why|which|ready|estado|statut|pr[êe]t|bereit)\b|حالة|لماذا|状況)/iu;
const readyQuestions = /(?:کدو(?:م|ما)|کدام|رصدهای|\b(?:which|ready watches|montre|muestra)\b|أي|どの).*(?:آماده|ready|pr[êe]t|bereit|جاهز|準備)/iu;
const changeWords = /(?:رصد\s*کن|ذخیره\s*کن|ایجاد\s*کن|تغییر\s*بده|متوقف\s*کن|اضافه\s*کن|آماده\s*کن|\b(?:create|edit|set|update|pause|resume|prepare|save)\b)/iu;
const genericWords = new Set(["کالا", "قیمت", "رصد", "مدل", "عدد", "نام", "دیجی", "اسنپ", "موجودی", "محصول",
  "کدام", "وضعیت", "بسته", "product", "watch", "price", "model", "this", "the", "and", "for", "with"]);
const validStores = new Set(["digikala", "snappshop"]);
const label = (value, locale) => normalizeSearchText(value, locale).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const storeOf = item => item.store ?? "digikala";
const toman = value => Number.isSafeInteger(value) ? digikalaPrice(value * 10) : null;
const clip = (value, length) => shoppingTitle(value).slice(0, length).toWellFormed();

function productFrom(value) {
  const product = shoppingProductLink(value);
  if (!product) return null;
  const store = storeOf(product);
  return { ...product, store, url: shoppingProductUrl(product),
    title: product.title || shoppingProductCode(product.productId, store) };
}

export async function activeAssistantProduct(windowId) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, ...(windowId === undefined ? { currentWindow: true } : { windowId }) });
    const product = tab?.incognito ? null : productFrom(tab?.url);
    if (product) return { ...product, title: shoppingTitle(tab.title) || product.title };
  } catch { /* The browser can withhold the current tab URL. */ }
  return null;
}

export function shoppingWatchDetails(state, id, now = Date.now()) {
  const watch = state.watches.find(item => item.id === id);
  if (!watch) return null;
  const sample = state.observations[watch.id];
  const current = sample?.rule === shoppingWatchKey(watch) ? sample : null;
  const job = state.purchases.jobs[watch.id];
  const status = shoppingWatchStatus(watch, current, job, now);
  const fresh = current && !current.error && now - current.checkedAt <= 3 * shoppingPollMinutes * 60_000;
  return {
    watch, status, quote: fresh ? current.quote : null, checkedAt: current?.checkedAt,
    checkout: shoppingPurchaseStatus(watch, job, state.purchases.policy)
  };
}

export async function assistantShoppingContext(prompt, sources, state, locale, readProduct) {
  const words = label(prompt, locale);
  const links = prompt.match(/(?:https:\/\/|(?:www\.)?(?:digikala\.com|snappshop\.ir)\/)[^\s<>"«»]+|\b(?:dkp|snp)-\d+\b/giu) ?? [];
  const linked = links.map(link => productFrom(link.replace(/[\])}،؛,.!?؟]+$/gu, ""))).filter(Boolean);
  const attached = new Set(sources.filter(source => source.kind === "shopping" && source.watchId).map(source => source.watchId));
  const terms = words.split(" ").filter(word => word.length >= 3 && !genericWords.has(word));
  const matching = state.watches.filter(watch => {
    const names = [watch.title, watch.optionLabel, watch.sellerName].map(name => label(name, locale));
    return names.some(name => name.length >= 3 && (words.includes(name) || terms.some(term => name.split(" ").includes(term))));
  });
  const products = linked.length ? linked : sources.filter(source => !source.watchId).map(source => productFrom(source.url)).filter(Boolean);
  if (!products.length && !attached.size && !shoppingWords.test(words) && !matching.length) return null;
  const unique = [...new Map(products.map(product => [product.url, product])).values()];
  const product = unique.length === 1 ? unique[0] : unique.length === 0 && currentProductWords.test(words) && !attached.size
    ? await readProduct() : null;
  const relevant = attached.size ? state.watches.filter(watch => attached.has(watch.id))
    : matching.length ? matching : product ? state.watches.filter(watch => watch.productId === product.productId && storeOf(watch) === product.store)
      : state.watches;
  const statusQuery = watchQuestions.test(words) && !changeWords.test(words) ? (readyQuestions.test(words) ? "ready" : "current") : null;
  const refs = new Map();
  const watches = relevant.slice(0, 24).map((watch, index) => {
    const id = `w${index + 1}`;
    refs.set(id, watch);
    const { status, checkout, quote } = shoppingWatchDetails(state, watch.id);
    return {
      id, title: clip(watch.title, 240), store: storeOf(watch), status,
      checkout: checkout ?? null,
      quantity: Math.min(watch.quantity ?? 1, 999_999),
      price_toman: quote?.price ? Math.ceil(quote.price / 10) : null,
      price_limit_toman: watch.priceLimit ? Math.ceil(watch.priceLimit / 10) : null,
      stock: Number.isSafeInteger(quote?.maxQuantity) ? Math.min(quote.maxQuantity, 999_999) : null,
      discount: quote?.discount > 0 && quote.discount < 100 ? quote.discount : null,
      minimum_discount: watch.discount,
      option: clip(watch.optionLabel || watch.variantLabel || quote?.optionLabel, 160) || null,
      seller: clip(watch.sellerName || quote?.sellerName, 160) || null
    };
  });
  return { product, refs, input: { watches, ...(statusQuery && { status_query: statusQuery }),
    ...(product && { product: { title: clip(product.title, 240), store: product.store } }) } };
}

function ruleChanges(action) {
  const patch = {};
  for (const [from, to, parse] of [
    ["price_toman", "priceLimit", toman],
    ["quantity", "quantity", value => value <= 999_999 && shoppingQuantity(value)],
    ["discount", "discount", value => Number.isInteger(value) && value >= 1 && value <= 99 ? value : null],
    ["starts", "startAt", value => taskTimestamp(value?.date, value?.time ?? "00:00")],
    ["ends", "endAt", value => taskTimestamp(value?.date, value?.time ?? "23:59")]
  ]) {
    if (!Object.hasOwn(action, from)) continue;
    if (action[from] === null && from !== "quantity") patch[to] = null;
    else if (!(patch[to] = parse(action[from]))) return null;
  }
  if (Object.hasOwn(action, "paused")) {
    if (typeof action.paused !== "boolean") return null;
    patch.paused = action.paused;
  }
  if (patch.startAt && patch.endAt && patch.startAt >= patch.endAt) return null;
  return patch;
}

export function prepareShoppingDraft(action, context) {
  if (!context) return null;
  if (action.operation === "status") {
    if (!Array.isArray(action.watch_ids)) return null;
    const watchIds = [...new Set(action.watch_ids.slice(0, 24).map(ref => context.refs.get(ref)?.id).filter(Boolean))];
    return watchIds.length ? { action, shopping: { watchIds } } : null;
  }
  if (!["create", "edit"].includes(action.operation)) return null;
  const changes = ruleChanges(action);
  if (!changes) return null;
  const budget = toman(action.budget_toman);
  if (action.mode && !["prepare", "notify"].includes(action.mode) || (action.mode === "prepare") !== Boolean(budget)) return null;
  if (action.exclude_sellers && (!Array.isArray(action.exclude_sellers) || action.exclude_sellers.length > 24
    || !action.exclude_sellers.every(name => clip(name, 160)))) return null;
  const selection = { option: clip(action.option, 160), seller: clip(action.seller, 160),
    exclude: (action.exclude_sellers ?? []).map(name => clip(name, 160)) };
  const purchase = action.mode ? { mode: action.mode, ...(budget && { limit: budget }) } : undefined;
  if (action.operation === "edit") {
    const watch = context.refs.get(action.watch);
    return watch ? { action, shopping: { watchId: watch.id, title: watch.title, store: storeOf(watch), changes, selection, purchase } } : null;
  }
  const product = action.use_product === true ? context.product : null;
  const query = !product && clip(action.query, 140);
  if (!product && (!query || /:\/\/|^www\./iu.test(query))) return null;
  return { action, shopping: { product, query, title: product?.title || query,
    store: product?.store ?? (validStores.has(action.store) ? action.store : undefined), changes, selection, purchase } };
}

export function assistantShoppingQuickSave(draft) {
  return Boolean(draft?.product && !draft.watchId && (!draft.purchase || draft.purchase.mode === "notify"));
}

export function hasAssistantOfferSelection(selection) {
  return selection?.option || selection?.seller || selection?.exclude?.length;
}

export function assistantWatchRule(product, base, changes, selection, locale) {
  const rule = { ...base, ...changes };
  if (!hasAssistantOfferSelection(selection)) return rule;
  if (!Array.isArray(product?.offers)) return null;
  const current = product.offers.find(offer => offer.id === rule.variantId);
  let optionKey = rule.optionKey ?? current?.optionKey ?? null;
  let optionLabel = rule.optionLabel || current?.optionLabel || "";
  if (selection.option) {
    const requested = label(selection.option, locale);
    const options = new Map(product.offers.filter(offer => offer.optionKey && requested
      && ` ${label(offer.optionLabel, locale)} `.includes(` ${requested} `))
      .map(offer => [offer.optionKey, offer.optionLabel]));
    if (options.size !== 1) return null;
    [[optionKey, optionLabel]] = options;
  }
  const offers = product.offers.filter(offer => !optionKey || offer.optionKey === optionKey);
  if (selection.seller) {
    const matched = offers.filter(offer => offer.sellerId && label(offer.sellerName, locale) === label(selection.seller, locale));
    const selected = matched.find(offer => offer.id === rule.variantId) ?? (matched.length === 1 ? matched[0] : null);
    if (!selected) return null;
    return { ...rule, variantId: selected.id, variantLabel: selected.label, sellerId: selected.sellerId, sellerName: selected.sellerName,
      optionKey: null, optionLabel: "", allSellers: false, excludedSellers: [] };
  }
  const excluded = new Set(rule.excludedSellers);
  for (const name of selection.exclude) {
    const vendors = new Set(offers.filter(offer => offer.sellerId && label(offer.sellerName, locale) === label(name, locale)).map(offer => offer.sellerId));
    if (vendors.size !== 1) return null;
    excluded.add(vendors.values().next().value);
  }
  if (current && !selection.exclude.length && optionKey === current.optionKey) return rule;
  return { ...rule, optionKey, optionLabel, allSellers: true, excludedSellers: [...excluded],
    variantId: null, variantLabel: "", sellerId: null, sellerName: "" };
}
