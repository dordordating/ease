const digiPayOrigin = "https://web.mydigipay.com";
export const shoppingCreditPermission = { origins: [`${digiPayOrigin}/*`] };

export function isDigiPayCreditPage(input) {
  try {
    const url = new URL(input);
    return url.origin === digiPayOrigin && !url.username && !url.password && /^\/credit\/bnpl-pay\/[a-z\d_-]+\/?$/iu.test(url.pathname);
  } catch { return false; }
}

// Runs in the payment document reached by the tracked checkout tab.
export function digipayCreditControl(confirm, expected) {
  if (location.origin !== "https://web.mydigipay.com" || location.href !== expected.url
    || !Number.isSafeInteger(expected.total) || expected.total <= 0
    || (expected.deadline != null && Date.now() >= expected.deadline)) return false;

  const visible = element => element && element.getClientRects().length > 0
    && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    && getComputedStyle(element).visibility === "visible";
  const normalizedText = value => value.normalize("NFKD").replace(/[\s\p{Cf}\p{M}]/gu, "").replace(/ي/gu, "ی").replace(/ك/gu, "ک");
  const normalizedDigits = value => normalizedText(value)
    .replace(/[٠-٩۰-۹]/gu, digit => String(digit.codePointAt(0) & 15));
  const found = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);

  if (found(document, 'dialog[open], [role="dialog"][aria-modal="true"], input[autocomplete="one-time-code"], input[type="password"]').length) return false;
  const flows = found(document, "app-bnpl-pay-root app-bnpl-pay-flow");
  if (flows.length !== 1) return false;
  const [flow] = flows;
  const selected = found(flow, 'app-bnpl-payment-method-card[data-testid^="bnpl-credit-option-"] button.is-selected');
  const method = selected.length === 1 && selected[0].querySelector(".method-title");
  if (!visible(method) || normalizedText(method.textContent) !== normalizedText("اعتبار ماهانه")) return false;

  const footers = found(flow, 'app-credit-payment-footer[data-testid="bnpl-flow-footer"]');
  if (footers.length !== 1) return false;
  const [footer] = footers;
  const amounts = found(footer, '[data-testid="credit-payment-footer-amount"]');
  if (amounts.length !== 1) return false;
  const parts = [...amounts[0].children].filter(visible);
  if (parts.length !== 2 || normalizedText(parts[1].textContent) !== "ریال") return false;
  const digits = normalizedDigits(parts[0].textContent);
  if (!/^(?:\d+|\d{1,3}(?:[,٬]\d{3})+)$/u.test(digits)
    || Number(digits.replace(/[,٬]/gu, "")) !== expected.total) return false;

  const buttons = found(footer, "button.style-fill").filter(button => !button.matches(":disabled")
    && button.getAttribute("aria-disabled") !== "true" && getComputedStyle(button).pointerEvents !== "none"
    && normalizedText(button.textContent) === normalizedText("تأیید و ادامه"));
  if (buttons.length !== 1) return false;
  if (confirm) buttons[0].click();
  return true;
}
