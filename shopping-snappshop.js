import { ShoppingLookupError } from "./shopping-digikala.js";
import {
  digikalaId, digikalaPrice, shoppingProductCode, shoppingTitle, snappShopId, snappShopImage, snappShopProductLink
} from "./shopping-store.js";

const api = "https://apix.snappshop.ir";
const storefront = "https://snappshop.ir";
// The public storefront's default Tehran area, before a delivery address is chosen.
const defaultArea = { lat: "35.77331", lng: "51.418591" };
export const snappShopPermission = { origins: [`${api}/*`, `${storefront}/*`, "https://www.snappshop.ir/*"] };

function rials(toman) {
  return Number.isSafeInteger(toman) ? digikalaPrice(toman * 10) : null;
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function prices(original, special, discount) {
  const reference = rials(original);
  const sale = rials(special);
  if (!reference || !sale || sale >= reference) return { price: reference ?? sale, reference: null, discount: null };
  return { price: sale, reference, discount: Number.isInteger(discount) && discount > 0 && discount < 100
    ? discount : Math.floor(100 * (reference - sale) / reference) };
}

export function snappShopProductDetails(productId, data) {
  if (!digikalaId(productId) || !data || !Array.isArray(data.variants)) throw new ShoppingLookupError("shoppingUnavailable");
  const vendors = new Map(asList(data.vendors).map(vendor => [snappShopId(vendor?.id), shoppingTitle(vendor?.title)]));
  const warranties = new Map(asList(data.warranties).map(warranty => [snappShopId(warranty?.id), shoppingTitle(warranty?.name)]));
  const attributes = new Map(asList(data.configurable_attribute).map(attribute => [
    `${attribute?.id}:${attribute?.value?.id}`, shoppingTitle(attribute?.value?.title)
  ]));
  const seen = new Set();
  const offers = [];
  for (const variant of data.variants) {
    const variation = snappShopId(variant?.variation_id);
    if (!variation) continue;
    const optionFields = asList(variant.attribute_ids).map(attribute => ({
      group: snappShopId(attribute?.attribute_id), id: snappShopId(attribute?.attribute_value_id),
      name: attributes.get(`${attribute?.attribute_id}:${attribute?.attribute_value_id}`)
    })).filter(attribute => attribute.group && attribute.id && attribute.name);
    const optionValues = optionFields.map(attribute => attribute.name);
    const optionLabel = optionValues.join(" · ");
    for (const raw of asList(variant.vendor)) {
      const id = snappShopId(raw?.vendor_product_info_id);
      const sellerId = snappShopId(raw?.vendor_id);
      if (!id || !sellerId || seen.has(id)) continue;
      const amounts = prices(raw.price, raw.special_price, raw.special_price_percent_discount);
      const stock = Number.isSafeInteger(raw.stock) && raw.stock > 0 ? raw.stock : 0;
      const available = Boolean(amounts.price && stock && (raw.is_available_in_shop || raw.is_available_in_vendor_inventory)
        && Object.values(raw.shipment ?? {}).some(delivery => delivery?.enabled === true));
      const warranty = warranties.get(snappShopId(raw.warranty_id)) ?? "";
      seen.add(id);
      const defaultForOption = variation === data.default_variant?.variation_id
        ? id === data.default_variant?.vendor_product_info_id : id === variant.vendor[0]?.vendor_product_info_id;
      offers.push({ id, sellerId, sellerName: vendors.get(sellerId) ?? "", optionKey: variation, optionLabel, optionValues, optionFields,
        optionsComplete: optionFields.length === asList(variant.attribute_ids).length, defaultForOption,
        label: [optionLabel, warranty].filter(Boolean).join(" · "), warranty, ...amounts, available,
        minQuantity: 1, maxQuantity: stock });
    }
  }
  const main = offers.find(offer => offer.id === data.default_variant?.vendor_product_info_id) ?? offers[0] ?? null;
  return {
    store: "snappshop", id: String(productId),
    title: shoppingTitle(data.content?.title_fa || data.content?.title_en) || shoppingProductCode(productId, "snappshop"),
    image: asList(data.images).map(image => snappShopImage(image?.src)).find(Boolean) ?? null,
    price: main?.price ?? null, main, offers, hasVariants: true, unavailable: !offers.some(offer => offer.available)
  };
}

async function catalogRequest(path, body) {
  const url = new URL(path, api);
  url.search = new URLSearchParams(defaultArea);
  let response;
  try {
    response = await fetch(url, {
      credentials: "omit", redirect: "manual", signal: AbortSignal.timeout(9000),
      headers: body ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {})
    });
  } catch { throw new ShoppingLookupError("shoppingStoreConnection"); }
  if (response.type === "opaqueredirect" || response.redirected || response.status >= 300 && response.status < 400) {
    throw new ShoppingLookupError("shoppingStoreConnection");
  }
  if (response.status === 404 && !body) throw new ShoppingLookupError("shoppingProductMissing");
  if (response.status === 401 || response.status === 403) throw new ShoppingLookupError("shoppingStoreBlocked");
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new ShoppingLookupError("shoppingUnavailable");
  try { return (await response.json()).data; }
  catch { throw new ShoppingLookupError("shoppingUnavailable"); }
}

export async function readSnappShopProduct(productId) {
  const id = digikalaId(productId);
  if (!id) throw new ShoppingLookupError("shoppingInvalidLink");
  return snappShopProductDetails(id, await catalogRequest(`/products/v2/${id}`));
}

export async function searchSnappShop(query) {
  const data = await catalogRequest("/search/v1", { query, limit: 8 });
  const found = new Map();
  for (const group of asList(data?.structure)) {
    for (const item of asList(group?.items)) {
      const href = item?.href;
      const link = typeof href === "string" && snappShopProductLink(href.startsWith("/product/") ? storefront + href : href);
      const title = shoppingTitle(item?.title);
      if (!link || !title || found.has(link.productId)) continue;
      const { price } = prices(item.price?.price, item.price?.discounted_price, item.price?.discount);
      found.set(link.productId, { id: link.productId, title, price, image: snappShopImage(item.image?.src), store: "snappshop" });
      if (found.size === 8) return [...found.values()];
    }
  }
  return [...found.values()];
}
