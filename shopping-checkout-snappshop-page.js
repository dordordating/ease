// This function is serialized by Chrome and runs only in the selected SnappShop tab.
export function snappShopCheckoutControl(intent, expected = {}) {
  const { protocol, host, pathname, hash } = location;
  if (protocol !== "https:" || !["snappshop.ir", "www.snappshop.ir"].includes(host)) return null;
  const path = pathname.replace(/\/+$/u, "");
  const productId = /^\/product\/snp-([1-9]\d{0,11})(?:\/|$)/u.exec(path)?.[1];
  if (/^#(?:mobile|otp|login)(?:$|[?&])/u.test(hash)) return { login: true };

  const text = value => (value ?? "").replace(/[\u200b-\u200f\u061c\u2066-\u2069]/gu, " ")
    .replace(/ي/gu, "ی").replace(/ك/gu, "ک").replace(/[٠-٩۰-۹]/gu, digit => String(digit.codePointAt(0) & 15))
    .replace(/\s+/gu, " ").trim();
  const visible = element => Boolean(element?.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
  const controls = (root, selector) => [...(root?.querySelectorAll(selector) ?? [])].filter(visible);
  const textOf = element => text(element?.innerText ?? element?.textContent);
  const click = element => {
    if (!visible(element) || element.disabled || element.getAttribute("aria-disabled") === "true") return false;
    element.click();
    return true;
  };
  const count = element => {
    const value = textOf(element);
    return /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  };
  const amount = value => {
    const normalized = text(value).replace(/[٬,\s]/gu, "").replace(/(?:تومان|تومن)$/u, "");
    if (normalized === "رایگان") return 0;
    if (!/^\d+$/u.test(normalized)) return null;
    const rials = Number(normalized) * 10;
    return Number.isSafeInteger(rials) && rials <= 10_000_000_000_000 ? rials : null;
  };
  const uniqueAmount = amounts => {
    const values = [...new Set(amounts.filter(value => value !== null))];
    return values.length === 1 ? values[0] : null;
  };
  function visiblePrice(section) {
    const currency = controls(section, "span").filter(element => /^(تومان|تومن)$/u.test(textOf(element)));
    const prices = currency.map(element => amount(textOf(element.parentElement)));
    // The cart uses a toman icon instead of a text label next to the current price.
    if (!prices.length && section?.className?.includes("cart-item__cart-price")) {
      return uniqueAmount(controls(section, "span.text-bold").filter(element => !element.closest("del,s")).map(element => amount(textOf(element))));
    }
    return uniqueAmount(prices);
  }

  function rowAmount(labels) {
    const wanted = labels.map(text);
    const candidates = controls(document, "span, p, div, strong, b").filter(element => wanted.includes(textOf(element)));
    return uniqueAmount(candidates.flatMap(element => {
      const label = textOf(element);
      let values = [];
      for (let row = element.parentElement, depth = 0; row && depth < 3; row = row.parentElement, depth++) {
        const children = [...row.children].filter(visible);
        if (!children.some(child => textOf(child) === label || child.contains(element))) continue;
        values = children.map(child => amount(textOf(child))).filter(value => value !== null);
        if (values.length === 1) break;
      }
      return values.length === 1 ? values : [];
    }));
  }

  function cartRows() {
    const cards = controls(document, '[class*="cart-product-card__item"]');
    if (!cards.length) {
      const empty = controls(document, "h1,h2,h3,p,strong").some(element => /^سبد خرید شما خالی است!?$/u.test(textOf(element)));
      return empty ? [] : null;
    }
    const rows = cards.map(card => {
      const info = card.querySelector('[class*="cart-product-card__info"]');
      const link = info?.querySelector('a[href*="/product/snp-"]');
      const url = link && new URL(link.href, location.origin);
      const id = url?.protocol === "https:" && ["snappshop.ir", "www.snappshop.ir"].includes(url.host)
        && /^\/product\/snp-([1-9]\d{0,11})(?:\/|$)/u.exec(url.pathname)?.[1];
      const counter = controls(card, '[class*="add-to-cart-button__count"]')[0];
      const quantity = count(counter);
      const price = visiblePrice(card.querySelector('[class*="cart-item__cart-price"]'));
      if (!id || !quantity || !price) return null;
      const labels = controls(info, "span").map(textOf);
      const matchesOffer = id === expected.productId && labels.includes(text(expected.sellerName))
        && expected.optionValues?.every(value => labels.includes(text(value)))
        && (!expected.warranty || labels.includes(text(expected.warranty))) && price === expected.price;
      return { id, price, quantity, matchesOffer, signature: textOf(info).slice(0, 500), increase: counter.previousElementSibling };
    });
    return rows.every(Boolean) ? rows : null;
  }

  if (intent === "cart" || intent === "increase" || intent === "shipping") {
    if (path !== "/checkout/cart" || hash.toLowerCase().includes("next")) return null;
    const rows = cartRows();
    if (!rows) return null;
    const items = rows.map(({ increase, ...item }) => item);
    if (intent === "cart") return { items };
    if (JSON.stringify(items) !== expected.snapshot) return { changed: true };
    const matches = rows.filter(row => row.matchesOffer);
    if (matches.length !== 1) return { changed: true };
    if (intent === "increase") {
      const plus = matches[0].increase;
      return { clicked: plus?.tagName === "BUTTON" && !plus.className.includes("increase-button--disabled") && click(plus) };
    }
    const proceed = controls(document, "button").filter(button => /^ثبت سفارش(?:\s*\(\d+\))?$/u.test(textOf(button)));
    if (!proceed.length && controls(document, "button").some(button => /^ورود(?: و عضویت)?$/u.test(textOf(button)))) return { login: true };
    return { clicked: proceed.length === 1 && click(proceed[0]) };
  }

  if (intent === "select-option" || intent === "more-sellers" || intent === "offer" || intent === "add") {
    if (expected.productId !== productId) return null;
    if (intent === "select-option") {
      const radio = document.getElementById(expected.option?.id);
      if (radio?.tagName !== "INPUT" || radio.type !== "radio" || radio.name !== expected.option?.group || radio.disabled) return null;
      const label = [...(radio.labels ?? [])].find(visible);
      return { clicked: radio.checked || click(label) || click(radio) };
    }
    if (intent === "more-sellers") {
      const section = document.getElementById("sellers-section");
      const more = controls(section, "button").filter(button => /^(مشاهده|نمایش)\s+(بیشتر|همه(?:[ٔ‌ ]*ی)? فروشندگان|فروشندگان بیشتر)$/u.test(textOf(button)));
      return { clicked: more.length === 1 && click(more[0]) };
    }
    const selected = expected.optionFields.every(option => {
      const input = document.getElementById(option.id);
      return input?.name === option.group && input.checked;
    });
    const sellerCard = document.getElementById(`vendor-item-${expected.offerId}`);
    const buyBoxes = selected && expected.defaultOffer ? controls(document, '[class*="buy-box-available__body"]') : [];
    const boxes = [sellerCard, ...buyBoxes].filter(visible);
    const addLabel = /^(افزودن به سبد(?: خرید)?|خرید از این فروشنده)$/u;
    for (const box of boxes) {
      const sale = visiblePrice(box);
      const seller = controls(box, "a,span,p,strong").some(element => textOf(element) === text(expected.sellerName));
      const discount = expected.discount == null || controls(box, "span").some(element => {
        const badge = /^(?:[%٪]\s*(\d{1,2})|(\d{1,2})\s*[%٪])$/u.exec(textOf(element));
        return badge && Number(badge[1] ?? badge[2]) >= expected.discount;
      });
      const add = controls(box, "button").filter(button => addLabel.test(textOf(button)));
      if (sale === expected.price && seller && discount && add.length === 1 && !add[0].disabled) {
        return intent === "offer" ? { ready: true } : { clicked: click(add[0]) };
      }
    }
    return { clicked: false, changed: boxes.some(box => visiblePrice(box) !== null && visiblePrice(box) !== expected.price) };
  }

  if (intent === "watch-delivery" && path === "/checkout/shipping") {
    const key = "easeSnappShopDeliveryObserver";
    if (globalThis[key] === expected.token) return { listening: true };
    globalThis[key] = expected.token;
    document.addEventListener("click", event => {
      if (globalThis[key] !== expected.token || location.pathname.replace(/\/+$/u, "") !== path) return;
      if (!/^(تایید|تأیید) و ادامه$/u.test(textOf(event.target?.closest?.("button")))) return;
      const shipping = rowAmount(["مجموع هزینه ارسال"]);
      if (shipping !== null) void chrome.runtime.sendMessage({ type: "ease-snapp-delivery-quote", token: expected.token, shipping }).catch(() => {});
    }, true);
    return { listening: true };
  }

  function invoiceAmounts() {
    return { total: rowAmount(["قابل پرداخت"]), subtotal: rowAmount(["مجموع هزینه کالا و خدمات", "مجموع قیمت کالاها و خدمات"]),
      shipping: rowAmount(["مجموع هزینه ارسال و بسته‌بندی", "مجموع هزینه ارسال و بسته بندی"]) };
  }

  if (intent === "watch-payment" && path === "/checkout/payment") {
    const key = "easeSnappShopPaymentObserver";
    if (globalThis[key]?.token === expected.token) return { listening: true };
    globalThis[key]?.observer.disconnect();
    const { total, subtotal, shipping } = expected.invoiceQuote ?? {};
    let last = JSON.stringify({ total, subtotal, shipping });
    let timer;
    const check = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (location.pathname.replace(/\/+$/u, "") !== path || globalThis[key]?.token !== expected.token) return;
        const quote = invoiceAmounts();
        const stamp = JSON.stringify(quote);
        if (quote.total && quote.subtotal && quote.shipping !== null && stamp !== last) {
          last = stamp;
          void chrome.runtime.sendMessage({ type: "ease-snapp-payment-quote", token: expected.token }).catch(() => {});
        }
      }, 500);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    globalThis[key] = { token: expected.token, observer };
    check();
    return { listening: true };
  }

  if (intent === "invoice" && path === "/checkout/payment") {
    const details = invoiceAmounts();
    const { total, shipping } = details;
    if (shipping === null && total !== null && expected.expand) {
      const matches = controls(document, "button,[role=button],a,div,span").filter(element => textOf(element) === "جزئیات بیشتر");
      const labels = matches.filter(element => !matches.some(child => child !== element && element.contains(child)));
      if (labels.length === 1 && click(labels[0].closest("button,[role=button]") ?? labels[0])) return { expanded: true };
    }
    return details;
  }
  return null;
}
