const productHosts = new Set(["www.digikala.com", "digikala.com"]);
const imageHosts = new Set(["dkstatics-public.digikala.com", "static.digikala.com"]);
const productPath = /^\/product\/dkp-([1-9]\d{0,11})(?:\/|$)/u;
const watchLimit = 20;
const maxPriceRials = 10_000_000_000_000;

export const shoppingPollMinutes = 2;
export const defaultShopping = Object.freeze([]);

export function digikalaId(value) {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === "string" && /^[1-9]\d{0,11}$/u.test(id) ? id : null;
}

export function digikalaProductLink(input) {
  if (typeof input !== "string" || input.length > 2000) return null;
  const value = input.trim();
  const code = value.match(/^dkp-([1-9]\d{0,11})$/iu);
  if (code) return { productId: code[1], variantId: null };
  try {
    const url = new URL(/^(?:www\.)?digikala\.com\//iu.test(value) ? `https://${value}` : value);
    const match = url.pathname.match(productPath);
    if (url.protocol !== "https:" || !productHosts.has(url.host) || url.username || url.password || !match) return null;
    return { productId: match[1], variantId: digikalaId(url.searchParams.get("variant_id")) };
  } catch {
    return null;
  }
}

export function digikalaProductUrl(productId, variantId) {
  const id = digikalaId(productId);
  if (!id) return null;
  const url = new URL(`https://www.digikala.com/product/dkp-${id}/`);
  const variant = digikalaId(variantId);
  if (variant) url.searchParams.set("variant_id", variant);
  return url.href;
}

export function digikalaSearchUrl(query) {
  const url = new URL("https://www.digikala.com/search/");
  if (query) url.searchParams.set("q", query);
  return url.href;
}

export function digikalaImage(value) {
  if (typeof value !== "string" || value.length > 1400) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && imageHosts.has(url.host) && !url.username && !url.password) {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // Invalid image URLs fall back to the module icon.
  }
  return null;
}

export function digikalaPrice(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= maxPriceRials ? value : null;
}

export function parseShoppingNumber(value) {
  const digits = value.trim().replace(/[٠-٩۰-۹]/gu, digit => String(digit.codePointAt(0) & 15));
  const number = digits.replace(/[\s,٬]/gu, "");
  return number && /^\d+$/u.test(number) ? Number(number) : NaN;
}

function watchText(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;
}

function normalizeWatch(source) {
  const productId = digikalaId(source?.productId);
  if (!productId) return null;
  const variantId = source.variantId == null ? null : digikalaId(source.variantId);
  const priceLimit = source.priceLimit == null ? null : digikalaPrice(source.priceLimit);
  const discount = source.discount ?? null;
  const startAt = source.startAt ?? null;
  const endAt = source.endAt ?? null;
  if ((source.variantId != null && !variantId) || (source.priceLimit != null && !priceLimit)
    || (discount !== null && (!Number.isInteger(discount) || discount < 1 || discount > 99))
    || (startAt !== null && !timestamp(startAt)) || (endAt !== null && !timestamp(endAt))
    || (startAt !== null && endAt !== null && endAt <= startAt)) return null;
  return {
    productId, variantId, priceLimit, discount, startAt, endAt,
    title: watchText(source.title, 240) || `DKP-${productId}`,
    variantLabel: variantId ? watchText(source.variantLabel, 180) : "",
    image: digikalaImage(source.image),
    paused: source.paused === true
  };
}

export function restoreShopping(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > watchLimit) return null;
  const ids = new Set();
  const watches = [];
  for (const raw of value) {
    const watch = normalizeWatch(raw);
    if (!watch || typeof raw.id !== "string" || !/^[a-f0-9-]{36}$/u.test(raw.id) || ids.has(raw.id)) return null;
    ids.add(raw.id);
    watches.push({ id: raw.id, ...watch });
  }
  return watches;
}

export function shoppingWatchKey(watch) {
  return JSON.stringify([watch.productId, watch.variantId, watch.priceLimit, watch.discount, watch.startAt, watch.endAt]);
}

export function updateShopping(workspace, action, data) {
  const watches = restoreShopping(workspace.shopping) ?? [];
  const current = watches.find(watch => watch.id === data?.id);
  if (data?.id != null && !current) return "shoppingRuleMissing";
  if (action === "shopping-remove" && current) {
    workspace.shopping = watches.filter(watch => watch !== current);
    return;
  }
  if (action === "shopping-pause" && current && typeof data.paused === "boolean") {
    workspace.shopping = watches.map(watch => watch === current ? { ...watch, paused: data.paused } : watch);
    return;
  }
  if (action !== "shopping-save") return "shoppingInvalidRule";

  const watch = normalizeWatch({ ...data, paused: current?.paused });
  if (!watch) return "shoppingInvalidRule";
  if (!current && watches.length >= watchLimit) return "shoppingLimit";
  if (watches.some(item => item !== current && shoppingWatchKey(item) === shoppingWatchKey(watch))) return "shoppingDuplicate";
  const saved = { id: current?.id ?? crypto.randomUUID(), ...watch };
  workspace.shopping = current ? watches.map(item => item === current ? saved : item) : [saved, ...watches];
}

export function shoppingObservationKey(owner) {
  return `easeShoppingObservations:${owner ? `account:${owner}` : "guest"}`;
}

export function shoppingStatus(watch, observation, now = Date.now()) {
  if (watch.paused) return "shoppingPaused";
  if (watch.endAt !== null && now >= watch.endAt) return "shoppingExpired";
  if (watch.startAt !== null && now < watch.startAt) return "shoppingScheduled";
  if (!observation || observation.rule !== shoppingWatchKey(watch)) return "shoppingWaitingCheck";
  if (observation.error || now - observation.checkedAt > 3 * shoppingPollMinutes * 60_000) return "shoppingUnavailable";
  const quote = observation.quote;
  if (quote?.available == null) return "shoppingUnavailable";
  if (!quote.available) return "shoppingOutOfStock";
  if (watch.priceLimit !== null && quote.price > watch.priceLimit) return "shoppingWaitingPrice";
  if (watch.discount !== null && (quote.discount === null || quote.discount < watch.discount)) {
    return "shoppingWaitingDiscount";
  }
  return "shoppingReady";
}
