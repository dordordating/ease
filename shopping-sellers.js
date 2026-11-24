import { normalizeSearchText } from "./workspace-search.js";
import { offerFitsQuantity } from "./shopping-store.js";

export function createShoppingSellerPicker({ node, t, locale, watch, variantId, product, readQuantity, onChange, onEdit }) {
  const numbers = new Intl.NumberFormat(locale);
  const excluded = new Set(watch?.excludedSellers);
  const offeredSellers = new Map();
  const options = new Map();
  const root = node("div", "shopping-seller-picker");
  const productField = node("label", "field");
  const productOptions = node("select", "shopping-product-options");
  productOptions.id = "shopping-product-option";
  productField.append(node("span", "", t("shoppingProductOption")), productOptions);
  const sellerField = node("label", "field");
  const sellers = node("select", "shopping-seller-select");
  sellers.id = "shopping-seller";
  sellerField.append(node("span", "", t("shoppingSeller")), sellers);
  const optionField = node("label", "field");
  const variants = node("select", "shopping-variants");
  optionField.append(node("span", "", t("shoppingOffer")), variants);
  const filter = node("details", "snippet-advanced shopping-seller-filter");
  const filterHeading = node("summary");
  const count = node("span", "shopping-seller-count");
  filterHeading.append(node("span", "", t("shoppingFilterSellers")), count);
  const filterBody = node("div", "snippet-advanced-fields");
  const search = node("input");
  search.type = "search";
  search.dir = "auto";
  search.placeholder = t("shoppingSellerSearch");
  search.setAttribute("aria-label", search.placeholder);
  const list = node("div", "shopping-seller-list");
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", t("shoppingFilterSellers"));
  filterBody.append(search, list);
  filter.append(filterHeading, filterBody);
  filter.open = excluded.size > 0;
  const hint = node("small", "shopping-field-hint", t("shoppingSellerListPending"));
  root.append(productField, sellerField, optionField, filter, hint);

  let catalog = [];
  let catalogReady = false;
  let activeOffer;
  let main;
  let items = [];
  let known = new Set();
  const selection = () => ({
    allSellers: sellers.value === "all",
    excludedSellers: sellers.value === "all" ? [...excluded] : [],
    variantId: activeOffer?.id ?? null,
    variantLabel: activeOffer?.label ?? "",
    sellerId: activeOffer?.sellerId ?? null,
    sellerName: activeOffer?.sellerName ?? "",
    optionKey: activeOffer ? null : productOptions.value || null,
    optionLabel: activeOffer ? "" : options.get(productOptions.value) ?? ""
  });

  function renderCount() {
    count.textContent = t("shoppingSellerCount", {
      count: numbers.format(catalog.filter(group => !excluded.has(group.id)).length),
      total: numbers.format(catalog.length)
    });
  }

  function renderFilter() {
    const query = normalizeSearchText(search.value.trim(), locale);
    list.replaceChildren(...catalog.filter(group => normalizeSearchText(group.name, locale).includes(query)).map(group => {
      const label = node("label", "shopping-seller-option");
      const choice = node("input");
      choice.type = "checkbox";
      choice.checked = !excluded.has(group.id);
      choice.value = group.id;
      const name = node("span", "", group.name);
      name.dir = "auto";
      choice.addEventListener("change", () => {
        if (choice.checked) excluded.delete(group.id);
        else excluded.add(group.id);
        renderCount();
        updateOffer();
        onEdit();
      });
      label.append(choice, name);
      return label;
    }));
    if (!list.childElementCount) list.append(node("small", "shopping-field-hint", t("shoppingNoSellerResults")));
    renderCount();
  }

  function showOptions(preferred) {
    const group = offeredSellers.get(sellers.value);
    const choices = group?.offers ?? [];
    variants.replaceChildren(...choices.map(item => {
      const label = item.label || t("shoppingVariantCode", { id: item.id });
      return new Option(item.available === false ? `${label} · ${t("shoppingOutOfStock")}` : label, item.id);
    }));
    if (choices.some(item => item.id === preferred)) variants.value = preferred;
    optionField.hidden = choices.length < 2;
    filter.hidden = sellers.value !== "all" || !catalog.length;
    hint.hidden = catalogReady;
    updateOffer();
  }

  function currentItems() {
    return productOptions.value ? items.filter(offer => offer.optionKey === productOptions.value) : items;
  }

  function updateOffer() {
    activeOffer = offeredSellers.get(sellers.value)?.offers.find(item => item.id === variants.value);
    const eligible = currentItems().filter(item => item.available && !excluded.has(item.sellerId))
      .sort((a, b) => a.price - b.price);
    const best = eligible.find(item => offerFitsQuantity(item, readQuantity())) ?? eligible[0];
    const offer = activeOffer ?? (sellers.value === "default" ? main : best ?? (!catalogReady ? main : null));
    onChange(offer, catalogReady);
  }

  function renderSellers(desired, previousSeller) {
    offeredSellers.clear();
    let preferred;
    for (const item of currentItems()) {
      const key = item.sellerId ? `seller-${item.sellerId}` : `offer-${item.id}`;
      if (!offeredSellers.has(key)) offeredSellers.set(key, {
        id: item.sellerId, name: item.sellerName || item.label || t("shoppingLinkedOffer"), offers: []
      });
      offeredSellers.get(key).offers.push(item);
      if (item.id === desired.variantId) preferred = key;
    }
    catalog = [...offeredSellers.values()].filter(group => known.has(group.id));
    const showMain = !productOptions.value || productOptions.value === main?.optionKey;
    const preserveSeller = previousSeller && offeredSellers.has(previousSeller);
    sellers.replaceChildren(
      new Option(t("shoppingAllowedSellers"), "all"),
      ...(showMain ? [new Option(t("shoppingDefaultOffer"), "default")] : []),
      ...[...offeredSellers].map(([key, group]) => new Option(group.name, key))
    );
    sellers.value = preferred ?? (preserveSeller ? previousSeller : desired.allSellers || !showMain || desired.variantId ? "all" : "default");
    showOptions(desired.variantId);
    renderFilter();
  }

  function update(next, desired = selection(), desiredOption = productOptions.value) {
    main = next?.main ?? next;
    catalogReady = Array.isArray(next?.offers);
    items = [...(next?.offers ?? [])];
    known = new Set(items.filter(item => item.sellerId && item.sellerName).map(item => item.sellerId));
    if (desired.variantId && !items.some(item => item.id === desired.variantId)) items.push({
      id: desired.variantId, label: desired.variantLabel, sellerId: desired.sellerId, sellerName: desired.sellerName,
      optionKey: desiredOption, optionLabel: desired.optionLabel, available: catalogReady ? false : undefined
    });
    options.clear();
    for (const offer of items) if (offer.optionKey) options.set(offer.optionKey, offer.optionLabel || t("shoppingOffer"));
    if (desiredOption && !options.has(desiredOption)) options.set(desiredOption, desired.optionLabel || t("shoppingOffer"));
    const selected = desiredOption || items.find(item => item.id === desired.variantId)?.optionKey || "";
    productOptions.replaceChildren(new Option(t("shoppingAnyProductOption"), ""),
      ...[...options].map(([id, label]) => new Option(label, id)));
    productOptions.value = selected;
    productField.hidden = !options.size;
    renderSellers(desired);
  }

  productOptions.addEventListener("change", () => {
    const desired = selection();
    renderSellers(desired, sellers.value);
    onEdit();
  });
  sellers.addEventListener("change", () => {
    if (sellers.value === "all") filter.open = true;
    showOptions();
    onEdit();
  });
  variants.addEventListener("change", () => { updateOffer(); onEdit(); });
  search.addEventListener("input", renderFilter);
  update(product, watch ?? { variantId, allSellers: !variantId }, watch?.optionKey);
  return { root, update, selection, refresh: updateOffer, focus: () => sellers.focus() };
}
