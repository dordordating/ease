// Runs in Digikala's own tab. Only use controls identified by the storefront.
export function digikalaCheckoutControl(intent, expected = {}) {
  if (location.origin !== "https://www.digikala.com") return null;
  const path = location.pathname.replace(/\/$/u, "");
  const visible = el => el && el.getClientRects().length > 0 && !el.closest('[hidden], [inert], [aria-hidden="true"]')
    && getComputedStyle(el).visibility !== "hidden";
  const usable = el => visible(el) && !el.disabled && !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true";
  const control = name => [...document.querySelectorAll(`button[data-cro-id="${name}"], dds-button[data-cro-id="${name}"]`)].find(usable);
  const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')].filter(visible);
  const normalize = value => (value ?? "").replace(/[\s\p{Cf}\p{M}]/gu, "").replace(/ي/gu, "ی").replace(/ك/gu, "ک");
  const canonical = value => normalize((value ?? "").normalize("NFKC").toLowerCase()).replace(/\p{P}/gu, "")
    .replace(/[٠-٩۰-۹]/gu, digit => String(digit.codePointAt(0) & 15));

  if (intent.startsWith("shipping")) {
    if (path !== "/checkout/shipping") return null;
    const next = control("shipping-continue");
    if (next && !dialogs.length) {
      let result = "continue";
      if (expected.addressLabels?.length) {
        const heading = canonical("ارسال به آدرس انتخاب شده");
        const addresses = [...document.querySelectorAll("div")].filter(label => !label.children.length && visible(label)
          && canonical(label.textContent) === heading)
          .map(label => label.parentElement.nextElementSibling).filter(visible)
          .map(address => canonical(address.textContent)).filter(Boolean);
        if (addresses.includes(canonical("آدرس تحویل را انتخاب کنید"))) return "waiting";
        if (addresses.some(address => !expected.addressLabels.includes(address))) return "address-mismatch";
        if (addresses.length) result = "address-verified";
      }
      if (intent === "shipping-continue") next.click();
      return result;
    }
    if (dialogs.length > 1 || (dialogs.length && !normalize(dialogs[0].textContent).includes("انتخاببازهزمانی"))) return "review";
    const scope = dialogs.length === 1 ? dialogs[0] : document;
    const rows = [...scope.querySelectorAll('[data-test-id^="day-"][data-test-id*="-time-slot-hour-"], label[for^="jet-time-slot-"]')];
    const slots = rows.filter(row => visible(row) && !row.matches('[class*="bgPlus"]'))
      .map(row => ({ row, input: row.querySelector('input[type="radio"]') ?? row.control }));
    const available = slots.find(({ input }) => input?.name && !input.disabled && !input.checked
      && !expected.skip?.includes(input.name) && !slots.some(slot => slot.input?.name === input.name && slot.input.checked));
    if (available) {
      const key = available.input.name;
      if (intent === "shipping-select" && key === expected.key) available.row.click();
      return `select:${key}`;
    }
    const picker = !dialogs.length && (control("shipping-choose-timeslot") || control("shipping-select-time"));
    if (picker) {
      if (intent === "shipping-open-time") picker.click();
      return "choose";
    }
    return dialogs.length ? "review" : "waiting";
  }

  if (path !== "/checkout/payment" || dialogs.length) return null;
  const payment = expected.payment;
  const wallet = payment?.mode === "wallet";
  const credit = payment?.mode === "credit-one" || payment?.mode === "credit-four";
  if (!payment?.title || (!wallet && !credit)) return null;
  if (credit && intent === "pay" && expected.creditApproved !== true) return null;
  const title = canonical(payment.title);
  if (wallet && title !== "کیفپولدیجیپی") return null;
  if (credit && payment.group !== "اعتباریدیجیپی") return null;
  const modernRows = [...document.querySelectorAll("dds-selectable-row[aria-label]")].filter(visible);
  const options = modernRows.filter(row => usable(row) && canonical(row.getAttribute("aria-label")) === title
    && (!credit || canonical(row.closest("section")?.querySelector(':scope > dds-title-row [slot="title"]')?.textContent) === payment.group));
  if (wallet) {
    for (const row of document.querySelectorAll('label[data-cro-id="payment-pay-by-wallet"]')) {
      if (usable(row) && [...row.querySelectorAll("p")].some(label => canonical(label.textContent) === title)) options.push(row);
    }
  }
  if (options.length !== 1) return null;
  const [option] = options;
  const modern = option.matches("dds-selectable-row");
  const radio = option.querySelector('input[type="radio"]');
  if (!modern && (!radio || radio.disabled)) return null;
  const rowSelected = row => row.selected === true || (row.hasAttribute("selected") && row.getAttribute("selected") !== "false")
    || row.getAttribute("aria-pressed") === "true" || row.getAttribute("aria-selected") === "true";
  // The modern card contains a read-only radio. Its native handler runs on the card itself.
  const selected = modern ? rowSelected(option) && !modernRows.some(row => row !== option && rowSelected(row)) : radio.checked;
  if (intent === "select-payment") {
    if (!selected) (modern ? option : radio).click();
    return { selected };
  }
  if (intent === "payment-selected") return selected ? { selected } : null;
  const pay = control("payment-final-pay");
  if (!selected || !pay) return null;
  const button = canonical(pay.textContent);
  if (payment.button && button !== canonical(payment.button)) return null;
  if (credit && intent === "pay" && !payment.button && button !== `پرداخت${title}`) return null;

  function parseToman(value) {
    const digits = normalize(value).replace(/[٠-٩۰-۹]/gu, digit => String(digit.codePointAt(0) & 15))
      .replace(/[,٬]/gu, "").replace(/^تومان|تومان$/u, "");
    return /^\d+$/u.test(digits) ? Number(digits) * 10 : null;
  }
  const totals = new Set();
  for (const label of document.querySelectorAll("span, p, dds-text")) {
    if (normalize(label.textContent) !== "مبلغقابلپرداخت" || !visible(label)) continue;
    let title = label;
    for (let level = 0; level < 3 && title.parentElement; level += 1) {
      const amount = title.nextElementSibling;
      if (visible(amount)) {
        const priceNodes = "span, dds-price, dds-text";
        const discounted = "del, s, .line-through";
        const values = [amount, ...amount.querySelectorAll(priceNodes)]
          .filter(element => visible(element) && !element.closest(discounted)
            && !element.querySelector(`${priceNodes}, ${discounted}`))
          .map(element => parseToman(element.textContent)).filter(value => value !== null);
        if (values.length) {
          for (const value of values) totals.add(value);
          break;
        }
      }
      title = title.parentElement;
    }
  }
  if (totals.size !== 1 || !totals.has(expected.total)) return null;
  if (expected.deadline == null || Date.now() < expected.deadline) {
    if (intent === "pay") pay.click();
    return { selected, total: expected.total };
  }
  return null;
}
