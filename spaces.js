export function renderSpaces(container, {
  node, button, glyph, t, dateLocale, locale, spaces: initial, open, capture, edit, addLinks, task, remove, removeTab, favorite, openMenu
}) {
  let spaces = initial;
  let selectedId;
  const countFormat = new Intl.NumberFormat(locale);
  const dateFormat = new Intl.DateTimeFormat(dateLocale, { dateStyle: "medium" });

  const action = (key, symbol, onClick, iconOnly = false, preferred = false) => button(
    t(key), iconOnly ? "icon-button spaces-icon-action" : preferred ? "primary-button" : "secondary-button",
    { symbol, iconOnly, onClick }
  );
  const count = space => t("spaceTabCount", { count: countFormat.format(space.tabs.length) });
  const site = tab => new URL(tab.url).hostname.replace(/^www\./iu, "");

  function renderList() {
    const actions = node("div", "spaces-toolbar");
    actions.append(action("spaceSaveWindow", "spaces", () => edit(undefined, "capture"), false, true));
    actions.append(action("spaceNew", "plus", () => edit(), true));
    container.append(actions);

    if (!spaces.length) {
      const empty = node("div", "spaces-empty");
      empty.append(glyph("spaces"), node("p", "", t("spacesEmptyHint")));
      container.append(empty);
      return;
    }

    const collection = node("ul", "spaces-list");
    const ordered = [...spaces].sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt);
    for (const space of ordered) {
      const item = node("li", "spaces-row");
      item.dataset.spaceId = space.id;
      item.dataset.spaceColor = space.color;
      const copy = button("", "spaces-row-main", { onClick: () => show(space.id) });
      copy.id = `space-item-${space.id}`;
      const text = node("span", "spaces-row-copy");
      const name = node("strong", "", space.name);
      name.dir = "auto";
      const meta = node("small", "", `${count(space)} · ${dateFormat.format(space.updatedAt)}`);
      text.append(name, meta);
      copy.replaceChildren(glyph("spaces", "spaces-mark"), text);
      if (space.favorite) copy.append(glyph("pin", "spaces-row-pin"));
      const launch = action("spaceOpenWindow", "open-window", () => open(space, "window"), true);
      launch.disabled = !space.tabs.length;
      item.append(copy, launch);
      collection.append(item);
    }
    container.append(collection);
  }

  function tabRow(tab, space) {
    const item = node("li", "spaces-tab");
    const link = node("a", "spaces-tab-link");
    link.href = tab.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const domain = site(tab);
    const marker = node("span", "spaces-site-mark", domain.slice(0, 2).toUpperCase());
    marker.setAttribute("aria-hidden", "true");
    const text = node("span", "spaces-row-copy");
    const title = node("strong", "", tab.title || domain);
    title.dir = "auto";
    const host = node("small", "", domain);
    host.dir = "ltr";
    text.append(title, host);
    link.append(marker, text);
    if (tab.pinned) {
      const pin = glyph("pin", "spaces-row-pin");
      pin.title = t("spacePinnedTab");
      link.append(pin);
    }
    if (tab.id === space.activeTabId) link.setAttribute("aria-description", t("spaceActiveTab"));
    const removeButton = action("spaceRemoveTab", "close", () => removeTab(space, tab), true);
    removeButton.setAttribute("aria-label", t("spaceRemoveNamedTab", { title: tab.title || domain }));
    item.append(link, removeButton);
    return item;
  }

  function renderTabs(space) {
    const groups = new Map(space.groups.map(group => [group.id, group]));
    let priorGroup;
    let list;
    for (const tab of space.tabs) {
      if (!list || priorGroup !== tab.groupId) {
        priorGroup = tab.groupId;
        const group = groups.get(priorGroup);
        list = node("ul", "spaces-tabs");
        if (group) {
          const section = node("section", "spaces-group");
          section.dataset.groupColor = group.color;
          const label = node("h3", "", group.title || t("spaceTabGroup"));
          section.append(label, list);
          container.append(section);
        } else container.append(list);
      }
      list.append(tabRow(tab, space));
    }
  }

  function renderDetail(space) {
    const controls = node("div", "spaces-toolbar spaces-back-row");
    const back = action("calendarBack", null, () => {
      selectedId = undefined;
      render();
      container.querySelector(`#space-item-${space.id}`)?.focus();
    });
    const menu = action("more", "more", () => openMenu(menu, add => {
      if (space.tabs.some(tab => !tab.pinned)) add("spaceOpenAsGroup", "spaces", () => open(space, "group"));
      add("spaceEdit", "edit", () => edit(space));
      add(space.favorite ? "spaceUnfavorite" : "spaceFavorite", "pin", () => favorite(space));
      add("spaceAppendWindow", "spaces", () => capture("append", space));
      add("spaceReplaceTabs", "refresh", () => capture("replace", space));
      add("spaceAddLinks", "link", () => addLinks(space));
      add("spaceCreateTask", "todo", () => task(space));
      add("spaceDelete", "trash", () => remove(space));
    }), true);
    menu.setAttribute("aria-haspopup", "menu");
    controls.append(back, menu);

    const header = node("section", "spaces-summary");
    header.dataset.spaceColor = space.color;
    const title = node("h3", "spaces-detail-title", space.name);
    title.dir = "auto";
    title.tabIndex = -1;
    header.append(glyph("spaces", "spaces-mark"), title, node("small", "", count(space)));
    if (space.notes) {
      const notes = node("p", "", space.notes);
      notes.dir = "auto";
      header.append(notes);
    }

    const actions = node("div", "spaces-toolbar");
    const launch = action("spaceOpenWindow", "open-window", () => open(space, "window"), false, true);
    const here = action("spaceOpenHere", null, () => open(space, "here"));
    launch.disabled = here.disabled = !space.tabs.length;
    actions.append(launch, here, action("spaceAddCurrentTab", "plus", () => capture("active", space), true));
    container.append(controls, header, actions);
    if (space.tabs.length) renderTabs(space);
    else {
      const empty = node("div", "spaces-empty");
      empty.append(node("p", "", t("spaceNoSavedTabs")), action("spaceAddLinks", "link", () => addLinks(space)));
      container.append(empty);
    }
  }

  function render() {
    container.replaceChildren();
    const selection = spaces.find(space => space.id === selectedId);
    if (selection) renderDetail(selection);
    else renderList();
  }

  function show(id) {
    selectedId = id;
    render();
    container.querySelector(".spaces-detail-title")?.focus({ preventScroll: true });
  }

  render();
  return {
    show,
    update(next) {
      spaces = next;
      render();
    }
  };
}
