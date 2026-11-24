import { digikalaId, digikalaImage, digikalaPrice, shoppingPriceStatus, shoppingTitle } from "./shopping-store.js";

const api = "https://api.digikala.com";
export const shoppingHostPermission = { origins: [`${api}/*`, "https://www.digikala.com/*"] };
export const shoppingNotificationPermission = { permissions: ["notifications"] };
const unavailableStatuses = new Set(["out_of_stock", "coming_soon", "stop_production", "no_active_variant", "unavailable"]);
const availableStatuses = new Set(["marketable", "available"]);

export class ShoppingLookupError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function text(value, limit = 240) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function imageFor(product) {
  const main = product.images?.main;
  const url = main?.url ?? main?.webp_url ?? main;
  return digikalaImage(Array.isArray(url) ? url[0] : url);
}

function pricesFor(raw, productStatus) {
  const current = digikalaPrice(raw?.price?.selling_price);
  const reference = digikalaPrice(raw?.price?.rrp_price);
  const status = raw?.status ?? productStatus;
  const discount = current && reference ? Math.max(0, Math.floor((reference - current) * 100 / reference)) : null;
  const minQuantity = raw?.price?.min_order_limit ?? raw?.min_order_limit ?? 1;
  const unavailable = unavailableStatuses.has(status) || unavailableStatuses.has(productStatus)
    || raw?.price?.marketable_stock === 0 || raw?.price?.is_locked_for_digiplus === true;
  const available = unavailable ? false : current && availableStatuses.has(status) ? true : null;
  return { price: available ? current : null, reference: available ? reference : null,
    discount: available ? discount : null, available, singleItem: minQuantity === 1 };
}

function offerFor(raw, productStatus) {
  const id = digikalaId(raw?.id ?? raw?.variant_id);
  if (!id) return null;
  const label = [raw.color?.title, raw.size?.title, raw.warranty?.title]
    .map(value => text(value, 90)).filter(Boolean).join(" · ");
  const sellerId = digikalaId(raw.seller?.id);
  const sellerName = text(raw.seller?.title, 120);
  return { id, label, sellerId, sellerName, ...pricesFor(raw, productStatus) };
}

function productSummary(raw) {
  const id = digikalaId(raw?.id);
  const title = shoppingTitle(raw?.title_fa || raw?.title_en);
  if (!id || !title) return null;
  const main = offerFor(raw.default_variant, raw.status);
  return { id, title, image: imageFor(raw), price: main?.price ?? null, discount: main?.discount ?? null };
}

function productDetails(payload, productId) {
  const raw = payload?.data?.product;
  const product = productSummary(raw);
  if (product?.id !== productId || (!availableStatuses.has(raw.status) && !unavailableStatuses.has(raw.status))) {
    throw new ShoppingLookupError("shoppingUnavailable");
  }
  const main = offerFor(raw.default_variant, raw.status);
  if (availableStatuses.has(raw.status) && !main) throw new ShoppingLookupError("shoppingUnavailable");
  const offers = new Map(main ? [[main.id, main]] : []);
  if (Array.isArray(raw.variants)) {
    for (const data of raw.variants) {
      const offer = offerFor(data, raw.status);
      if (offer && !offers.has(offer.id)) offers.set(offer.id, offer);
    }
  }
  return { ...product, main, offers: [...offers.values()], hasVariants: Array.isArray(raw.variants),
    unavailable: unavailableStatuses.has(raw.status) };
}

function searchProducts(payload) {
  const data = payload?.data;
  if (Array.isArray(data?.products)) return data.products;
  if (!Array.isArray(data?.widgets)) throw new ShoppingLookupError("shoppingUnavailable");
  const list = data.widgets.find(widget => widget?.type === "vertical_product_listing")?.data?.widgets;
  return Array.isArray(list) ? list.filter(widget => widget?.type === "product").map(widget => widget.data) : [];
}

async function readDigikalaJson(url, { product = false } = {}) {
  if (new URL(url).origin !== api) throw new ShoppingLookupError("shoppingUnavailable");
  const options = {
    credentials: "include", cache: "no-store", redirect: "manual",
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000)
  };
  const redirected = response => response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
  let response = await fetch(url, options);
  // Digikala sets a CDN cookie on the first request. Retry the same endpoint with the browser's cookie jar.
  if (redirected(response)) response = await fetch(url, options);
  if (redirected(response)) throw new ShoppingLookupError("shoppingStoreConnection");
  if (product && response.status === 404) throw new ShoppingLookupError("shoppingProductMissing");
  if (response.status === 401 || response.status === 403) throw new ShoppingLookupError("shoppingStoreBlocked");
  if (!response.ok) throw new ShoppingLookupError("shoppingUnavailable");
  return response.json();
}

export async function readDigikalaProduct(id) {
  const productId = digikalaId(id);
  if (!productId) throw new ShoppingLookupError("shoppingInvalidLink");
  const data = await readDigikalaJson(`${api}/product/v1/products/${productId}/`, { product: true });
  return productDetails(data, productId);
}

export async function searchDigikala(query) {
  const url = new URL(`${api}/discovery/api/v2/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("page", "1");
  const products = searchProducts(await readDigikalaJson(url));
  return [...new Map(products.map(productSummary).filter(Boolean).map(item => [item.id, item])).values()].slice(0, 12);
}

export function quoteForWatch(product, watch) {
  const { variantId } = watch;
  let offer;
  let noEligibleSeller = false;
  let availability = product.unavailable || (variantId && product.hasVariants) ? false : null;
  if (variantId) offer = product.offers.find(item => item.id === variantId);
  else if (!watch.allSellers) offer = product.main;
  else {
    const excluded = new Set(watch.excludedSellers);
    const eligible = product.offers.filter(item => excluded.size === 0 || (item.sellerId && !excluded.has(item.sellerId)));
    const available = eligible.filter(item => item.available).sort((a, b) => a.price - b.price);
    offer = available.find(item => shoppingPriceStatus(watch, item) === "shoppingReady") ?? available[0];
    noEligibleSeller = !product.unavailable && product.hasVariants && eligible.length === 0 && excluded.size > 0;
    if (product.hasVariants && eligible.length && eligible.every(item => item.available === false)) availability = false;
  }
  return { title: product.title, image: product.image, variantId: offer?.id ?? variantId,
    variantLabel: offer?.label ?? "", sellerId: offer?.sellerId ?? null, sellerName: offer?.sellerName ?? "",
    price: offer?.price ?? null, reference: offer?.reference ?? null,
    available: offer ? offer.available : availability, ...(noEligibleSeller ? { noEligibleSeller } : {}),
    singleItem: offer?.singleItem ?? false, discount: offer?.discount ?? null };
}
