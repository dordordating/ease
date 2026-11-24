import { digikalaAddressesUrl, digikalaOrdersUrl } from "./shopping-checkout-digikala.js";
import { isShoppingCreditMode, isShoppingPaymentMode } from "./shopping-purchase-store.js";
import { digikalaPrice } from "./shopping-store.js";

const modes = {
  notify: "shoppingPurchaseNotifyMode", prepare: "shoppingPurchasePrepareMode", wallet: "shoppingPurchaseWalletMode",
  "credit-one": "shoppingPurchaseCreditOne", "credit-four": "shoppingPurchaseCreditFour"
};
const carts = { review: "shoppingPurchaseCartReview", include: "shoppingPurchaseCartInclude" };
const deliveries = { include: "shoppingPurchaseDeliveryInclude", separate: "shoppingPurchaseDeliverySeparate", max: "shoppingPurchaseDeliveryMax" };

function choices(node, t, legend, name, labels, value, changed = () => {}) {
  const group = node("fieldset", "shopping-purchase-choices");
  const title = node("legend", "", t(legend));
  group.append(title);
  for (const [id, label] of Object.entries(labels)) {
    const option = node("label", "shopping-purchase-choice");
    const input = node("input");
    input.type = "radio";
    input.name = name;
    input.value = id;
    input.checked = id === value;
    option.append(input, node("span", "", t(label)));
    group.append(option);
  }
  const read = () => group.querySelector("input:checked").value;
  group.onchange = () => changed(read());
  return { group, read };
}

function confirmation(node, text) {
  const label = node("label", "shopping-purchase-consent");
  const input = node("input");
  input.type = "checkbox";
  label.append(input, node("span", "", text));
  return { label, input };
}

function deliveryAddressField({ node, button, t, request }, initialId, onChange, onSelection) {
  const root = node("div", "shopping-delivery-address");
  const line = node("div", "shopping-address-line");
  const field = node("label", "field");
  const select = node("select");
  select.dir = "auto";
  field.append(node("span", "", t("shoppingPurchaseDeliveryAddress")), select);
  const refresh = button(t("shoppingPurchaseReloadAddresses"), "icon-button", { symbol: "refresh", iconOnly: true, onClick: load });
  line.append(field, refresh);
  const detail = node("small", "shopping-field-hint");
  detail.dir = "auto";
  const feedback = node("small", "shopping-field-hint shopping-address-feedback");
  feedback.setAttribute("role", "status");
  const open = node("a", "shopping-address-open", t("shoppingPurchaseManageAddresses"));
  open.href = digikalaAddressesUrl;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  root.append(line, detail, feedback, open);
  let mode, response, pending = false, id = initialId ?? "";

  function render() {
    const choices = response?.choices ?? [];
    if (!id && !initialId && isShoppingPaymentMode(mode) && choices.some(choice => choice.id === response?.defaultId)) {
      id = response.defaultId;
    }
    const selected = choices.find(choice => choice.id === id);
    const placeholder = node("option", "", t(mode === "prepare" ? "shoppingPurchaseUseDefaultAddress" : "shoppingPurchaseChooseAddress"));
    placeholder.value = "";
    select.replaceChildren(placeholder, ...choices.map(choice => {
      const option = node("option", "", choice.title && choice.title !== choice.detail ? `${choice.title} · ${choice.detail}` : choice.detail);
      option.value = choice.id;
      return option;
    }));
    select.value = selected?.id ?? "";
    select.disabled = pending || !choices.length;
    refresh.disabled = pending;
    refresh.dataset.busy = String(pending);
    detail.textContent = selected?.title ? selected.detail : "";
    detail.hidden = !detail.textContent;
    const issue = pending ? "shoppingPurchaseAddressesLoading" : response?.error
      ?? (response && !choices.length ? "shoppingPurchaseNoAddresses" : null);
    feedback.textContent = issue ? t(issue) : "";
    feedback.hidden = !issue;
    open.hidden = pending || Boolean(choices.length);
    onSelection();
  }

  async function load() {
    if (pending) return;
    pending = true;
    render();
    const result = await request("addresses");
    pending = false;
    if (response && result?.accountId !== response.accountId) onChange();
    if (response?.choices?.find(choice => choice.id === id)?.key !== result?.choices?.find(choice => choice.id === id)?.key) onChange();
    response = result;
    render();
  }

  select.onchange = () => {
    id = select.value;
    onChange();
    const selected = response?.choices?.find(choice => choice.id === id);
    detail.textContent = selected?.title ? selected.detail : "";
    detail.hidden = !detail.textContent;
    onSelection();
  };

  return {
    root,
    update(value) {
      mode = value;
      root.hidden = value === "notify";
      if (!root.hidden && response === undefined) void load();
      else render();
    },
    selection() {
      if (pending) return null;
      const choice = response?.choices?.find(choice => choice.id === select.value);
      return choice ? { id: choice.id, key: choice.key, accountId: response.accountId } : null;
    },
    error() { return pending ? "shoppingPurchaseAddressesLoading" : response?.error || "shoppingPurchaseChooseAddress"; },
    focus() { (select.disabled ? refresh : select).focus(); }
  };
}

function currentInvoicePreview({ node, t, priceText, request }) {
  const root = node("div", "shopping-invoice-preview");
  const amounts = node("dl", "shopping-invoice-amounts");
  const status = node("small", "shopping-field-hint");
  root.setAttribute("aria-live", "polite");
  root.append(amounts, status);
  let version = 0;
  let timeout;

  function show(subtotal, quote) {
    const figures = quote ? [
      ["shoppingQuoteItems", quote.total - quote.shipping],
      ["shoppingQuoteShipping", quote.shipping],
      ["shoppingQuoteTotal", quote.total]
    ] : [["shoppingQuoteItems", subtotal]];
    amounts.replaceChildren(...figures.map(([label, value]) => {
      const row = node("div", label === "shoppingQuoteTotal" ? "shopping-invoice-total" : "");
      const amount = node("dd");
      amount.append(node("bdi", "", priceText(value)));
      row.append(node("dt", "", t(label)), amount);
      return row;
    }));
    status.hidden = Boolean(quote);
    status.textContent = quote ? "" : t("shoppingQuotePending");
  }

  return {
    root,
    update(offer, address, method) {
      clearTimeout(timeout);
      const stamp = ++version;
      const subtotal = digikalaPrice(offer?.price * offer?.quantity);
      root.hidden = !address || !subtotal;
      if (root.hidden) return;
      show(subtotal);
      if (!offer.variantId || !offer.sellerId) return;
      timeout = setTimeout(async () => {
        if (!root.isConnected || !root.closest("dialog")?.open) return;
        const result = await request("invoice-preview", { input: { ...offer, address, method } });
        if (stamp === version && root.isConnected && result?.quote) show(subtotal, result.quote);
      }, 180);
    }
  };
}

export function purchaseEditor({ node, button, t, numberField, priceText, readAmount, request }, state, job) {
  const root = node("details", "snippet-advanced shopping-purchase-editor");
  root.open = Boolean(job);
  root.append(node("summary", "", t("shoppingPurchaseAction")));
  const fields = node("div", "snippet-advanced-fields");
  const paymentFields = node("div", "shopping-payment-fields");
  const addressNote = node("small", "shopping-field-hint", t("shoppingPurchaseAddressHint"));
  const orderLimit = numberField(paymentFields, t("shoppingPurchaseBudget"), job?.limit ? job.limit / 10 : null);
  orderLimit.placeholder = "";
  const terms = node("ul", "shopping-purchase-terms");
  terms.append(node("li", "", t(carts[state.policy.cart])));
  terms.append(node("li", "", state.policy.delivery === "max"
    ? t("shoppingPurchaseShippingAgreed", { price: priceText(state.policy.shippingLimit) })
    : t(deliveries[state.policy.delivery])));
  const consent = confirmation(node, "");
  orderLimit.addEventListener("input", () => { consent.input.checked = false; });
  const quote = currentInvoicePreview({ node, t, priceText, request });
  let offer;
  const updateQuote = () => quote.update(offer, mode.read() === "notify" ? null : address.selection(), mode.read());
  const address = deliveryAddressField({ node, button, t, request }, job?.buyer?.addressId,
    () => { consent.input.checked = false; }, updateQuote);
  const walletHint = node("small", "shopping-field-hint", t("shoppingPurchaseWalletHint"));
  paymentFields.append(terms, walletHint, consent.label);
  const hint = node("small", "shopping-field-hint");
  const mode = choices(node, t, "shoppingPurchaseAction", "shopping-purchase-mode", modes, job?.mode ?? "notify", update);
  mode.group.classList.add("shopping-purchase-modes");
  function update(value) {
    const credit = isShoppingCreditMode(value);
    paymentFields.hidden = !isShoppingPaymentMode(value);
    walletHint.hidden = value !== "wallet";
    const hintKey = value === "prepare" ? "shoppingPurchasePrepareHint" : credit ? "shoppingPurchaseCreditHint" : null;
    hint.hidden = !hintKey;
    hint.textContent = hintKey ? t(hintKey) : "";
    const consentKey = credit ? "shoppingPurchaseCreditConsent"
      : job?.status === "paid" ? "shoppingPurchaseConsentAgain" : "shoppingPurchaseConsent";
    consent.label.lastElementChild.textContent = t(consentKey);
    consent.input.checked = false;
    addressNote.hidden = value === "notify";
    address.update(value);
  }
  update(mode.read());
  fields.append(mode.group, hint, address.root, quote.root, addressNote, paymentFields);
  root.append(fields);
  return {
    root,
    updateOffer(value) { offer = value; updateQuote(); },
    invalidateConsent() { consent.input.checked = false; },
    read() {
      const value = mode.read();
      const payload = { mode: value };
      if (value !== "notify") payload.address = address.selection();
      if (isShoppingPaymentMode(value)) {
        payload.limit = readAmount(orderLimit);
        if (!digikalaPrice(payload.limit)) { orderLimit.focus(); return { error: "shoppingPurchaseInvalidBudget" }; }
        if (!payload.address && (!job?.buyer || job.mode !== value || consent.input.checked)) {
          address.focus();
          return { error: address.error() };
        }
        payload.confirm = consent.input.checked;
        payload.policy = state.policy;
      }
      return { payload };
    }
  };
}

export function openPurchaseSettings({ node, button, t, editor, openEditor, numberField, readAmount, mutate, reportError, showToast }, state) {
  if (editor.open) return;
  const fields = openEditor(t("shoppingPurchaseSettings"), t("save"), async () => {
    const delivery = shipping.read();
    const value = delivery === "max" ? readAmount(limit) : null;
    if (delivery === "max" && value !== 0 && !digikalaPrice(value)) {
      limit.focus();
      reportError("shoppingPurchaseInvalidShipping");
      return false;
    }
    return mutate("shopping-purchase-settings", { cart: cart.read(), delivery, shippingLimit: value });
  });
  const cart = choices(node, t, "shoppingPurchaseExistingCart", "shopping-cart-policy", carts, state.policy.cart);
  const maximum = node("div", "shopping-shipping-limit");
  const limit = numberField(maximum, t("shoppingPurchaseShippingBudget"),
    state.policy.shippingLimit === null ? null : state.policy.shippingLimit / 10);
  limit.placeholder = "";
  maximum.hidden = state.policy.delivery !== "max";
  const shipping = choices(node, t, "shoppingPurchaseDeliveryPolicy", "shopping-delivery-policy", deliveries,
    state.policy.delivery, value => { maximum.hidden = value !== "max"; });
  fields.append(cart.group, shipping.group, maximum, node("small", "shopping-field-hint", t("shoppingPurchaseSettingsHint")));
  if (state.payment?.needsReview && state.payment.owner === state.owner) {
    const box = node("section", "shopping-payment-review");
    const checked = confirmation(node, t("shoppingPurchaseReviewed"));
    const orders = button(t("shoppingPurchaseOpenOrders"), "secondary-button", { symbol: "open-window",
      onClick: () => chrome.tabs.create({ url: digikalaOrdersUrl }) });
    const release = button(t("shoppingPurchaseRelease"), "secondary-button", { onClick: async () => {
      release.disabled = true;
      if (await mutate("shopping-purchase-release", { token: state.payment.token, reviewed: checked.input.checked })) {
        box.remove();
        showToast(t("shoppingPurchaseReleased"));
      } else release.disabled = !checked.input.checked;
    }});
    release.disabled = true;
    checked.input.onchange = () => { release.disabled = !checked.input.checked; };
    box.append(node("strong", "", t("shoppingPurchaseUnknown")), orders, checked.label, release);
    fields.append(box);
  }
  editor.showModal();
  cart.group.querySelector("input:checked").focus();
}
