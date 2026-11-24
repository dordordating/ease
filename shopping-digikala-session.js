import { waitForShopTab } from "./shopping-cart.js";

export const digikalaStorefront = "https://www.digikala.com";

export class DigikalaCheckoutError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function isDigikalaPage(url) {
  try { return new URL(url).origin === digikalaStorefront; }
  catch { return false; }
}

// Chrome runs this function inside a Digikala tab so that the store receives its own session cookies.
export async function readDigikalaFromPage(kind, option) {
  if (location.origin !== "https://www.digikala.com") return null;
  const api = "https://api.digikala.com";
  const gateway = { "x-site": "DIGIKALA", "x-source": "WEB" };
  const addressHeaders = { ...gateway, "X-Client": "web", "Accept-Language": "fa" };
  const addresses = "/address/v2/addresses";
  const validId = value => typeof value === "string" && /^[a-z\d][a-z\d_-]{0,79}$/iu.test(value);
  const apiId = value => Number.isSafeInteger(Number(value)) && String(Number(value)) === value ? Number(value) : value;

  async function request(path, headers = {}, method = "GET", data) {
    const settings = { method, credentials: "include", cache: "no-store", redirect: "manual",
      headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(7000) };
    if (data !== undefined) {
      settings.headers["Content-Type"] = "application/json";
      settings.body = JSON.stringify(data);
    }
    let response = await fetch(api + path, settings);
    const redirected = () => response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
    if (method === "GET" && redirected()) response = await fetch(api + path, settings);
    if (redirected()) return { status: 0, data: null };
    const payload = await response.json().catch(() => null);
    const status = response.ok && Number.isInteger(payload?.status) && payload.status >= 100 && payload.status <= 599
      ? payload.status : response.status;
    return { status, data: payload?.data ?? payload };
  }

  if (kind === "profile") {
    const path = "/account/v1/user/profile/info/";
    let profile = await request(path);
    const noSession = result => result.status === 401 || (result.status === 200 && !result.data?.id);
    if (noSession(profile)) {
      const refresh = async () => {
        const current = await request(path);
        if (!noSession(current)) return current;
        const renewed = await request("/v1/user/token/", {}, "POST");
        return renewed.status >= 200 && renewed.status < 300 ? request(path)
          : { status: renewed.status === 401 ? 401 : renewed.status, data: null };
      };
      profile = navigator.locks
        ? await navigator.locks.request("dk-session-refresh", { signal: AbortSignal.timeout(9000) }, refresh)
        : await refresh();
    }
    // Keep contact and identity details in the merchant tab.
    return { status: profile.status, data: { id: profile.data?.id } };
  }
  if (kind === "addresses" && Number.isSafeInteger(option) && option > 0) {
    return request(`${addresses}?page=${option}&size=20`, addressHeaders);
  }
  if (kind === "default-address") return request(addresses + "/default", addressHeaders);
  if (kind === "select-address" && validId(option)) {
    return request(addresses + "/default", addressHeaders, "POST", { addressId: apiId(option) });
  }
  if (kind === "cart") return request("/checkout/v1/carts", gateway);
  if (kind === "cart-quantity" && validId(option?.id) && Number.isSafeInteger(option.quantity) && option.quantity > 0) {
    return request("/checkout/v1/carts/items", gateway, "PATCH", { cartItemId: apiId(option.id), quantity: option.quantity });
  }
  if (kind === "invoice") return request("/checkout/v1/payments", gateway);
  if (kind === "legacy-invoice") return request("/v3/payment/", gateway);
  if (kind === "legacy-plus-invoice") return request("/v2/payment/", gateway);
  if (kind === "receipt" && validId(option?.id) && validId(option?.code)) {
    return request(`/v1/thank-you/payment/${option.id}/${option.code}/`);
  }
  if (kind === "order-status" && validId(option)) {
    const { status, data } = await request(`/v1/order/${option}/`);
    const order = data?.order;
    if (String(order?.id) !== option) return { status, data: null };
    const text = value => typeof value === "string" ? value.trim().slice(0, 120) : "";
    const shipments = Array.isArray(order.shipments) ? order.shipments : [];
    const progress = shipments.map(shipment => {
      const steps = Array.isArray(shipment?.status) ? shipment.status : [];
      const index = steps.findIndex(step => step?.is_current === true || step?.is_current === 1);
      if (index < 0) return null;
      return { title: text(steps[index]?.title), next: text(steps[index + 1]?.title),
        finished: index === steps.length - 1 && Number(steps[index]?.percentage) === 100 };
    });
    // The order API also contains contact, address and transaction details. Keep those in the merchant tab.
    const state = typeof order.status === "string" && /^[a-z_-]+$/iu.test(order.status) ? order.status.toLowerCase() : "";
    const placedAt = typeof order.created_at === "string" || Number.isSafeInteger(order.created_at) ? order.created_at : null;
    return { status, data: { progress, state, placedAt } };
  }
  return null;
}

export async function readDigikalaInTab(tabId, kind, option = null) {
  const answers = await chrome.scripting.executeScript({
    target: { tabId }, func: readDigikalaFromPage, args: [kind, option]
  }).catch(() => []);
  const result = answers[0]?.result;
  if (!result || !result.status) throw new DigikalaCheckoutError("shoppingPurchaseConnection");
  return result;
}

export async function withDigikalaTab(work) {
  const existing = await chrome.tabs.query({ url: `${digikalaStorefront}/*` });
  const ready = existing.find(tab => Number.isInteger(tab.id) && tab.status === "complete" && !tab.pendingUrl
    && !tab.incognito && isDigikalaPage(tab.url));
  if (ready) return work(ready.id);

  const url = digikalaStorefront + "/";
  const { id, incognito } = await chrome.tabs.create({ url, active: false });
  try {
    if (!Number.isInteger(id) || incognito || !await waitForShopTab(id, isDigikalaPage)) {
      throw new DigikalaCheckoutError("shoppingPurchaseConnection");
    }
    return await work(id);
  } finally {
    const tab = Number.isInteger(id) ? await chrome.tabs.get(id).catch(() => null) : null;
    if (tab && !tab.active && tab.url === url) await chrome.tabs.remove(id).catch(() => {});
  }
}
