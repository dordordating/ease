import { digikalaId, digikalaPrice, shoppingQuantity } from "./shopping-store.js";
import {
  checkoutAmounts, checkoutCartIssue, checkoutCartsMatch, checkoutItemsKey, defaultShoppingPurchasePolicy,
  isShoppingCreditMode, isShoppingPaymentMode
} from "./shopping-purchase-store.js";
import { DigikalaCheckoutError, digikalaStorefront as storefront, isDigikalaPage, readDigikalaInTab, withDigikalaTab } from "./shopping-digikala-session.js";

export const digikalaCartUrl = storefront + "/checkout/cart/";
export const digikalaShippingUrl = storefront + "/checkout/shipping/";
export const digikalaOrdersUrl = storefront + "/profile/orders/";
export const digikalaAddressesUrl = storefront + "/profile/addresses/";

export function digikalaOrderUrl(value) {
  const id = opaqueId(value);
  return id ? `${digikalaOrdersUrl}${id}/` : digikalaOrdersUrl;
}

const digipayCreditTitles = {
  "credit-one": ["یکقسطه", "1قسطه", "یکقسط", "1قسط", "تکقسطه"],
  "credit-four": ["4قسطه", "چهارقسطه", "4قسط", "چهارقسط"]
};

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

function orderPlacedAt(value, now) {
  const timestamp = integer(value);
  const placed = timestamp !== null ? (timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp)
    : typeof value === "string" && /^\d{4}-\d{2}-\d{2}[T ].*(?:Z|[+-]\d{2}:?\d{2})$/iu.test(value) ? Date.parse(value) : NaN;
  return placed >= Date.UTC(2000, 0, 1) && placed <= now ? placed : null;
}

export async function checkDigikalaOrderStatuses(orders) {
  const checkedAt = Date.now();
  const updates = new Map(orders.map(({ id, accountId }) => [id, { accountId, checkedAt }]));
  if (!orders.length) return updates;
  await withDigikalaTab(async tabId => {
    const account = await readDigikalaAccount(tabId);
    const eligible = orders.filter(order => !order.accountId || order.accountId === account);
    for (let offset = 0; offset < eligible.length; offset += 4) {
      await Promise.all(eligible.slice(offset, offset + 4).map(async ({ id }) => {
        if (!opaqueId(id)) return;
        const result = await readDigikalaInTab(tabId, "order-status", id).catch(() => null);
        if (result?.status !== 200 || !result.data) return;
        const { progress, state } = result.data;
        if (!Array.isArray(progress)) return;
        const shipments = progress.filter(step => step?.title);
        const placedAt = orderPlacedAt(result.data.placedAt, checkedAt);
        const terminal = ["cancelled", "canceled", "delivered", "returned", "completed"].includes(state);
        if (!shipments.length && !terminal && !placedAt) return;
        updates.get(id).tracking = { shipments, state, placedAt, checkedAt,
          finished: terminal || (progress.length > 0 && progress.every(step => step?.finished)) };
      }));
    }
  }).catch(() => {});
  return updates;
}

async function buyerForAddress(accountId, address) {
  const addressId = opaqueId(address?.id);
  if (!addressId || typeof address.address !== "string" || !address.address.trim() || address.isUsable === false
    || address.isAccurate === false || address.dropOffAddressId || address.sharedAddressId) return null;
  // Preserve the address fingerprint used by saved wallet authorizations.
  const fields = [addressId, address.type, address.address, address.recipientName, address.recipientMobilePhone,
    address.postCode, address.buildingNumber, address.unit, address.latitude, address.longitude];
  const sha = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(fields)));
  return { accountId, addressId, addressKey: Array.from(new Uint8Array(sha), byte => byte.toString(16).padStart(2, "0")).join("") };
}

function normalizeCheckoutText(value) {
  return (typeof value === "string" || Number.isSafeInteger(value) ? String(value) : "").normalize("NFKC").toLowerCase()
    .replace(/[\s\p{Cf}\p{M}\p{P}]/gu, "").replace(/ي/gu, "ی").replace(/ك/gu, "ک")
    .replace(/[٠-٩۰-۹]/gu, digit => String(digit.codePointAt(0) & 15));
}

function deliveryAddress(address, explicitId, pickup = false) {
  const rawId = explicitId ?? address?.id ?? address?.address_id;
  const id = opaqueId(rawId);
  const street = normalizeCheckoutText(typeof address === "string" ? address : address?.address);
  const city = normalizeCheckoutText(address?.city_name ?? address?.city?.name ?? address?.city);
  const province = normalizeCheckoutText(address?.state_name ?? address?.state?.name ?? address?.state);
  const postal = normalizeCheckoutText(address?.postal_code ?? address?.postCode ?? address?.postalCode);
  return {
    id, invalidId: rawId != null && !id, street, city, province, postal,
    pickup: pickup || Boolean(address?.drop_off_address_id ?? address?.dropOffAddressId ?? address?.sharedAddressId),
    building: normalizeCheckoutText(address?.building_number ?? address?.buildingNumber), unit: normalizeCheckoutText(address?.unit),
    labels: street ? [...new Set([street, city + street, province + city + street])] : []
  };
}

function conflictingDetails(expected, address) {
  return (expected.street && address.street && !sameStreet(expected, address)) || ["postal", "city", "province", "building", "unit"].some(field =>
    expected[field] && address[field] && expected[field] !== address[field]);
}

function sameStreet(expected, address) {
  return expected.labels.includes(address.street) || address.labels.includes(expected.street);
}

function sameDestination(expected, address) {
  return /^\d{10}$/u.test(expected.postal) && expected.postal === address.postal && sameStreet(expected, address)
    && !conflictingDetails(expected, address);
}

export function invoiceAddressIssue(invoice, buyer) {
  const expected = buyer.delivery;
  let missing = !invoice.destinations.length;
  for (const address of invoice.destinations) {
    if (address.pickup || address.invalidId || conflictingDetails(expected, address)) return "shoppingPurchaseAddressMismatch";
    if (address.id === buyer.addressId || sameDestination(expected, address)) continue;
    if (address.id) return "shoppingPurchaseAddressMismatch";
    missing = true;
  }
  return missing ? "shoppingPurchaseAddressUnverified" : null;
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

export async function readDigikalaBuyer(tabId, addressId, { details = false } = {}) {
  const accountId = await readDigikalaAccount(tabId);
  const { rows, defaultId } = await savedDigikalaAddresses(tabId, addressId);
  const address = rows.find(address => opaqueId(address?.id) === (addressId ?? defaultId));
  const buyer = await buyerForAddress(accountId, address);
  if (!buyer) throw new DigikalaCheckoutError("shoppingPurchaseAddress");
  return details ? { ...buyer, delivery: deliveryAddress(address) } : buyer;
}

function activeDeliveryMatches(value, addressId, delivery) {
  const address = deliveryAddress(value);
  return !address.pickup && (address.id === addressId && (!delivery || !conflictingDetails(delivery, address))
    || Boolean(delivery && sameDestination(delivery, address)));
}

export async function verifyDigikalaDeliveryAddress(tabId, buyer) {
  const current = requireResponse(await readDigikalaInTab(tabId, "default-address"), true);
  if (!current) throw new DigikalaCheckoutError("shoppingPurchaseAddressUnverified");
  if (!activeDeliveryMatches(current, buyer.addressId, buyer.delivery)) throw new DigikalaCheckoutError("shoppingPurchaseAddressMismatch");
}

export async function selectDigikalaDeliveryAddress(tabId, addressId, authorize, delivery) {
  const current = requireResponse(await readDigikalaInTab(tabId, "default-address"), true);
  if (activeDeliveryMatches(current, addressId, delivery)) return;
  if (!await authorize()) throw new DigikalaCheckoutError("shoppingConditionsChanged");
  // This is the selection used by Digikala's shipping screen. Saved address details are never edited.
  requireResponse(await readDigikalaInTab(tabId, "select-address", addressId));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const selected = requireResponse(await readDigikalaInTab(tabId, "default-address"), true);
    if (activeDeliveryMatches(selected, addressId, delivery)) return;
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new DigikalaCheckoutError("shoppingPurchaseAddressMismatch");
}

function invoicePayment(data, mode) {
  if (!isShoppingPaymentMode(mode)) return null;
  const credit = isShoppingCreditMode(mode);
  const modern = Array.isArray(data.payment_types);
  const groupName = credit ? "اعتباریدیجیپی" : "";
  const titles = credit ? digipayCreditTitles[mode] : ["کیفپولدیجیپی"];
  const sources = (modern ? data.payment_types : []).filter(group => !groupName || normalizeCheckoutText(group?.title) === groupName)
    .flatMap(group => Array.isArray(group?.sources) ? group.sources : [])
    .filter(source => titles.includes(normalizeCheckoutText(source?.title)));
  const source = sources.length === 1 ? sources[0] : null;
  if ((modern || credit) && !source) return null;
  const walletData = data.balance_data?.wallet;
  const balance = credit ? null : amount(source?.balance ?? (walletData?.activation_url ? null : walletData?.credit));
  return {
    mode, title: source?.title ?? "کیف پول دیجی‌پی", group: groupName, balance,
    selectable: modern ? source.is_clickable === true && !source.info : balance !== null,
    identity: source ? [source.method_id ?? null, source.source_id ?? null, source.price_type ?? null] : null,
    button: typeof source?.purchase_button_text === "string" ? source.purchase_button_text.trim() : ""
  };
}

function invoiceAmounts(raw, shipments) {
  const shipping = raw?.shipping_cost === "رایگان" ? 0 : amount(raw?.shipping_cost);
  const deliveryKnown = shipping !== null && !(typeof raw?.shipping_cost_hint === "string" && /پس\s*[‌-]?\s*کرایه/u.test(raw.shipping_cost_hint))
    && !shipments.some(part => part?.is_cash_on_delivery);
  return { total: amount(raw?.payable_price), shipping: deliveryKnown ? shipping : null };
}

export function checkoutInvoice(data, mode) {
  if (!data || data.order?.id) return null;
  const payment = invoicePayment(data, mode);
  const cartId = opaqueId(data.cart?.id ?? data.cart?.cart_id);
  const summaryId = opaqueId(data.cart_data?.id ?? data.cart_data?.cart_id);
  if (cartId && summaryId && cartId !== summaryId) return null;
  const base = data.cart_data && data.cart ? { ...data.cart, ...data.cart_data } : data.cart_data ?? data.cart;
  const methodType = payment?.identity?.[2];
  const methodPrice = methodType != null
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
  const orderAddress = data.address ?? raw.address;
  const orderAddressId = orderAddress?.id ?? data.address_id ?? raw.address_id;
  const destinations = shipments.length ? shipments.map(part => {
    const address = part?.address ?? orderAddress;
    const id = part?.address?.id ?? part?.address_id ?? (!part?.address ? orderAddressId : undefined);
    return deliveryAddress(address, id, part?.is_drop_off);
  }) : orderAddress || orderAddressId != null ? [deliveryAddress(orderAddress, orderAddressId)] : [];
  if (shipments.length && (orderAddress || orderAddressId != null)) destinations.push(deliveryAddress(orderAddress, orderAddressId));
  return { cart, ...invoiceAmounts(raw, shipments), payment, destinations,
    orderCost: isShoppingCreditMode(mode) ? invoiceAmounts(base, shipments) : null };
}

export async function loadDigikalaInvoice(tabId, mode) {
  const results = [];
  for (const kind of ["invoice", "legacy-invoice", "legacy-plus-invoice"]) {
    const result = await readDigikalaInTab(tabId, kind).catch(() => null);
    results.push(result?.status);
    const invoice = result?.status === 200 && checkoutInvoice(result.data, mode);
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
  const mode = isShoppingPaymentMode(input.method) ? input.method : undefined;
  const invoice = await loadDigikalaInvoice(tab.id, mode).catch(() => null);
  if (!invoice || !invoice.destinations.length || (isShoppingCreditMode(mode) && !invoice.payment?.selectable)
    || checkoutCartIssue(invoice.cart, watch, offer, defaultShoppingPurchasePolicy)) return null;
  const amounts = checkoutAmounts(invoice);
  if (!amounts) return null;
  const [buyer, cart] = await Promise.all([readDigikalaBuyer(tab.id, addressId, { details: true }), loadDigikalaCart(tab.id)]);
  if (buyer.accountId !== input.address.accountId || buyer.addressKey !== input.address.key
    || invoiceAddressIssue(invoice, buyer) || checkoutCartIssue(cart, watch, offer, defaultShoppingPurchasePolicy)
    || !checkoutCartsMatch(cart, invoice.cart)) return null;
  return amounts;
}

export function checkoutInvoiceKey(invoice) {
  const { title, group, identity, button } = invoice.payment ?? {};
  return JSON.stringify([invoice.cart.id, checkoutItemsKey(invoice.cart), invoice.total, invoice.shipping,
    invoice.destinations, invoice.orderCost, title, group, identity, button]);
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
    || (order.remaining_amount != null && integer(order.remaining_amount) !== 0)) return null;
  return { orderId };
}
