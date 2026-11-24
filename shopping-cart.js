import { digikalaProductLink, digikalaProductUrl } from "./shopping-store.js";

export function waitForShopTab(tabId, matches) {
  return new Promise(resolve => {
    const finish = value => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      resolve(value);
    };
    const check = tab => {
      if (tab?.status === "complete" && !tab.pendingUrl) finish(matches(tab.url));
    };
    const updated = (id, changes, tab) => { if (id === tabId && changes.status === "complete") check(tab); };
    const removed = id => { if (id === tabId) finish(false); };
    const timeout = setTimeout(() => finish(false), 12_000);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.get(tabId).then(check, () => finish(false));
  });
}

// Runs in the shop page's isolated world. Use only the buy box's native add control.
export async function clickDigikalaAdd({ productId, variantId, price, deadline }) {
  const path = `/product/dkp-${productId}`;
  const stopAt = Math.min(deadline ?? Infinity, Date.now() + 7000);
  const selector = `button[data-testid="add-to-cart"][data-add-to-cart-variant-id="${variantId}"]`;
  while (Date.now() < stopAt) {
    if (location.origin !== "https://www.digikala.com"
      || (location.pathname !== path && !location.pathname.startsWith(`${path}/`))) return false;
    const buttons = [...document.querySelectorAll(selector)].filter(button =>
      button.getClientRects().length > 0 && !button.disabled && button.getAttribute("aria-disabled") !== "true");
    for (const button of buttons) {
      const box = button.closest('[data-testid="buy-box"]');
      const final = box?.querySelector('[data-testid="price-final"]');
      const digits = final?.textContent.replace(/[٠-٩۰-۹]/gu, digit => String(digit.codePointAt(0) & 15))
        .replace(/تومان/gu, "").replace(/[\s,٬‎‏]/gu, "");
      if (digits && /^\d+$/u.test(digits) && Number(digits) * 10 === price) {
        button.click();
        return true;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  return false;
}

export async function addDigikalaTabItem(tab, watch, quote, authorize) {
  if (!quote.singleItem || !quote.variantId || !Number.isInteger(tab.id) || !chrome.tabs.onUpdated?.removeListener) return false;
  if (!await waitForShopTab(tab.id, url => digikalaProductLink(url)?.productId === watch.productId) || !await authorize()) return false;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: clickDigikalaAdd,
      args: [{ productId: watch.productId, variantId: quote.variantId, price: quote.price, deadline: watch.endAt }]
    });
    return result?.result === true;
  } catch {
    return false;
  }
}

export async function prepareDigikalaCart(watch, quote, authorize) {
  const tab = await chrome.tabs.create({ url: digikalaProductUrl(watch.productId, quote.variantId) });
  return addDigikalaTabItem(tab, watch, quote, authorize);
}
