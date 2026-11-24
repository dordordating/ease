import { digikalaId, digikalaPrice } from "./shopping-store.js";
import { checkoutItemsKey } from "./shopping-purchase-store.js";
import { DigikalaCheckoutError, digikalaStorefront as storefront, readDigikalaInTab } from "./shopping-digikala-session.js";

export const digikalaCartUrl = storefront + "/checkout/cart/";
export const digikalaShippingUrl = storefront + "/checkout/shipping/";
export const digikalaOrdersUrl = storefront + "/profile/orders/";
export const digikalaAddressesUrl = storefront + "/profile/addresses/";

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
  const items = rawItems.map(row => {
    const id = opaqueId(row?.id);
    const unit = digikalaPrice(row?.variant?.price?.selling_price);
    const amount = digikalaPrice(row?.price?.selling_price);
    const price = unit && amount === unit * row.quantity ? unit : amount ?? unit;
    return {
      ...(id ? { id } : {}),
      variantId: digikalaId(row?.variant_id ?? row?.variant?.id),
      productId: digikalaId(row?.product?.id),
      sellerId: digikalaId(row?.variant?.seller?.id),
      quantity: row?.quantity,
      price
    };
  });
  const id = opaqueId(raw.id);
  if ((items.length && !id) || items.some(row => !row.variantId || !Number.isSafeInteger(row.quantity) || row.quantity < 1)
    || items.reduce((sum, row) => sum + row.quantity, 0) !== raw.total_quantity) return null;
  const extraServices = Boolean(raw.temporary_plus_subscription?.payable_price || raw.gift_card_amount
    || raw.delivery_package_box?.selected_package || raw.insurance?.amount
    || data?.fresh?.cart_items?.length || data?.invalid_items?.stock_invalid_items?.cart_items?.length
    || rawItems.some(item => item.has_insurance || item.dk_service?.checked || item.e_gift_card_properties?.receiver_phone_number));
  return { id, items, extraServices };
}

function requireResponse(result, allowMissing = false) {
  if (result.status >= 200 && result.status < 300) return result.data;
  if (allowMissing && result.status === 404) return null;
  throw new DigikalaCheckoutError(result.status === 401 ? "shoppingPurchaseSignIn" : "shoppingPurchaseConnection");
}

export async function loadDigikalaCart(tabId) {
  const data = requireResponse(await readDigikalaInTab(tabId, "cart"));
  const cart = readCheckoutCart(data);
  if (!cart) throw new DigikalaCheckoutError("shoppingPurchaseReview");
  return cart;
}

export async function setDigikalaCartQuantity(tabId, itemId, quantity) {
  const result = await readDigikalaInTab(tabId, "cart-quantity", { id: itemId, quantity });
  if (result.status === 400 || result.status === 409 || result.status === 422) {
    throw new DigikalaCheckoutError("shoppingWaitingQuantity");
  }
  requireResponse(result);
}

async function readDigikalaAccount(tabId) {
  const profile = requireResponse(await readDigikalaInTab(tabId, "profile"));
  const accountId = opaqueId(profile?.id);
  if (!accountId) throw new DigikalaCheckoutError("shoppingPurchaseSignIn");
  return accountId;
}

async function buyerForAddress(accountId, address) {
  const addressId = opaqueId(address?.id);
  if (!addressId || typeof address.address !== "string" || !address.address.trim() || address.isUsable === false
    || address.isAccurate === false || address.dropOffAddressId) return null;
  // Preserve the address fingerprint used by saved wallet authorizations.
  const fields = [addressId, address.type, address.address, address.recipientName, address.recipientMobilePhone,
    address.postCode, address.buildingNumber, address.unit, address.latitude, address.longitude];
  const sha = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(fields)));
  return { accountId, addressId, addressKey: Array.from(new Uint8Array(sha), byte => byte.toString(16).padStart(2, "0")).join("") };
}

function addressItems(data) {
  const items = data?.addresses?.items;
  return Array.isArray(items) ? items : [];
}

async function savedDigikalaAddresses(tabId, targetId) {
  const [first, current] = await Promise.all([
    readDigikalaInTab(tabId, "addresses", 1).then(requireResponse),
    readDigikalaInTab(tabId, "default-address").then(result => requireResponse(result, true))
  ]);
  const rows = [...addressItems(first)];
  const defaultAddress = opaqueId(current?.id) ? current : rows.find(address => address?.isDefault)
    ?? (!rows.length ? first?.location : null);
  if (defaultAddress && !rows.some(address => opaqueId(address?.id) === opaqueId(defaultAddress.id))) rows.unshift(defaultAddress);
  if (targetId && opaqueId(first?.location?.id) === targetId && !rows.some(address => opaqueId(address?.id) === targetId)) {
    rows.push(first.location);
  }
  const pages = first?.addresses?.totalPages;
  for (let page = 2; Number.isSafeInteger(pages) && page <= pages && page <= 100; page += 1) {
    if (targetId && rows.some(address => opaqueId(address?.id) === targetId)) break;
    const result = requireResponse(await readDigikalaInTab(tabId, "addresses", page));
    rows.push(...addressItems(result));
  }
  return { rows, defaultId: opaqueId(defaultAddress?.id) };
}

export async function readDigikalaDeliveryChoices(tabId) {
  const accountId = await readDigikalaAccount(tabId);
  const { rows, defaultId } = await savedDigikalaAddresses(tabId);
  const choices = new Map();
  for (const address of rows) {
    const buyer = await buyerForAddress(accountId, address);
    if (!buyer || choices.has(buyer.addressId)) continue;
    const city = typeof address.city === "string" ? address.city : address.city?.name;
    choices.set(buyer.addressId, { id: buyer.addressId, key: buyer.addressKey,
      title: typeof address.name === "string" ? address.name.trim().slice(0, 100) : "",
      detail: [city, address.address].filter(Boolean).join("، ").slice(0, 420) });
  }
  return { accountId, defaultId, choices: [...choices.values()] };
}

export async function readDigikalaBuyer(tabId, addressId) {
  const accountId = await readDigikalaAccount(tabId);
  const { rows, defaultId } = await savedDigikalaAddresses(tabId, addressId);
  const buyer = await buyerForAddress(accountId, rows.find(address => opaqueId(address?.id) === (addressId ?? defaultId)));
  if (!buyer) throw new DigikalaCheckoutError("shoppingPurchaseAddress");
  return buyer;
}

export async function selectDigikalaDeliveryAddress(tabId, addressId, authorize) {
  const current = requireResponse(await readDigikalaInTab(tabId, "default-address"), true);
  if (opaqueId(current?.id) === addressId) return;
  if (!await authorize()) throw new DigikalaCheckoutError("shoppingConditionsChanged");
  // This is the selection used by Digikala's shipping screen. Saved address details are never edited.
  requireResponse(await readDigikalaInTab(tabId, "select-address", addressId));
  const selected = requireResponse(await readDigikalaInTab(tabId, "default-address"));
  if (opaqueId(selected?.id) !== addressId) throw new DigikalaCheckoutError("shoppingPurchaseAddress");
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

export async function loadDigikalaInvoice(tabId, walletOnly = false) {
  // Digikala serves both its current and previous payment screens.
  for (const kind of ["invoice", "legacy-invoice"]) {
    const result = await readDigikalaInTab(tabId, kind).catch(() => null);
    const invoice = result?.status === 200 && checkoutInvoice(result.data, walletOnly);
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

export async function readDigikalaReceipt(tabId, input, cartId) {
  if (digikalaCheckoutStage(input) !== "receipt") return null;
  const [id, code] = new URL(input).pathname.replace(/\/$/u, "").split("/").slice(-2);
  if (!opaqueId(id) || !opaqueId(code)) return null;
  const data = requireResponse(await readDigikalaInTab(tabId, "receipt", { id, code }));
  const order = data?.order;
  const orderId = opaqueId(order?.id);
  if (data?.status !== "success" || !orderId || opaqueId(order.cart_id) !== cartId
    || (order.remaining_amount != null && order.remaining_amount !== 0)) return null;
  return { orderId };
}
