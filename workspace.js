import { renderCalendar } from "./calendar.js";
import { icon } from "./icons.js";
import { isRtl, localeNames, translate } from "./locales.js";
import { defaultWorkspace, modules, readWorkspace, storageKey, themes } from "./workspace-data.js";

const view = document.querySelector("#workspace");
const editor = document.querySelector("#editor");
const tabBar = document.querySelector("#module-tabs");
const search = document.querySelector("#search");
const footer = document.querySelector("#workspace-footer");
const toast = document.querySelector("#toast");
const toastMessage = document.querySelector("#toast-message");
const toastAction = document.querySelector("#toast-action");
const panelButton = document.querySelector("#panel-button");
const settingsButton = document.querySelector("#settings-button");
const inPanel = new URLSearchParams(location.search).get("surface") === "panel";

const clipboard = modules[0];
const library = { id: "library", icon: "plus", color: clipboard.color };
const settings = { id: "settings", icon: "settings", color: clipboard.color };
const destinations = [...modules, library, settings];
let workspace = defaultWorkspace;
let activePage = clipboard.id;
let query = "";
let toastTimer;
let copyTimer;
let copiedId;
let currentWindowId;
let inToolbarPopup = false;

document.body.dataset.surface = inPanel ? "panel" : "popup";
panelButton.hidden = inPanel;
if (!inPanel) {
  chrome.windows.getCurrent().then((window) => { currentWindowId = window.id; }).catch(() => {});
  chrome.runtime.getContexts({ contextTypes: ["POPUP"], documentUrls: [location.href] })
    .then((contexts) => { inToolbarPopup = contexts.length > 0; }).catch(() => {});
}

const t = (key, values) => translate(workspace.locale, key, values);

function node(tag, className, label) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (label !== undefined) element.textContent = label;
  return element;
}

function glyph(name, className) {
  const element = node("span", className);
  element.setAttribute("aria-hidden", "true");
  element.innerHTML = icon(name);
  return element;
}

function button(label, className, { symbol, iconOnly = false, onClick } = {}) {
  const element = node("button", className);
  element.type = "button";
  if (symbol) element.append(glyph(symbol));
  if (iconOnly) {
    element.title = label;
    element.setAttribute("aria-label", label);
  } else {
    element.append(node("span", "", label));
  }
  if (onClick) element.addEventListener("click", onClick);
  return element;
}

function labelButton(element, label, symbol) {
  element.replaceChildren(glyph(symbol));
  element.title = label;
  element.setAttribute("aria-label", label);
}

function showToast(message, action, error = false) {
  if (editor.open && error) {
    const feedback = editor.querySelector(".dialog-feedback");
    feedback.hidden = false;
    feedback.textContent = message;
    return;
  }
  clearTimeout(toastTimer);
  toast.hidden = false;
  toast.dataset.kind = error ? "error" : "success";
  toastMessage.textContent = message;
  toastAction.hidden = !action;
  toastAction.onclick = null;
  if (action) {
    toastAction.textContent = t("undo");
    toastAction.onclick = action;
  }
  toastTimer = setTimeout(() => { toast.hidden = true; }, action ? 7000 : 2200);
}

async function mutate(action, data) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "ease-workspace-update", action, data });
    if (!response?.workspace) throw new Error("Workspace update failed");
    return true;
  } catch {
    showToast(t("saveFailed"), undefined, true);
    return false;
  }
}

function switchTo(page, focus = true) {
  activePage = page;
  query = "";
  search.value = "";
  render();
  if (focus) {
    const tab = document.getElementById(`tab-${page}`);
    (tab ?? view).focus();
  }
}

function renderTabs() {
  tabBar.setAttribute("aria-label", t("modulesLabel"));
  tabBar.setAttribute("role", "tablist");
  const tabs = [...modules.filter(({ id }) => workspace.tabs.includes(id)), library];
  tabBar.replaceChildren(...tabs.map((module) => {
    const isSelected = activePage === module.id && !query;
    const isLibrary = module === library;
    const item = button(t(module.id), `module-tab${isLibrary ? " module-tab--library" : ""}`, {
      symbol: module.icon,
      iconOnly: isLibrary,
      onClick: () => switchTo(module.id)
    });
    item.id = `tab-${module.id}`;
    item.dataset.module = module.id;
    item.style.setProperty("--accent", module.color);
    item.setAttribute("role", "tab");
    item.setAttribute("aria-controls", "workspace");
    item.setAttribute("aria-selected", String(isSelected));
    item.tabIndex = isSelected || (!tabs.some(({ id }) => id === activePage && !query) && module === tabs[0]) ? 0 : -1;
    return item;
  }));
}

function section(title, description, action) {
  const header = node("div", "section-header");
  const content = node("div", "section-copy");
  content.append(node("h1", "", title));
  if (description) content.append(node("p", "", description));
  header.append(content);
  if (action) header.append(action);
  view.append(header);
}

function emptyState(title, description, symbol, action) {
  const empty = node("div", "empty-state");
  let illustration = glyph(symbol, "empty-illustration");
  if (symbol === "clipboard") {
    illustration.innerHTML = `<svg aria-hidden="true" viewBox="0 0 100 78" width="100" height="78" fill="none">
      <defs><linearGradient id="paper" x1="25" y1="12" x2="75" y2="72" gradientUnits="userSpaceOnUse"><stop stop-color="#bb99ff" stop-opacity=".33"/><stop offset="1" stop-color="#9367ed" stop-opacity=".05"/></linearGradient></defs>
      <path d="M14 57h8m-4-4v8M80 20h12m-6-6v12M75 69h5m-2.5-2.5v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".6"/>
      <rect x="22" y="21" width="45" height="48" rx="9" transform="rotate(-11 22 21)" stroke="currentColor" opacity=".35"/>
      <rect x="34" y="15" width="43" height="54" rx="9" fill="url(#paper)" stroke="currentColor" stroke-width="1.2"/>
      <rect x="45" y="10" width="21" height="10" rx="4" fill="currentColor" fill-opacity=".3" stroke="currentColor"/>
      <path d="M45 32h21M45 41h21M45 50h13" stroke="currentColor" stroke-linecap="round" stroke-width="1.8"/>
    </svg>`;
  }
  empty.append(illustration, node("h2", "", title), node("p", "", description));
  if (action) empty.append(action);
  view.append(empty);
}

function setFooter() {
  const keyboardHint = activePage === "clipboard" && !query && workspace.snippets.some(({ slot }) => slot);
  const hint = node("small", "footer-hint");
  hint.append(glyph(keyboardHint ? "keyboard" : "device"), node("span", "", t(keyboardHint ? "keyboardHint" : "storageTitle")));
  const shortcut = node("small", "footer-shortcut");
  shortcut.append(node("kbd", "keycap", "/"), node("span", "", t("shortcutHint")));
  footer.replaceChildren(hint, shortcut);
}

const displayTitle = ({ title, text }) => title || text.trim().split(/\r?\n/u)[0];

function pinnedSnippets() {
  return workspace.snippets.filter(({ pinned }) => pinned);
}

function snippetList(title, snippets, { withSlots = false, count = false } = {}) {
  const heading = node("div", "collection-heading");
  heading.append(node("h2", "", title));
  if (count) heading.append(node("small", "", new Intl.NumberFormat(workspace.locale).format(snippets.length)));
  const list = node("ul", "snippet-list");
  snippets.forEach((snippet) => {
    const name = displayTitle(snippet);
    const isCopied = copiedId === snippet.id;
    const row = node("li", `snippet-row${isCopied ? " is-copied" : ""}`);
    const copy = node("button", "snippet-copy");
    copy.id = `snippet-${snippet.id}`;
    copy.type = "button";
    copy.setAttribute("aria-label", t("copySnippet", { name }));
    copy.addEventListener("click", () => prepareCopy(snippet));
    copy.append(glyph(snippet.pinned ? "pin" : "clipboard", "snippet-glyph"));
    const text = node("span", "snippet-text");
    const snippetTitle = node("strong", "", name);
    snippetTitle.dir = "auto";
    text.append(snippetTitle);
    if (snippet.title) {
      const snippetText = node("span", "", snippet.text);
      snippetText.dir = "auto";
      text.append(snippetText);
    }
    copy.append(text);
    if (withSlots && snippet.slot) {
      const slot = node("kbd", "snippet-slot", snippet.slot);
      slot.setAttribute("aria-hidden", "true");
      copy.append(slot);
      copy.setAttribute("aria-keyshortcuts", String(snippet.slot));
      copy.title = t("shortcutKey", { key: snippet.slot });
    }
    copy.append(glyph(isCopied ? "check" : "copy", "row-copy-icon"));
    const details = node("details", "snippet-actions");
    const summary = node("summary", "icon-button");
    summary.id = `actions-${snippet.id}`;
    labelButton(summary, t("more"), "more");
    const menu = node("div", "action-menu");
    function action(key, symbol, handler) {
      const item = button(t(key), "action-item", {
        symbol,
        onClick: () => {
          details.open = false;
          summary.focus();
          handler();
        }
      });
      if (key === "remove") item.dataset.action = "delete";
      return item;
    }
    menu.append(
      action(snippet.pinned ? "unpin" : "pin", "pin", () => mutate("pin-snippet", { id: snippet.id, pinned: !snippet.pinned })),
      action("edit", "edit", () => editSnippet(snippet)),
      action("remove", "trash", () => removeSnippet(snippet))
    );
    details.append(summary, menu);
    row.append(copy, details);
    list.append(row);
  });
  view.append(heading, list);
}

function renderClipboard() {
  const add = (className) => {
    const action = button(t("newSnippet"), className, { symbol: "plus", onClick: () => editSnippet() });
    action.id = "new-snippet";
    return action;
  };
  const hasSnippets = workspace.snippets.length > 0;
  section(t("clipboard"), t("clipboardHint"), hasSnippets ? add("primary-button") : undefined);
  if (!hasSnippets) {
    emptyState(t("emptyTitle"), t("emptyHint"), "clipboard", add("secondary-button"));
    return;
  }
  const pinned = pinnedSnippets().sort((left, right) => (left.slot ?? 10) - (right.slot ?? 10));
  const others = workspace.snippets.filter(({ pinned }) => !pinned);
  if (pinned.length) snippetList(t("pinned"), pinned, { withSlots: true, count: true });
  if (others.length) snippetList(t("snippets"), others, { count: true });
}

function renderLibrary() {
  section(t("library"), t("libraryHint"));
  const list = node("ul", "catalog-list");
  for (const module of modules) {
    const item = node("li", "catalog-item");
    item.dataset.module = module.id;
    item.style.setProperty("--accent", module.color);
    const copy = node("div", "catalog-copy");
    copy.append(node("strong", "", t(module.id)), node("p", "", t(`${module.id}Hint`)));
    item.append(glyph(module.icon, "module-glyph"), copy);
    if (module.released && module !== clipboard) {
      const enabled = workspace.tabs.includes(module.id);
      const toggle = button(t(enabled ? "hide" : "add"), "secondary-button", {
        symbol: enabled ? undefined : "plus",
        onClick: async () => {
          toggle.disabled = true;
          if (await mutate("toggle-module", { id: module.id, enabled: !enabled })) {
            showToast(t(enabled ? "moduleHidden" : "moduleAdded", { name: t(module.id) }));
          } else {
            toggle.disabled = false;
          }
        }
      });
      toggle.id = `toggle-${module.id}`;
      toggle.setAttribute("aria-label", `${t(enabled ? "hide" : "add")} ${t(module.id)}`);
      item.append(toggle);
    } else {
      item.append(node("span", "status-tag", t(module.released ? "available" : "comingSoon")));
    }
    list.append(item);
  }
  view.append(list);
}

function renderSettings() {
  section(t("settings"));
  const list = node("div", "settings-list");
  function preference(key, choices) {
    const row = node("div", "setting-row");
    const label = node("label", "", t(key === "locale" ? "language" : "appearance"));
    label.htmlFor = `setting-${key}`;
    const select = node("select");
    select.id = label.htmlFor;
    for (const [value, text] of choices) {
      const option = node("option", "", text);
      option.value = value;
      if (key === "locale") {
        option.lang = value;
        option.dir = isRtl(value) ? "rtl" : "ltr";
      }
      select.append(option);
    }
    select.value = workspace[key];
    select.addEventListener("change", async () => {
      if (!await mutate("preferences", { [key]: select.value })) select.value = workspace[key];
    });
    row.append(label, select);
    list.append(row);
  }
  preference("locale", Object.entries(localeNames));
  preference("theme", themes.map((theme) => [theme, t(theme)]));
  const storage = node("div", "setting-row storage-note");
  const copy = node("div");
  copy.append(node("strong", "", t("storageTitle")), node("p", "", t("storageHint")));
  storage.append(glyph("device", "module-glyph"), copy);
  list.append(storage);
  view.append(list);
}

function searchable(text) {
  return text.toLocaleLowerCase(workspace.locale).normalize("NFD").replace(/\p{Mark}/gu, "")
    .replace(/ي/gu, "ی").replace(/ك/gu, "ک").replace(/\u200c/gu, " ");
}

function renderSearch() {
  section(t("searchResults"));
  const searchText = searchable(query);
  const matches = (text) => searchable(text).includes(searchText);
  const snippets = workspace.snippets.filter(({ title, text }) => matches(`${title} ${text}`));
  const commands = destinations.filter((page) => (page === library || page === settings || workspace.tabs.includes(page.id))
    && matches(`${t(page.id)} ${translate("en", page.id)}`));
  const newSnippet = matches(`${t("newSnippet")} ${translate("en", "newSnippet")}`);
  if (!snippets.length && !commands.length && !newSnippet) {
    emptyState(t("emptySearch"), t("emptySearchHint"), "search");
    return;
  }
  if (snippets.length) snippetList(t("snippets"), snippets, { count: true });
  if (commands.length || newSnippet) {
    const heading = node("div", "collection-heading");
    heading.append(node("h2", "", t("commands")));
    const list = node("div", "command-list");
    for (const page of commands) {
      list.append(button(t(page.id), "command-item", { symbol: page.icon, onClick: () => switchTo(page.id) }));
    }
    if (newSnippet) {
      list.append(button(t("newSnippet"), "command-item", {
        symbol: "plus",
        onClick: () => {
          switchTo("clipboard", false);
          editSnippet();
        }
      }));
    }
    view.append(heading, list);
  }
}

function render() {
  const focused = document.activeElement?.id;
  document.documentElement.lang = workspace.locale;
  document.documentElement.dir = isRtl(workspace.locale) ? "rtl" : "ltr";
  document.documentElement.dataset.theme = workspace.theme;
  document.querySelector("#workspace-label").textContent = t("localWorkspace");
  search.placeholder = t("searchPlaceholder");
  search.setAttribute("aria-label", t("searchLabel"));
  labelButton(panelButton, t("openPanel"), "panel");
  labelButton(settingsButton, t("settings"), "settings");
  settingsButton.setAttribute("aria-pressed", String(activePage === "settings" && !query));
  if (![library.id, settings.id, ...workspace.tabs].includes(activePage)) activePage = clipboard.id;
  const destination = destinations.find(({ id }) => id === activePage);
  document.documentElement.style.setProperty("--module-accent", destination.color);
  renderTabs();
  view.replaceChildren();
  if (query || activePage === "settings") {
    view.removeAttribute("role");
    view.removeAttribute("aria-labelledby");
  } else {
    view.setAttribute("role", "tabpanel");
    view.setAttribute("aria-labelledby", `tab-${activePage}`);
  }
  if (query) renderSearch();
  else if (activePage === "clipboard") renderClipboard();
  else if (activePage === "calendar") {
    section(t("calendar"), t("calendarHint"));
    const calendarBody = node("div");
    view.append(calendarBody);
    renderCalendar(calendarBody, { locale: workspace.locale, t, icon });
  } else if (activePage === "library") renderLibrary();
  else if (activePage === "settings") renderSettings();

  setFooter();
  if (focused && focused !== "workspace" && !editor.open) {
    const element = document.getElementById(focused);
    if (element !== document.activeElement) element?.focus({ preventScroll: true });
  }
}

function openEditor(title, submitLabel, onSubmit) {
  const opener = document.activeElement?.id;
  editor.addEventListener("close", () => {
    if (opener) document.getElementById(opener)?.focus();
  }, { once: true });
  const form = node("form");
  const heading = node("div", "dialog-heading");
  const headingText = node("h2", "", title);
  headingText.id = "editor-title";
  heading.append(headingText, button(t("close"), "icon-button", {
    symbol: "close",
    iconOnly: true,
    onClick: () => editor.close()
  }));
  const fields = node("div", "dialog-fields");
  const feedback = node("p", "dialog-feedback");
  feedback.setAttribute("role", "alert");
  feedback.hidden = true;
  const buttons = node("div", "dialog-footer");
  const submit = button(submitLabel, "primary-button");
  submit.type = "submit";
  buttons.append(button(t("cancel"), "secondary-button", { onClick: () => editor.close() }), submit);
  form.append(heading, fields, feedback, buttons);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.hidden = true;
    try {
      if (await onSubmit()) editor.close();
    } finally {
      submit.disabled = false;
    }
  });
  editor.setAttribute("aria-labelledby", headingText.id);
  editor.replaceChildren(form);
  return fields;
}

function field(container, { label, value = "", placeholder, multiline = false, maxLength, required = false }) {
  const wrapper = node("label", "field");
  const input = node(multiline ? "textarea" : "input");
  input.dir = "auto";
  input.value = value;
  input.required = required;
  if (maxLength) input.maxLength = maxLength;
  if (placeholder) input.placeholder = placeholder;
  if (multiline) input.rows = 5;
  wrapper.append(node("span", "", label), input);
  container.append(wrapper);
  return input;
}

function editSnippet(snippet) {
  const fields = openEditor(t(snippet ? "editSnippet" : "newSnippet"), t("save"), async () => {
    if (!text.value.trim()) {
      text.value = "";
      text.reportValidity();
      return false;
    }
    return mutate("save-snippet", { id: snippet?.id, title: title.value, text: text.value });
  });
  const title = field(fields, { label: `${t("snippetTitle")} (${t("optional")})`, value: snippet?.title, placeholder: t("snippetTitlePlaceholder"), maxLength: 100 });
  const text = field(fields, { label: t("snippetText"), value: snippet?.text, placeholder: t("snippetTextPlaceholder"), required: true, maxLength: 20000, multiline: true });
  fields.append(node("p", "field-hint", t("templateTip")));
  editor.showModal();
  text.focus();
}

const templatePattern = /(?<!\{)\{([\p{L}_][\p{L}\p{M}\p{N}\u200c_ -]{0,39})\}(?!\})/gu;

function templateFields(text) {
  return [...new Set(Array.from(text.matchAll(templatePattern), ([, name]) => name.trim()).filter(Boolean))];
}

function prepareCopy(snippet) {
  const names = templateFields(snippet.text);
  if (!names.length) {
    copySnippet(snippet, snippet.text);
    return;
  }
  const fields = openEditor(t("templateTitle"), t("copy"), () => {
    const text = snippet.text.replace(templatePattern, (match, name) => values.get(name.trim())?.value ?? match);
    return copySnippet(snippet, text);
  });
  fields.append(node("p", "field-hint", t("templateHint")));
  const values = new Map(names.map((name) => [name, field(fields, { label: name, required: true })]));
  editor.showModal();
  values.values().next().value.focus();
}

async function copySnippet(snippet, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    showToast(t("copyFailed"), undefined, true);
    return false;
  }
  copiedId = snippet.id;
  render();
  showToast(t("copied"));
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    if (inToolbarPopup) window.close();
    copiedId = undefined;
    for (const row of view.querySelectorAll(".is-copied")) row.classList.remove("is-copied");
    const rowIcon = document.getElementById(`snippet-${snippet.id}`)?.querySelector(".row-copy-icon");
    if (rowIcon) rowIcon.innerHTML = icon("copy");
  }, inToolbarPopup ? 420 : 1800);
  return true;
}

async function removeSnippet(snippet) {
  const index = workspace.snippets.findIndex(({ id }) => id === snippet.id);
  if (await mutate("delete-snippet", { id: snippet.id })) {
    showToast(t("deleted"), async () => {
      if (await mutate("restore-snippet", { snippet, index })) toast.hidden = true;
    });
  }
}

document.querySelector(".search-icon").innerHTML = icon("search");
settingsButton.addEventListener("click", () => switchTo(activePage === "settings" && !query ? "clipboard" : "settings", false));
panelButton.addEventListener("click", async () => {
  if (currentWindowId === undefined) {
    showToast(t("panelFailed"), undefined, true);
    return;
  }
  try {
    await chrome.sidePanel.open({ windowId: currentWindowId });
    window.close();
  } catch {
    showToast(t("panelFailed"), undefined, true);
  }
});

search.addEventListener("input", () => {
  query = search.value.trim();
  render();
});

tabBar.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const allTabs = [...tabBar.querySelectorAll("button")];
  const index = allTabs.indexOf(document.activeElement);
  const direction = isRtl(workspace.locale) ? -1 : 1;
  const next = {
    ArrowLeft: (index - direction + allTabs.length) % allTabs.length,
    ArrowRight: (index + direction + allTabs.length) % allTabs.length,
    Home: 0,
    End: allTabs.length - 1
  }[event.key];
  event.preventDefault();
  switchTo(allTabs[next].dataset.module);
});

document.addEventListener("click", (event) => {
  for (const menu of view.querySelectorAll(".snippet-actions[open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});

document.addEventListener("keydown", (event) => {
  if (editor.open || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
  const openMenu = view.querySelector(".snippet-actions[open]");
  if (event.key === "Escape" && openMenu) {
    openMenu.open = false;
    openMenu.querySelector("summary").focus();
    return;
  }
  if (event.key === "Escape" && query) {
    event.preventDefault();
    switchTo(activePage);
    return;
  }
  const results = query ? [...view.querySelectorAll(".snippet-copy, .command-item")] : [];
  if (results.length && document.activeElement === search && ["Enter", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    if (event.key === "Enter") results[0].click();
    else results[0].focus();
    return;
  }
  if (results.includes(document.activeElement) && ["ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    const offset = event.key === "ArrowUp" ? -1 : 1;
    (results[results.indexOf(document.activeElement) + offset] ?? search).focus();
    return;
  }
  if (event.target.closest("input, textarea, select, [contenteditable]") || openMenu) return;
  if (event.key === "/") {
    event.preventDefault();
    search.focus();
  } else if (activePage === "clipboard" && !query && /^[1-9١-٩۱-۹]$/u.test(event.key) && !event.repeat) {
    const digit = event.key.codePointAt(0) & 0xf;
    const snippet = pinnedSnippets().find(({ slot }) => slot === digit);
    if (snippet) {
      event.preventDefault();
      prepareCopy(snippet);
    }
  }
});

try {
  workspace = await readWorkspace();
} catch {
  showToast(t("saveFailed"), undefined, true);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[storageKey]) {
    workspace = { ...defaultWorkspace, ...changes[storageKey].newValue };
    render();
  }
});
render();
