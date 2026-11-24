import { shoppingMessage } from "./shopping-background.js";
import { shoppingHostPermission, shoppingNotificationPermission } from "./shopping-digikala.js";
import {
  digikalaPrice, digikalaProductLink, digikalaProductUrl, digikalaSearchUrl, parseShoppingNumber,
  offerFitsQuantity, shoppingNumberDigits, shoppingPollMinutes, shoppingQuantity, shoppingReadErrors, shoppingWatchKey
} from "./shopping-store.js";
import { createShoppingSellerPicker } from "./shopping-sellers.js";
import { canRetryShoppingPurchase, isShoppingCreditMode, shoppingPurchaseStatus, shoppingWatchStatus } from "./shopping-purchase-store.js";
import { openPurchaseSettings, purchaseEditor } from "./shopping-purchase-ui.js";
import { createDatePicker } from "./date-picker.js";
import { createTimePicker } from "./time-picker.js";
import { localTaskDay, taskTimestamp } from "./todo-store.js";

const request = (action, data) => chrome.runtime.sendMessage({ type: shoppingMessage, action, ...data })
  .catch(() => ({ error: "shoppingUnavailable" }));

export function renderShopping(root, options) {
  const { node, button, glyph, t, icon, locale, dateLocale, firstDay, refreshButton, notifyButton,
    editor, openEditor, reportError, showToast, mutate, openMenu } = options;
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const amounts = new Intl.NumberFormat(locale, { useGrouping: "always", maximumFractionDigits: 0 });
  const group = amounts.formatToParts(1000).find(part => part.type === "group").value;
  const percentages = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const dates = new Intl.DateTimeFormat(dateLocale, { dateStyle: "medium", timeStyle: "short" });
  const priceText = rials => t("shoppingTomanPrice", { amount: numbers.format(rials / 10) });
  const price = rials => node("bdi", "shopping-price", priceText(rials));
  let { watches, observations, purchases } = options;
  let lookupVersion = 0;
  let connected = false;
  let live = true;
  let stamp;

  const form = node("form", "shopping-lookup");
  const input = node("input");
  input.type = "search";
  input.dir = "auto";
  input.autocomplete = "off";
  input.maxLength = 2000;
  input.placeholder = t("shoppingSearchPlaceholder");
  input.setAttribute("aria-label", input.placeholder);
  const find = button(t("shoppingSearch"), "icon-button shopping-find", { symbol: "search", iconOnly: true });
  find.type = "submit";
  form.append(input, find);

  const connection = node("div", "shopping-connection");
  connection.hidden = true;
  const connect = button(t("shoppingConnect"), "secondary-button", { symbol: "link", onClick: async () => {
    connect.disabled = true;
    const response = await request("connect");
    connect.disabled = false;
    if (response?.error) return reportError(response.error);
    await updateAccess();
    if (input.value.trim()) void lookup(input.value.trim());
  }});
  connection.append(glyph("shopping", "shopping-store-mark"), node("span", "", t("shoppingConnectHint")), connect);

  const activeProduct = button(t("shoppingTrackOpenPage"), "secondary-button shopping-track-page", { symbol: "plus" });
  activeProduct.hidden = true;
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    const product = digikalaProductLink(tab?.url);
    if (!live || !product) return;
    activeProduct.hidden = false;
    activeProduct.onclick = () => fill(digikalaProductUrl(product.productId, product.variantId, product.title));
  }).catch(() => {});

  const result = node("div", "shopping-lookup-results");
  const feedback = node("p", "shopping-lookup-feedback");
  feedback.hidden = true;
  feedback.setAttribute("role", "status");
  const list = node("ul", "shopping-list");
  const empty = node("div", "shopping-empty");
  empty.append(glyph("shopping", "shopping-store-mark"), node("strong", "", t("shoppingEmpty")));
  root.append(connection, form, activeProduct, feedback, result, list, empty);

  function thumb(url) {
    const frame = node("span", "shopping-thumb");
    frame.setAttribute("aria-hidden", "true");
    frame.append(glyph("shopping"));
    if (url) {
      const image = node("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove(), { once: true });
      image.src = url;
      frame.append(image);
    }
    return frame;
  }

  function titleOf(text, className) {
    const title = node("strong", className, text);
    title.dir = "auto";
    return title;
  }

  function linkTo(url, label, className = "secondary-button") {
    const link = node("a", className);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.append(glyph("open-window"), node("span", "", label));
    return link;
  }

  function setFeedback(key) {
    feedback.hidden = !key;
    feedback.textContent = key ? t(key) : "";
  }

  async function updateAccess() {
    const [access, notifications] = await Promise.all([
      chrome.permissions.contains(shoppingHostPermission), chrome.permissions.contains(shoppingNotificationPermission)
    ]);
    if (!live) return;
    connected = access;
    connection.hidden = access;
    refreshButton.disabled = !access;
    notifyButton.hidden = notifications || !access;
    renderWatches();
  }

  async function lookup(value) {
    const version = ++lookupVersion;
    const link = digikalaProductLink(value);
    if (!connected) {
      setFeedback("shoppingConnect");
      connect.focus();
      if (!link) return;
    }
    setFeedback(connected ? "shoppingLoading" : "shoppingConnect");
    find.disabled = true;
    form.setAttribute("aria-busy", "true");
    result.replaceChildren();
    const response = connected ? await request("lookup", { input: value }) : { error: "shoppingConnect" };
    if (!live || version !== lookupVersion) return;
    find.disabled = false;
    form.removeAttribute("aria-busy");
    setFeedback(response?.error);
    const legacy = link && watches.filter(watch => watch.productId === link.productId && watch.variantId === link.variantId
      && watch.title === `DKP-${link.productId}`);
    const existing = legacy?.length === 1 ? legacy[0] : undefined;
    if (response?.product) {
      editWatch(existing, response.product, response.variantId);
      return;
    }
    if (response?.error) {
      if (link && response.error !== "shoppingProductMissing") {
        const draft = { id: link.productId, title: link.title || `DKP-${link.productId}`, fromLink: true };
        result.append(button(t("shoppingSaveLink"), "secondary-button", {
          symbol: "plus", onClick: () => editWatch(existing, draft, link.variantId)
        }), linkTo(digikalaProductUrl(link.productId, link.variantId, link.title), t("shoppingOpenProduct")));
      } else if (shoppingReadErrors.has(response.error)) {
        result.append(linkTo(digikalaSearchUrl(value), t("shoppingOpenSearch")));
      }
      return;
    }
    const products = response?.products ?? [];
    if (!products.length) setFeedback("shoppingNoResults");
    for (const product of products) {
      const choice = node("button", "shopping-result");
      choice.type = "button";
      const copy = node("span", "shopping-result-copy");
      copy.append(titleOf(product.title, "shopping-product-title"));
      if (product.price !== null) copy.append(price(product.price));
      choice.append(thumb(product.image), copy, glyph("plus"));
      choice.addEventListener("click", () => editWatch(undefined, product));
      result.append(choice);
    }
  }

  function fill(value) {
    input.value = value;
    if (connected) {
      void lookup(value);
      return;
    }
    updateAccess().then(() => {
      if (!live || input.value !== value) return;
      if (connected) void lookup(value);
      else input.focus();
    }).catch(() => {});
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (input.value.trim()) void lookup(input.value.trim());
  });
  input.addEventListener("search", () => {
    if (input.value) return;
    lookupVersion++;
    result.replaceChildren();
    find.disabled = false;
    form.removeAttribute("aria-busy");
    setFeedback();
  });
  refreshButton.onclick = async () => {
    refreshButton.disabled = true;
    refreshButton.dataset.busy = "true";
    const response = await request("refresh");
    delete refreshButton.dataset.busy;
    refreshButton.disabled = !connected;
    if (response?.error) reportError(response.error);
  };
  notifyButton.onclick = async () => {
    notifyButton.disabled = true;
    const response = await request("notify");
    notifyButton.disabled = false;
    if (response?.error) reportError(response.error);
    else await updateAccess();
  };

  const readAmount = input => parseShoppingNumber(input.value, group) * 10;

  function numberField(parent, label, value, grouped = true) {
    const field = node("label", "field");
    const control = node("input");
    control.inputMode = "numeric";
    control.maxLength = 24;
    control.dir = "auto";
    control.value = value == null ? "" : (grouped ? amounts : numbers).format(value);
    control.placeholder = t("shoppingOptional");
    field.append(node("span", "", label), control);
    parent.append(field);
    if (grouped) {
      function format(inputType) {
        const previous = control.value;
        const digits = shoppingNumberDigits(previous, group);
        if (!digits) { control.value = ""; return; }
        if (!/^\d+$/u.test(digits)) return;
        const formatted = amounts.format(BigInt(digits));
        if (formatted === previous) return;
        let right = shoppingNumberDigits(previous.slice(control.selectionStart ?? previous.length), group).length;
        let caret = formatted.length;
        while (caret > 0 && right > 0) {
          caret -= 1;
          if (/\p{Nd}/u.test(formatted[caret])) right -= 1;
        }
        if (inputType === "deleteContentBackward" && formatted.slice(0, caret).endsWith(group)) caret -= group.length;
        control.value = formatted;
        control.setSelectionRange(caret, caret);
      }
      control.addEventListener("input", event => { if (!event.isComposing) format(event.inputType); });
      control.addEventListener("compositionend", () => format());
    }
    return control;
  }

  function editWatch(watch, product, variantId, focusSeller = false) {
    if (editor.open) return;
    const selected = watch?.variantId ?? variantId;
    const productId = watch?.productId ?? product.id;
    const sample = watch && observations[watch.id];
    const currentQuote = sample && sample.rule === shoppingWatchKey(watch) ? sample.quote : null;
    const liveQuote = currentQuote && !sample.error && Date.now() - sample.checkedAt <= 3 * shoppingPollMinutes * 60_000 ? currentQuote : null;
    let title = product?.title ?? currentQuote?.title ?? watch?.title;
    let image = product?.image ?? currentQuote?.image ?? watch?.image;
    const pickers = [];
    let action;
    let invoiceOffer;
    const changed = () => action?.invalidateConsent();
    const fields = openEditor(t(watch ? "shoppingEdit" : "shoppingNew"), t("save"), async () => {
      const limit = cap.value.trim() ? readAmount(cap) : null;
      const discount = percent.value.trim() ? parseShoppingNumber(percent.value) : null;
      const count = readQuantity();
      const startAt = starts.read();
      const endAt = ends.read();
      if (!count) {
        quantity.focus();
        reportError("shoppingInvalidQuantity");
        return false;
      }
      if ((limit !== null && !digikalaPrice(limit)) || (discount !== null && (!Number.isInteger(discount) || discount < 1 || discount > 99))) {
        reportError("shoppingInvalidThreshold");
        return false;
      }
      if (Number.isNaN(startAt) || Number.isNaN(endAt) || (startAt !== null && endAt !== null && endAt <= startAt)) {
        schedule.open = true;
        reportError("shoppingInvalidSchedule");
        return false;
      }
      const checkout = action.read();
      if (checkout.error) {
        action.root.open = true;
        reportError(checkout.error);
        return false;
      }
      const saved = await mutate("shopping-save", {
        id: watch?.id, productId, title, image, ...picker.selection(), quantity: count, priceLimit: limit, discount, startAt, endAt,
        purchase: checkout.payload
      });
      if (saved) {
        if (!watch) {
          input.value = "";
          result.replaceChildren();
          setFeedback();
        }
        showToast(t("shoppingSaved"));
      }
      return saved;
    });
    const heading = node("div", "shopping-editor-product");
    const offerCopy = node("div", "shopping-result-copy");
    const preview = node("div", "shopping-offer-preview");
    const headingName = titleOf(title, "shopping-product-title");
    offerCopy.append(headingName, preview);
    heading.append(thumb(image), offerCopy);
    const thresholds = node("div", "shopping-field-row shopping-thresholds");
    const cap = numberField(thresholds, t("shoppingCeiling"), watch?.priceLimit ? watch.priceLimit / 10 : null);
    const percent = numberField(thresholds, t("shoppingDiscount"), watch?.discount, false);
    const quantity = numberField(thresholds, t("shoppingQuantity"), watch?.quantity ?? 1, false);
    quantity.placeholder = numbers.format(1);
    const readQuantity = () => shoppingQuantity(parseShoppingNumber(quantity.value));
    let customCap = watch?.priceLimit != null;
    cap.addEventListener("input", () => { customCap = true; changed(); });
    percent.addEventListener("input", changed);
    const picker = createShoppingSellerPicker({ node, t, locale, watch, variantId: selected, product, readQuantity, onEdit: changed,
      onChange(offer, catalogReady) {
        const observed = (offer ? liveQuote?.variantId === offer.id : !catalogReady) ? liveQuote : null;
        const value = offer?.price ?? (offer?.available === false ? null : observed?.price);
        invoiceOffer = { productId, variantId: offer?.id ?? observed?.variantId,
          sellerId: offer?.sellerId ?? observed?.sellerId, price: value, quantity: readQuantity() };
        action?.updateOffer(invoiceOffer);
        if (!customCap) cap.value = value ? amounts.format(Math.ceil(value / 10)) : "";
        const labels = [];
        const model = offer?.optionLabel || offer?.label || observed?.optionLabel || observed?.variantLabel;
        const seller = offer?.sellerName || observed?.sellerName;
        if (model) labels.push(node("bdi", "", model));
        if (seller) labels.push(node("bdi", "", seller));
        if (value) labels.push(price(value));
        if (offer?.available === false) labels.push(node("span", "", t("shoppingOutOfStock")));
        else if (offer && !offerFitsQuantity(offer, readQuantity() ?? 1)) labels.push(node("span", "", t("shoppingWaitingQuantity")));
        preview.replaceChildren(...labels);
      }
    });
    quantity.addEventListener("input", () => { picker.refresh(); changed(); });
    const ruleHint = node("small", "shopping-field-hint", t("shoppingRuleHint"));
    ruleHint.id = "shopping-rule-hint";
    cap.setAttribute("aria-describedby", ruleHint.id);
    percent.setAttribute("aria-describedby", ruleHint.id);

    const schedule = node("details", "snippet-advanced shopping-schedule");
    schedule.open = Boolean(watch?.startAt || watch?.endAt);
    const dates = node("div", "snippet-advanced-fields");
    schedule.append(node("summary", "", t("shoppingSchedule")), dates);

    const clockText = date => [date.getHours(), date.getMinutes()].map(unit => String(unit).padStart(2, "0")).join(":");
    let customEnd = watch?.endAt != null;
    function suggestEnd() {
      if (customEnd) return;
      const value = starts.read();
      ends.set(starts.time.value && Number.isFinite(value) ? new Date(value + 60 * 60_000) : null);
    }

    function dateTime(label, timestamp, isStart, onEdit) {
      const instant = timestamp ? new Date(timestamp) : undefined;
      const row = node("div", "shopping-field-row shopping-datetime");
      let dateSelected = Boolean(instant);
      const calendar = createDatePicker({
        dateLocale, firstDay, label: t(label), t, icon, value: instant ? localTaskDay(0, instant) : isStart ? localTaskDay() : "",
        onChange() { dateSelected = Boolean(calendar.value); onEdit(); changed(); },
        onOpen(panel) { for (const other of pickers) if (other.panel !== panel) other.close(); }
      });
      pickers.push(calendar);
      const time = createTimePicker({ locale, label: t("todoTime"), t, value: instant ? clockText(instant) : "" });
      time.element.addEventListener("input", () => { onEdit(); changed(); });
      const timeWrapper = node("div", "field");
      timeWrapper.append(node("span", "", t("todoTime")), time.element);
      row.append(calendar.field, timeWrapper, calendar.panel);
      dates.append(row);
      return {
        time,
        read() {
          if (!time.value && !dateSelected) return null;
          return taskTimestamp(calendar.value, time.value || (isStart ? "00:00" : "23:59")) ?? NaN;
        },
        set(date) {
          dateSelected = Boolean(date);
          calendar.setValue(date ? localTaskDay(0, date) : "");
          time.value = date ? clockText(date) : "";
        }
      };
    }
    const starts = dateTime("shoppingStarts", watch?.startAt, true, suggestEnd);
    const ends = dateTime("shoppingEnds", watch?.endAt, false, () => { customEnd = true; });
    action = purchaseEditor({ node, button, t, numberField, priceText, readAmount, request }, purchases, purchases.jobs[watch?.id]);
    action.updateOffer(invoiceOffer);
    fields.append(heading, picker.root, thresholds, ruleHint, schedule, action.root);
    editor.showModal();
    if (focusSeller) picker.focus();
    else cap.focus();
    if (connected && !product?.offers && !product?.fromLink) request("lookup", { input: digikalaProductUrl(productId, selected) }).then(response => {
      if (editor.open && fields.isConnected && response?.product) {
        title = response.product.title;
        headingName.textContent = title;
        if (response.product.image) {
          image = response.product.image;
          heading.firstElementChild.replaceWith(thumb(image));
        }
        picker.update(response.product);
      }
    });
  }

  function removeWatch(watch, name) {
    if (editor.open) return;
    const fields = openEditor(t("shoppingRemove"), t("remove"), () => mutate("shopping-remove", { id: watch.id }));
    fields.append(node("p", "", t("shoppingRemoveConfirm", { name })));
    editor.showModal();
    editor.querySelector(".dialog-footer .secondary-button").focus();
  }

  async function cart(watch, action) {
    action.disabled = true;
    action.dataset.busy = "true";
    const response = await request("cart", { id: watch.id });
    action.disabled = false;
    delete action.dataset.busy;
    if (response?.error) reportError(response.error);
    else if (!response?.clicked) showToast(t("shoppingCartOnSite"));
  }

  function renderWatch(watch, status) {
    const raw = observations[watch.id];
    const liveSample = raw?.rule === shoppingWatchKey(watch) ? raw : null;
    const quote = liveSample?.quote;
    const name = quote?.title ?? watch.title;
    const ready = status === "shoppingReady";
    const job = purchases.jobs[watch.id];
    const purchaseStatus = shoppingPurchaseStatus(watch, job, purchases.policy);
    const card = node("li", "shopping-card");
    card.id = `shopping-watch-${watch.id}`;
    card.tabIndex = -1;
    card.dataset.state = status;
    const head = node("div", "shopping-card-heading");
    const labels = node("div", "shopping-card-title");
    const variant = watch.optionLabel || quote?.optionLabel || watch.variantLabel || quote?.variantLabel;
    labels.append(titleOf(name, "shopping-product-title"));
    const sellerName = quote?.sellerName || watch.sellerName;
    if (variant) {
      const label = node("span", "shopping-variant-name", variant);
      label.dir = "auto";
      labels.append(label);
    }
    const sellerButton = button(sellerName || t(watch.allSellers ? "shoppingAllowedSellers" : "shoppingChooseSeller"),
      "shopping-card-seller", { symbol: "chevron-down", onClick: () => editWatch(watch, undefined, undefined, true) });
    sellerButton.id = `shopping-seller-${watch.id}`;
    sellerButton.setAttribute("aria-label", sellerName ? `${t("shoppingChooseSeller")} · ${sellerName}` : t("shoppingChooseSeller"));
    labels.append(sellerButton);
    const badge = node("span", "shopping-status", t(status));
    if (status === "shoppingPurchased") badge.prepend(glyph("check"));
    head.append(thumb(quote?.image ?? watch.image), labels, badge);

    const footer = node("div", "shopping-card-footer");
    const values = node("div", "shopping-card-values");
    if (quote?.price) {
      const last = node("div", "shopping-price-row");
      last.append(price(quote.price));
      if (shoppingReadErrors.has(status) || status === "shoppingConnect") last.append(node("small", "", t("shoppingLastPrice")));
      else if (quote.discount > 0) {
        last.append(node("del", "", priceText(quote.reference)), node("small", "shopping-discount", percentages.format(quote.discount / 100)));
      }
      values.append(last);
    }
    const terms = node("div", "shopping-terms");
    if (watch.priceLimit) terms.append(node("span", "", t("shoppingTarget", { price: priceText(watch.priceLimit) })));
    if (watch.discount) terms.append(node("span", "", t("shoppingTargetDiscount", { discount: percentages.format(watch.discount / 100) })));
    if (watch.quantity > 1) terms.append(node("span", "", t("shoppingQuantityBadge", { count: numbers.format(watch.quantity) })));
    if (watch.startAt && status === "shoppingScheduled") terms.append(node("span", "", dates.format(watch.startAt)));
    if (terms.childElementCount) values.append(terms);
    if (liveSample?.checkedAt) values.append(node("small", "shopping-checked", t("shoppingCheckedAt", { date: dates.format(liveSample.checkedAt) })));

    const actions = node("div", "shopping-card-actions");
    const more = button(t("shoppingActions"), "icon-button", { symbol: "more", iconOnly: true, onClick: () => openMenu(more, action => {
      action("shoppingOpenProduct", "open-window", () => chrome.tabs.create({ url: digikalaProductUrl(watch.productId, watch.variantId ?? quote?.variantId) }));
      action("shoppingEdit", "edit", () => editWatch(watch));
      action(watch.paused ? "shoppingResume" : "shoppingPause", watch.paused ? "play" : "pause",
        () => mutate("shopping-pause", { id: watch.id, paused: !watch.paused }));
      action("shoppingRemove", "trash", () => removeWatch(watch, name));
    })});
    more.id = `shopping-more-${watch.id}`;
    more.setAttribute("aria-haspopup", "menu");
    if (ready && !job) {
      const add = button(t("shoppingPrepareCart"), "secondary-button shopping-cart", { symbol: "shopping", onClick: () => cart(watch, add) });
      add.id = `shopping-cart-${watch.id}`;
      actions.append(add);
    }
    actions.append(more);
    footer.append(values, actions);
    card.append(head, footer);
    if (purchaseStatus) {
      const checkout = node("div", "shopping-checkout-status");
      checkout.dataset.status = job.status;
      const statusText = node("span", "", job.orderId ? t("shoppingPurchaseOrder", { order: job.orderId }) : t(purchaseStatus));
      if (job.status === "running" || job.status === "submitting") checkout.setAttribute("role", "status");
      checkout.append(statusText);
      if (job.invoiceQuote && purchaseStatus !== "shoppingPurchaseRearm") {
        const lastQuote = node("small", "shopping-last-invoice", t("shoppingQuoteBreakdown", {
          total: priceText(job.invoiceQuote.total), shipping: priceText(job.invoiceQuote.shipping)
        }));
        lastQuote.title = t("shoppingCheckedAt", { date: dates.format(job.invoiceQuote.checkedAt) });
        checkout.append(lastQuote);
      }
      if (purchaseStatus === "shoppingPurchaseRearm") {
        const edit = button(t("shoppingEdit"), "secondary-button shopping-checkout-link", { symbol: "edit", onClick: () => editWatch(watch) });
        edit.id = `shopping-checkout-${watch.id}`;
        checkout.append(edit);
      } else if (["review", "prepared", "awaiting", "paid", "unknown"].includes(job.status)) {
        const controls = node("div", "shopping-checkout-actions");
        if (ready && canRetryShoppingPurchase(watch, job, purchases)) {
          const retry = button(t("shoppingPurchaseRetry"), "icon-button shopping-checkout-retry", { symbol: "refresh", iconOnly: true, onClick: async () => {
            retry.disabled = true;
            const result = await request("refresh", { id: watch.id });
            retry.disabled = false;
            if (result?.error) reportError(result.error);
          }});
          retry.id = `shopping-checkout-retry-${watch.id}`;
          controls.append(retry);
        }
        if (job.status === "prepared" && isShoppingCreditMode(job.mode) && job.creditApproved !== true && ready) {
          const approve = button(t("shoppingPurchaseApproveCredit"), "secondary-button shopping-checkout-link",
            { symbol: "edit", onClick: () => editWatch(watch) });
          approve.id = `shopping-checkout-approve-${watch.id}`;
          controls.append(approve);
        }
        const openLabel = job.status === "awaiting" ? "shoppingPurchaseContinuePayment"
          : job.status === "unknown" || job.status === "paid" ? "shoppingPurchaseOpenOrders" : "shoppingPurchaseOpenCheckout";
        const open = button(t(openLabel),
          "secondary-button shopping-checkout-link", { symbol: "open-window", onClick: async () => {
            const result = await request("open-checkout", { id: watch.id });
            if (result?.error) reportError(result.error);
          }});
        open.id = `shopping-checkout-${watch.id}`;
        controls.append(open);
        checkout.append(controls);
      }
      card.append(checkout);
    }
    return card;
  }

  function renderWatches() {
    const focus = list.contains(document.activeElement) ? document.activeElement.id : null;
    const rows = watches.map(watch => {
      const status = shoppingWatchStatus(watch, observations[watch.id], purchases.jobs[watch.id]);
      const needsAccess = !connected && !["shoppingPaused", "shoppingExpired", "shoppingPurchased"].includes(status);
      return renderWatch(watch, needsAccess ? "shoppingConnect" : status);
    });
    rows.sort((left, right) => Number(right.dataset.state === "shoppingReady") - Number(left.dataset.state === "shoppingReady"));
    list.replaceChildren(...rows);
    empty.hidden = Boolean(rows.length);
    if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
  }

  const refreshPermissions = () => { void updateAccess().catch(() => {}); };
  chrome.permissions.onAdded?.addListener(refreshPermissions);
  chrome.permissions.onRemoved?.addListener(refreshPermissions);
  renderWatches();
  refreshPermissions();
  stamp = setInterval(renderWatches, shoppingPollMinutes * 60_000 / 4);
  return {
    fill,
    openSettings() { openPurchaseSettings({ ...options, numberField, readAmount }, purchases); },
    focusWatch(id) {
      const card = document.getElementById(`shopping-watch-${id}`);
      card?.scrollIntoView({ block: "nearest" });
      card?.focus({ preventScroll: true });
    },
    update(next) { ({ watches, observations, purchases } = next); renderWatches(); },
    dispose() {
      live = false;
      clearInterval(stamp);
      chrome.permissions.onAdded?.removeListener(refreshPermissions);
      chrome.permissions.onRemoved?.removeListener(refreshPermissions);
    }
  };
}
