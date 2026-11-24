import { digikalaOrdersUrl } from "./shopping-checkout-digikala.js";
import { digikalaPrice, parseShoppingNumber } from "./shopping-store.js";

const modes = { notify: "shoppingPurchaseNotifyMode", prepare: "shoppingPurchasePrepareMode", wallet: "shoppingPurchaseWalletMode" };
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

export function purchaseEditor({ node, t, numberField, priceText }, state, job) {
  const root = node("details", "snippet-advanced shopping-purchase-editor");
  root.open = Boolean(job);
  root.append(node("summary", "", t("shoppingPurchaseAction")));
  const fields = node("div", "snippet-advanced-fields");
  const wallet = node("div", "shopping-wallet-fields");
  const orderLimit = numberField(wallet, t("shoppingPurchaseBudget"), job?.limit ? job.limit / 10 : null);
  orderLimit.placeholder = "";
  const terms = node("ul", "shopping-purchase-terms");
  terms.append(node("li", "", t(carts[state.policy.cart])));
  terms.append(node("li", "", state.policy.delivery === "max"
    ? t("shoppingPurchaseShippingAgreed", { price: priceText(state.policy.shippingLimit) })
    : t(deliveries[state.policy.delivery])));
  const consent = confirmation(node, t(job?.status === "paid" ? "shoppingPurchaseConsentAgain" : "shoppingPurchaseConsent"));
  wallet.append(terms, node("small", "shopping-field-hint", t("shoppingPurchaseWalletHint")), consent.label);
  const hint = node("small", "shopping-field-hint");
  const mode = choices(node, t, "shoppingPurchaseAction", "shopping-purchase-mode", modes, job?.mode ?? "notify", update);
  mode.group.classList.add("shopping-purchase-modes");
  function update(value) {
    wallet.hidden = value !== "wallet";
    hint.hidden = value !== "prepare";
    hint.textContent = value === "prepare" ? t("shoppingPurchasePrepareHint") : "";
    consent.input.checked = false;
  }
  update(mode.read());
  fields.append(mode.group, hint, wallet);
  root.append(fields);
  return {
    root,
    read() {
      const value = mode.read();
      const payload = { mode: value };
      if (value === "wallet") {
        payload.limit = parseShoppingNumber(orderLimit.value) * 10;
        if (!digikalaPrice(payload.limit)) { orderLimit.focus(); return { error: "shoppingPurchaseInvalidBudget" }; }
        payload.confirm = consent.input.checked;
        payload.policy = state.policy;
      }
      return { payload };
    }
  };
}

export function openPurchaseSettings({ node, button, t, editor, openEditor, numberField, mutate, reportError, showToast }, state) {
  if (editor.open) return;
  const fields = openEditor(t("shoppingPurchaseSettings"), t("save"), async () => {
    const delivery = shipping.read();
    const value = delivery === "max" ? parseShoppingNumber(limit.value) * 10 : null;
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
