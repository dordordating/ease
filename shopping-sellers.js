import { normalizeSearchText } from "./workspace-search.js";

export function createShoppingSellerPicker({ node, t, locale, watch, variantId, offers, onChange }) {
  const numbers = new Intl.NumberFormat(locale);
  const excluded = new Set(watch?.excludedSellers);
  const offeredSellers = new Map();
  const root = node("div", "shopping-seller-picker");
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
  root.append(sellerField, optionField, filter, hint);

  let catalog = [];
  let catalogReady = false;
  let activeOffer;
  const selection = () => ({
    allSellers: sellers.value === "all",
    excludedSellers: sellers.value === "all" ? [...excluded] : [],
    variantId: activeOffer?.id ?? null,
    variantLabel: activeOffer?.label ?? "",
    sellerId: activeOffer?.sellerId ?? null,
    sellerName: activeOffer?.sellerName ?? ""
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

  function updateOffer() {
    activeOffer = offeredSellers.get(sellers.value)?.offers.find(item => item.id === variants.value);
    onChange(activeOffer, sellers.value);
  }

  function update(nextOffers, desired = selection()) {
    offeredSellers.clear();
    catalogReady = Array.isArray(nextOffers);
    const items = nextOffers ? [...nextOffers] : [];
    if (desired.variantId && !items.some(item => item.id === desired.variantId)) items.push({
      id: desired.variantId, label: desired.variantLabel, sellerId: desired.sellerId, sellerName: desired.sellerName
    });

    let preferred;
    for (const item of items) {
      const key = item.sellerId ? `seller-${item.sellerId}` : `offer-${item.id}`;
      if (!offeredSellers.has(key)) offeredSellers.set(key, {
        id: item.sellerId, name: item.sellerName || item.label || t("shoppingLinkedOffer"), offers: []
      });
      offeredSellers.get(key).offers.push(item);
      if (item.id === desired.variantId) preferred = key;
    }
    const known = new Set((nextOffers ?? []).filter(item => item.sellerId && item.sellerName).map(item => item.sellerId));
    catalog = [...offeredSellers.values()].filter(group => known.has(group.id));
    sellers.replaceChildren(
      new Option(t("shoppingAllowedSellers"), "all"),
      new Option(t("shoppingDefaultOffer"), "default"),
      ...[...offeredSellers].map(([key, group]) => new Option(group.name, key))
    );
    sellers.value = preferred ?? (desired.allSellers ? "all" : "default");
    showOptions(desired.variantId);
    renderFilter();
  }

  sellers.addEventListener("change", () => {
    if (sellers.value === "all") filter.open = true;
    showOptions();
  });
  variants.addEventListener("change", updateOffer);
  search.addEventListener("input", renderFilter);
  update(offers, watch ?? { variantId, allSellers: !variantId });
  return { root, update, selection, focus: () => sellers.focus() };
}
