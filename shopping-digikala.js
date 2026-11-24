import { digikalaId, digikalaImage, digikalaPrice } from "./shopping-store.js";

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
  return digikalaImage(main?.url?.[0] ?? main?.webp_url?.[0] ?? main);
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
  const label = [raw.color?.title, raw.size?.title, raw.warranty?.title, raw.seller?.title]
    .map(value => text(value, 90)).filter(Boolean).join(" · ");
  return { id, label, ...pricesFor(raw, productStatus) };
}

function productSummary(raw) {
  const id = digikalaId(raw?.id);
  const title = text(raw?.title_fa || raw?.title_en);
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

async function readPublicJson(url, product = false) {
  const response = await fetch(url, {
    credentials: "omit", cache: "no-store", redirect: "error",
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000)
  });
  if (product && response.status === 404) throw new ShoppingLookupError("shoppingProductMissing");
  if (!response.ok) throw new ShoppingLookupError("shoppingUnavailable");
  return response.json();
}

export async function readDigikalaProduct(id) {
  const productId = digikalaId(id);
  if (!productId) throw new ShoppingLookupError("shoppingInvalidLink");
  const data = await readPublicJson(`${api}/v2/product/${productId}/`, true);
  return productDetails(data, productId);
}

export async function searchDigikala(query) {
  const url = new URL(`${api}/discovery/api/v2/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("page", "1");
  const products = searchProducts(await readPublicJson(url));
  return [...new Map(products.map(productSummary).filter(Boolean).map(item => [item.id, item])).values()].slice(0, 12);
}

export function quoteForWatch(product, variantId) {
  const offer = variantId ? product.offers.find(item => item.id === variantId) : product.main;
  return { title: product.title, image: product.image, variantId: offer?.id ?? variantId,
    variantLabel: offer?.label ?? "", price: offer?.price ?? null, reference: offer?.reference ?? null,
    available: offer ? offer.available : (product.unavailable || (variantId && product.hasVariants) ? false : null),
    singleItem: offer?.singleItem ?? false, discount: offer?.discount ?? null };
}
