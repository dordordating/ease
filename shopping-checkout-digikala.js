import { readDigikalaJson } from "./shopping-digikala.js";
import { digikalaId, digikalaPrice } from "./shopping-store.js";
import { checkoutItemsKey } from "./shopping-purchase-store.js";

const storefront = "https://www.digikala.com";
const api = "https://api.digikala.com";
const webCheckout = { headers: { "x-site": "DIGIKALA", "x-source": "WEB" } };
export const digikalaCartUrl = storefront + "/checkout/cart/";
export const digikalaShippingUrl = storefront + "/checkout/shipping/";
export const digikalaOrdersUrl = storefront + "/profile/orders/";

export class DigikalaCheckoutError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function opaqueId(value) {
  const id = Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === "string" && /^[a-z\d][a-z\d_-]{0,79}$/iu.test(id) ? id : null;
}

function amount(value) {
  return value === 0 ? 0 : digikalaPrice(value);
}

function isDigiPayWallet(label) {
  return typeof label === "string" && label.replace(/[\s\u200c\u200f\u200e]/gu, "").replace(/ي/gu, "ی").replace(/ك/gu, "ک") === "کیفپولدیجیپی";
}

// Only the cart identities, quantities and rials needed by the purchase rule leave this adapter.
export function readCheckoutCart(data, raw = data?.cart_data ?? data?.cart, rawItems = data?.cart_items) {
  if (!raw || !Number.isSafeInteger(raw.total_quantity) || raw.total_quantity < 0) return null;
  const packages = data?.packages;
  if (rawItems === undefined && Array.isArray(packages) && packages.every(part => Array.isArray(part.cart_items))) {
    rawItems = packages.flatMap(part => part.cart_items);
  }
  if (!Array.isArray(rawItems)) {
    if (raw.total_quantity !== 0) return null;
    rawItems = [];
  }
  const items = rawItems.map(row => ({
    variantId: digikalaId(row?.variant_id ?? row?.variant?.id),
    productId: digikalaId(row?.product?.id),
    sellerId: digikalaId(row?.variant?.seller?.id),
    quantity: row?.quantity,
    price: digikalaPrice(row?.price?.selling_price ?? row?.variant?.price?.selling_price)
  }));
  const id = opaqueId(raw.id);
  if ((items.length && !id) || items.some(row => !row.variantId || !Number.isSafeInteger(row.quantity) || row.quantity < 1)
    || items.reduce((sum, row) => sum + row.quantity, 0) !== raw.total_quantity) return null;
  const extraServices = Boolean(raw.temporary_plus_subscription?.payable_price || raw.gift_card_amount
    || raw.delivery_package_box?.selected_package || raw.insurance?.amount
    || data?.fresh?.cart_items?.length || data?.invalid_items?.stock_invalid_items?.cart_items?.length
    || rawItems.some(item => item.has_insurance || item.dk_service?.checked || item.e_gift_card_properties?.receiver_phone_number));
  return { id, items, extraServices };
}

export async function loadDigikalaCart() {
  const { data } = await readDigikalaJson(api + "/checkout/v1/carts", webCheckout);
  const cart = readCheckoutCart(data);
  if (!cart) throw new DigikalaCheckoutError("shoppingPurchaseReview");
  return cart;
}

export async function readDigikalaBuyer() {
  let profile, saved;
  try {
    [profile, saved] = await Promise.all([
      readDigikalaJson(api + "/account/v1/user/profile/info/"),
      readDigikalaJson(api + "/address/v2/addresses?page=1&size=20", {
        headers: { ...webCheckout.headers, "X-Client": "web", "Accept-Language": "fa" }
      })
    ]);
  } catch { throw new DigikalaCheckoutError("shoppingPurchaseSignIn"); }
  const accountId = opaqueId(profile?.data?.id);
  if (!accountId) throw new DigikalaCheckoutError("shoppingPurchaseSignIn");
  const address = saved?.data?.location;
  const addressId = opaqueId(address?.id);
  if (!addressId) throw new DigikalaCheckoutError("shoppingPurchaseAddress");
  // Bind a wallet authorization to the saved address, including edits made under the same address ID.
  const fields = [addressId, address.type, address.address, address.recipientName, address.recipientMobilePhone,
    address.postCode, address.buildingNumber, address.unit, address.latitude, address.longitude];
  const sha = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(fields)));
  return { accountId, addressId, addressKey: Array.from(new Uint8Array(sha), byte => byte.toString(16).padStart(2, "0")).join("") };
}

export function checkoutInvoice(data, walletOnly = false) {
  const sources = Array.isArray(data?.payment_types)
    ? data.payment_types.flatMap(group => Array.isArray(group?.sources) ? group.sources : [])
      .filter(source => isDigiPayWallet(source?.title))
    : [];
  const wallet = sources.length === 1 ? sources[0] : null;
  const walletData = data?.balance_data?.wallet;
  const walletBalance = walletData?.activation_url ? null : amount(wallet?.balance ?? walletData?.credit);
  const base = data?.cart_data ?? data?.cart;
  const methodPrice = walletOnly && wallet?.price_type != null ? data.price_types_cart_data?.[wallet.price_type] : null;
  const raw = methodPrice ? { ...base, ...methodPrice } : base;
  const cart = readCheckoutCart(data, raw, methodPrice?.items ?? data?.cart_items);
  if (!cart || !data || raw?.id == null || data.order?.id) return null;
  const shipping = raw.shipping_cost === "رایگان" ? 0 : amount(raw.shipping_cost);
  const shipments = data.cart_shipments;
  const addressIds = Array.isArray(shipments) ? shipments.map(part => opaqueId(part?.address?.id)) : [];
  const deliveryKnown = shipping !== null && !(typeof raw.shipping_cost_hint === "string" && /پس\s*[‌-]?\s*کرایه/u.test(raw.shipping_cost_hint))
    && !(Array.isArray(shipments) && shipments.some(part => part?.is_cash_on_delivery));
  return { cart, total: amount(raw.payable_price), shipping: deliveryKnown ? shipping : null, walletBalance,
    walletSelectable: wallet ? wallet.is_clickable === true && !wallet.info : walletBalance !== null,
    addressIds };
}

export async function loadDigikalaInvoice(walletOnly = false) {
  // Digikala serves both its current and previous payment screens.
  for (const path of ["/checkout/v1/payments", "/v3/payment/"]) {
    const result = await readDigikalaJson(api + path, webCheckout).catch(() => null);
    const invoice = checkoutInvoice(result?.data, walletOnly);
    if (invoice) return invoice;
  }
  throw new DigikalaCheckoutError("shoppingPurchaseReview");
}

export function checkoutInvoiceKey(invoice) {
  return JSON.stringify([invoice.cart.id, checkoutItemsKey(invoice.cart), invoice.total, invoice.shipping, invoice.addressIds]);
}

export function digikalaCheckoutStage(input) {
  try {
    const url = new URL(input);
    if (url.origin !== storefront) return "outside";
    const path = url.pathname.replace(/\/$/u, "");
    if (path === "/checkout/cart") return "cart";
    if (path === "/checkout/shipping") return "shipping";
    if (path === "/checkout/payment") return "payment";
    if (/^\/checkout\/thank-you\/payment\/[a-z\d_-]+\/[a-z\d_-]+$/iu.test(path)) return "receipt";
  } catch { /* Chrome can report an empty URL during navigation. */ }
  return "other";
}

export async function readDigikalaReceipt(input, cartId) {
  if (digikalaCheckoutStage(input) !== "receipt") return null;
  const [id, code] = new URL(input).pathname.replace(/\/$/u, "").split("/").slice(-2);
  if (!opaqueId(id) || !opaqueId(code)) return null;
  const { data } = await readDigikalaJson(`${api}/v1/thank-you/payment/${id}/${code}/`);
  const order = data?.order;
  const orderId = opaqueId(order?.id);
  if (data?.status !== "success" || !orderId || opaqueId(order.cart_id) !== cartId
    || (order.remaining_amount != null && order.remaining_amount !== 0)) return null;
  return { orderId };
}
