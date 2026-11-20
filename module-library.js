const layouts = {
  grid: "moduleLibraryGrid",
  list: "moduleLibraryList"
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderModuleLibrary(container, { t, icon, modules, tabs, layout, onLayout, onToggle }) {
  const selectedLayout = layout === "grid" ? "grid" : "list";
  const controls = element("div", "module-library-layout");
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", t("moduleLibraryLayout"));
  let changingLayout = false;
  for (const [mode, key] of Object.entries(layouts)) {
    const button = element("button", "icon-button module-library-layout-button");
    button.type = "button";
    button.id = `module-library-${mode}`;
    button.innerHTML = icon(mode);
    button.title = t(key);
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(mode === selectedLayout));
    button.addEventListener("click", async () => {
      if (mode === selectedLayout || changingLayout) return;
      changingLayout = true;
      try {
        await onLayout(mode);
      } finally {
        changingLayout = false;
      }
    });
    controls.append(button);
  }

  const list = element("ul", "catalog-list");
  list.dataset.layout = selectedLayout;
  for (const module of modules) {
    const core = module.id === "clipboard";
    const active = core || tabs.includes(module.id);
    const item = element("li", "catalog-item");
    item.dataset.module = module.id;
    item.dataset.active = String(active);
    const mark = element("span", "catalog-mark");
    mark.setAttribute("aria-hidden", "true");
    const glyph = element("span", "module-glyph");
    glyph.innerHTML = icon(module.icon);
    mark.append(glyph);
    if (active) {
      const indicator = element("span", "catalog-active-mark");
      indicator.innerHTML = icon("check");
      mark.append(indicator);
    }
    const name = t(module.id);
    const copy = element("div", "catalog-copy");
    copy.append(element("strong", "", name), element("p", "", t(`${module.id}Hint`)));
    item.append(mark, copy);

    if (module.released && !core) {
      const action = t(active ? "hide" : "add");
      const toggle = element("button", "secondary-button catalog-toggle");
      toggle.type = "button";
      toggle.id = `toggle-${module.id}`;
      toggle.setAttribute("aria-label", `${action} ${name}`);
      if (!active) toggle.innerHTML = icon("plus");
      toggle.append(element("span", "", action));
      toggle.addEventListener("click", async () => {
        if (toggle.getAttribute("aria-disabled") === "true") return;
        toggle.setAttribute("aria-disabled", "true");
        try {
          await onToggle(module.id);
        } finally {
          toggle.removeAttribute("aria-disabled");
        }
      });
      item.append(toggle);
    } else {
      item.append(element("span", "status-tag", t(module.released ? "available" : "comingSoon")));
    }
    list.append(item);
  }
  container.append(controls, list);
  return controls;
}
