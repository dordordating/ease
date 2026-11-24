import { digikalaId, digikalaPrice, shoppingQuantity } from "./shopping-store.js";
import { checkoutAmounts, checkoutCartIssue, checkoutCartsMatch, checkoutItemsKey, defaultShoppingPurchasePolicy } from "./shopping-purchase-store.js";
import { DigikalaCheckoutError, digikalaStorefront as storefront, isDigikalaPage, readDigikalaInTab } from "./shopping-digikala-session.js";

export const digikalaCartUrl = storefront + "/checkout/cart/";
export const digikalaShippingUrl = storefront + "/checkout/shipping/";
export const digikalaOrdersUrl = storefront + "/profile/orders/";
export const digikalaAddressesUrl = storefront + "/profile/addresses/";

function opaqueId(value) {
  const id = Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === "string" && /^[a-z\d][a-z\d_-]{0,79}$/iu.test(id) ? id : null;
}

function integer(value) {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function amount(value) {
  const number = integer(value);
  return number === 0 ? 0 : digikalaPrice(number);
}

function applied(value) {
  return integer(value) !== 0 && Boolean(value) && (typeof value !== "object" || Object.keys(value).length > 0);
}

function isDigiPayWallet(label) {
  return typeof label === "string" && label.replace(/[\s\p{Cf}\p{M}]/gu, "").replace(/ي/gu, "ی").replace(/ك/gu, "ک") === "کیفپولدیجیپی";
}

// Only the cart identities, quantities and rials needed by the purchase rule leave this adapter.
export function readCheckoutCart(data, raw = data?.cart_data ?? data?.cart, rawItems = data?.cart_items, { invoice = false } = {}) {
  if (!raw) return null;
  const totalQuantity = integer(raw.total_quantity);
  if (totalQuantity === null && (!invoice || raw.total_quantity != null)) return null;
  const packages = data?.packages;
  if (rawItems === undefined && Array.isArray(packages) && packages.every(part => Array.isArray(part.cart_items))) {
    rawItems = packages.flatMap(part => part.cart_items);
  }
  if (!Array.isArray(rawItems)) {
    if (totalQuantity !== 0) return null;
    rawItems = [];
  }
  const items = rawItems.map(row => {
    const id = opaqueId(row?.id);
    const unit = digikalaPrice(integer(row?.variant?.price?.selling_price));
    const line = digikalaPrice(integer(row?.price?.selling_price));
    const quantity = integer(row?.quantity);
    const price = unit && line === unit * quantity ? unit : line ?? unit;
    return {
      ...(id ? { id } : {}),
      variantId: digikalaId(row?.variant_id ?? row?.variant?.id),
      productId: digikalaId(row?.product?.id),
      sellerId: digikalaId(row?.variant?.seller?.id),
      quantity,
      price
    };
  });
  const references = new Set(rawItems.map(item => opaqueId(item?.cart_id)).filter(Boolean));
  const id = opaqueId(raw.id ?? raw.cart_id) ?? (invoice && references.size === 1 ? [...references][0] : null);
  if ((items.length && !id) || (invoice && references.size && (references.size !== 1 || !references.has(id)))
    || items.some(row => !row.variantId || !row.quantity)
    || (totalQuantity !== null && items.reduce((sum, row) => sum + row.quantity, 0) !== totalQuantity)) return null;
  const extraServices = Boolean(applied(raw.temporary_plus_subscription?.payable_price) || applied(raw.gift_card_amount)
    || applied(raw.delivery_package_box?.selected_package) || applied(raw.insurance?.amount)
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
  if (!data || data.order?.id) return null;
  const modern = Array.isArray(data.payment_types);
  const sources = modern ? data.payment_types.flatMap(group => Array.isArray(group?.sources) ? group.sources : [])
    .filter(source => isDigiPayWallet(source?.title)) : [];
  const wallet = sources.length === 1 ? sources[0] : null;
  const walletData = data.balance_data?.wallet;
  const walletBalance = modern ? amount(wallet?.balance ?? (wallet && !walletData?.activation_url ? walletData?.credit : null))
    : walletData?.activation_url ? null : amount(walletData?.credit);
  const cartId = opaqueId(data.cart?.id ?? data.cart?.cart_id);
  const summaryId = opaqueId(data.cart_data?.id ?? data.cart_data?.cart_id);
  if (cartId && summaryId && cartId !== summaryId) return null;
  const base = data.cart_data && data.cart ? { ...data.cart, ...data.cart_data } : data.cart_data ?? data.cart;
  const methodType = wallet?.price_type;
  const methodPrice = walletOnly && methodType != null
    ? data.price_types_cart_data?.[methodType] ?? data.price_type_cart?.[methodType] : null;
  const baseId = opaqueId(base?.id ?? base?.cart_id);
  const methodId = opaqueId(methodPrice?.id ?? methodPrice?.cart_id);
  if (!base && !methodPrice || (baseId && methodId && baseId !== methodId)) return null;
  const raw = methodPrice ? { ...base, ...methodPrice } : base;
  const shipments = Array.isArray(data.cart_shipments) ? data.cart_shipments : [];
  const shipmentItems = shipments.length && shipments.every(part => Array.isArray(part?.cart_items))
    ? shipments.flatMap(part => part.cart_items) : null;
  const rows = [methodPrice?.items, data.cart_items, raw.items, shipmentItems];
  const rawItems = rows.find(items => Array.isArray(items) && items.length) ?? rows.find(Array.isArray);
  const cart = readCheckoutCart(data, raw, rawItems, { invoice: true });
  if (!cart?.id || !cart.items.length) return null;
  const shipping = raw.shipping_cost === "رایگان" ? 0 : amount(raw.shipping_cost);
  const addressId = opaqueId(data.address?.id ?? raw.address?.id ?? data.address_id);
  const addressIds = shipments.length ? shipments.map(part => {
    const id = part?.address?.id ?? part?.address_id;
    return part?.is_drop_off ? null : id == null ? addressId : opaqueId(id);
  })
    : addressId ? [addressId] : [];
  const deliveryKnown = shipping !== null && !(typeof raw.shipping_cost_hint === "string" && /پس\s*[‌-]?\s*کرایه/u.test(raw.shipping_cost_hint))
    && !shipments.some(part => part?.is_cash_on_delivery);
  return { cart, total: amount(raw.payable_price), shipping: deliveryKnown ? shipping : null, walletBalance,
    walletSelectable: modern ? wallet?.is_clickable === true && !wallet.info : walletBalance !== null,
    walletMethod: wallet ? [wallet.method_id ?? null, wallet.source_id ?? null, methodType ?? null] : null,
    walletButton: typeof wallet?.purchase_button_text === "string" ? wallet.purchase_button_text.trim() : "",
    addressIds };
}

export async function loadDigikalaInvoice(tabId, walletOnly = false) {
  const results = [];
  for (const kind of ["invoice", "legacy-invoice", "legacy-plus-invoice"]) {
    const result = await readDigikalaInTab(tabId, kind).catch(() => null);
    results.push(result?.status);
    const invoice = result?.status === 200 && checkoutInvoice(result.data, walletOnly);
    if (invoice) return invoice;
  }
  const error = results.includes(200) ? "shoppingPurchaseInvoice"
    : results.includes(401) ? "shoppingPurchaseSignIn" : "shoppingPurchaseConnection";
  throw new DigikalaCheckoutError(error);
}

export async function previewDigikalaInvoice(input) {
  const productId = digikalaId(input?.productId);
  const variantId = digikalaId(input?.variantId);
  const sellerId = digikalaId(input?.sellerId);
  const price = digikalaPrice(input?.price);
  const quantity = shoppingQuantity(input?.quantity);
  const addressId = opaqueId(input?.address?.id);
  if (!productId || !variantId || !sellerId || !price || !quantity || !addressId) return null;
  const tabs = (await chrome.tabs.query({ url: `${storefront}/*` })).filter(tab =>
    Number.isInteger(tab.id) && !tab.incognito && tab.status === "complete" && !tab.pendingUrl && isDigikalaPage(tab.url));
  const tab = tabs.find(tab => digikalaCheckoutStage(tab.url) === "payment") ?? tabs.find(tab => tab.active) ?? tabs[0];
  if (!tab) return null;

  // A preview only reads the shopper's current checkout when the invoice already matches the draft.
  const watch = { productId, quantity };
  const offer = { variantId, sellerId, price };
  const invoice = await loadDigikalaInvoice(tab.id, input.wallet === true).catch(() => null);
  if (!invoice || !invoice.addressIds.length || !invoice.addressIds.every(id => id === addressId)
    || checkoutCartIssue(invoice.cart, watch, offer, defaultShoppingPurchasePolicy)) return null;
  const amounts = checkoutAmounts(invoice);
  if (!amounts) return null;
  const [buyer, cart] = await Promise.all([readDigikalaBuyer(tab.id, addressId), loadDigikalaCart(tab.id)]);
  if (buyer.accountId !== input.address.accountId || buyer.addressKey !== input.address.key
    || checkoutCartIssue(cart, watch, offer, defaultShoppingPurchasePolicy) || !checkoutCartsMatch(cart, invoice.cart)) return null;
  return amounts;
}

export function checkoutInvoiceKey(invoice) {
  return JSON.stringify([invoice.cart.id, checkoutItemsKey(invoice.cart), invoice.total, invoice.shipping,
    invoice.addressIds, invoice.walletMethod, invoice.walletButton]);
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
